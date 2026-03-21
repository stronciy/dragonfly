import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import type { InputJsonValue } from "@/generated/prisma/internal/prismaNamespace";
import { liqpayDecodeData, liqpayVerifySignature } from "@/services/liqpay.service";
import { ExpoPushService } from "@/services/expoPush.service";
import { publishDomainEvent } from "@/realtime/publishDomainEvent";

const schema = z.object({
  providerPayload: z.object({
    provider: z.enum(["liqpay"]),
    data: z.string().min(1),
    signature: z.string().min(1),
  }),
});

function mapLiqPayStatus(status: string) {
  const s = String(status || "").toLowerCase();
  if (s === "success" || s === "sandbox") return "succeeded";
  if (
    s === "processing" ||
    s === "wait_accept" ||
    s === "wait_secure" ||
    s === "wait_sender" ||
    s === "wait_card" ||
    s === "wait_lc"
  ) {
    return "processing";
  }
  if (s === "reversed" || s === "canceled") return "canceled";
  if (s === "failure" || s === "error" || s === "expired") return "failed";
  return "requires_action";
}

export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { paymentIntentId } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => ({})));

    const payment = await prisma.payment.findUnique({ where: { id: paymentIntentId } });
    if (!payment || payment.userId !== user.id) throw new ApiError(404, "NOT_FOUND", "Payment not found");
    if (payment.provider !== body.providerPayload.provider) throw new ApiError(409, "CONFLICT", "Payment provider mismatch");
    const { data, signature } = body.providerPayload;
    const okSig = liqpayVerifySignature(data, signature);
    if (!okSig) throw new ApiError(401, "UNAUTHORIZED", "Invalid provider signature");

    const decoded = liqpayDecodeData(data);
    const orderId = String(decoded.order_id || "");
    if (!orderId || orderId !== payment.providerIntentId) throw new ApiError(409, "CONFLICT", "Payment intent mismatch");

    const liqpayStatus = String(decoded.status || "");
    const nextStatus = mapLiqPayStatus(liqpayStatus);

    const updated = await prisma.payment.update({
      where: { id: paymentIntentId },
      data: {
        status: nextStatus,
        paidAt: nextStatus === "succeeded" ? new Date() : null,
        raw: { providerPayload: body.providerPayload, liqpay: decoded } as unknown as InputJsonValue,
      },
      select: { id: true, status: true, amount: true, currency: true, paidAt: true, orderId: true },
    });

    const response: {
      payment: { id: string; status: string; amount: number; currency: string; paidAt: Date | null };
      order?: { id: string; status: string };
    } = {
      payment: {
        id: updated.id,
        status: updated.status,
        amount: Number(updated.amount),
        currency: updated.currency,
        paidAt: updated.paidAt,
      },
    };

    if (updated.status === "succeeded") {
      const [order, dbUser] = await prisma.$transaction([
        prisma.order.findUnique({ where: { id: updated.orderId }, select: { id: true, status: true, customerUserId: true, performerUserId: true, budget: true } }),
        prisma.user.findUnique({ where: { id: user.id }, select: { role: true } }),
      ]);

      if (order && dbUser) {
        const role: "performer" | "customer" = dbUser.role === "performer" ? "performer" : "customer";
        const providerRef = String((decoded as Record<string, unknown>).payment_id || (decoded as Record<string, unknown>).transaction_id || payment.providerIntentId);
        await prisma.escrowLock.upsert({
          where: { uniq_order_role_lock: { orderId: order.id, role } },
          update: { status: "locked" },
          create: {
            orderId: order.id,
            userId: user.id,
            role,
            status: "locked",
            amount: updated.amount,
            currency: updated.currency,
            provider: "liqpay",
            providerRef,
          },
        });

        // Відправити Push та WebSocket сповіщення з урахуванням ролей
        const expo = new ExpoPushService(prisma);
        
        if (role === "performer") {
          // Виконавець оплатив - відправити Push заказчику
          const customerDevices = await prisma.device.findMany({
            where: { userId: order.customerUserId, revokedAt: null },
            select: { expoPushToken: true },
          });

          const depositAmount = Number(order.budget) * 0.1;
          
          for (const device of customerDevices) {
            await expo.sendPush({
              toUserId: order.customerUserId,
              toExpoToken: device.expoPushToken,
              title: "Виконавець вніс гарантійну суму",
              body: `Замовлення #${order.id.slice(-6)}. У вас є 12 годин для внесення гарантійної суми (${depositAmount} ${updated.currency})`,
              data: {
                orderId: order.id,
                type: "deposit_customer_required",
                role: "customer",
                depositAmount: depositAmount,
                currency: updated.currency,
                deadlineHours: 12,
              },
            });
          }

          // WebSocket сигнал заказчику
          await publishDomainEvent({
            type: "deposit.performer_paid",
            requestId,
            targets: { userIds: [order.customerUserId] },
            data: { 
              orderId: order.id, 
              performerId: order.performerUserId,
              depositAmount,
              currency: updated.currency,
              deadlineHours: 12,
            },
          });
        } else if (role === "customer") {
          // Заказчик оплатив - відправити Push виконавцю
          if (order.performerUserId) {
            const performerDevices = await prisma.device.findMany({
              where: { userId: order.performerUserId, revokedAt: null },
              select: { expoPushToken: true },
            });

            for (const device of performerDevices) {
              await expo.sendPush({
                toUserId: order.performerUserId,
                toExpoToken: device.expoPushToken,
                title: "Заказчик вніс гарантійну суму",
                body: `Замовлення #${order.id.slice(-6)}. Заказчик підтвердив оплату. Можна починати роботу.`,
                data: {
                  orderId: order.id,
                  type: "deposit_customer_paid",
                  role: "performer",
                },
              });
            }

            // WebSocket сигнал виконавцю
            await publishDomainEvent({
              type: "deposit.customer_required",
              requestId,
              targets: { userIds: [order.performerUserId] },
              data: {
                orderId: order.id,
                customerId: order.customerUserId,
              },
            });
          }
        }

        if (order.status === "accepted" || order.status === "requires_confirmation") {
          const customerLock = await prisma.escrowLock.findFirst({ where: { orderId: order.id, role: "customer", status: "locked" } });
          const performerLock = await prisma.escrowLock.findFirst({ where: { orderId: order.id, role: "performer", status: "locked" } });
          if (customerLock && performerLock) {
            await prisma.$transaction([
              prisma.order.update({ where: { id: order.id }, data: { status: "confirmed" } }),
              prisma.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: "confirmed", note: null } }),
              prisma.orderMatch.deleteMany({ where: { orderId: order.id } }),
            ]);
            response.order = { id: order.id, status: "confirmed" };

            // WebSocket сигнал обом сторонам про підтвердження
            await publishDomainEvent({
              type: "order.status_changed",
              requestId,
              targets: { userIds: [order.customerUserId, order.performerUserId!] },
              data: { orderId: order.id, fromStatus: order.status, toStatus: "confirmed" },
            });
          }
        }
      }
    }

    return ok(req, response, { message: "Confirmed" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
