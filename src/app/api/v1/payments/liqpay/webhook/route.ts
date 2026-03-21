import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { InputJsonValue } from "@/generated/prisma/internal/prismaNamespace";
import { liqpayDecodeData, liqpayVerifySignature } from "@/services/liqpay.service";
import { ExpoPushService } from "@/services/expoPush.service";
import { publishDomainEvent } from "@/realtime/publishDomainEvent";

function parseBody(contentType: string | null, raw: string) {
  if (contentType && contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    return {
      data: params.get("data") ?? "",
      signature: params.get("signature") ?? "",
    };
  }

  try {
    const json = JSON.parse(raw) as { data?: unknown; signature?: unknown };
    return {
      data: typeof json.data === "string" ? json.data : "",
      signature: typeof json.signature === "string" ? json.signature : "",
    };
  } catch {
    return { data: "", signature: "" };
  }
}

function mapLiqPayStatus(status: unknown) {
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

export async function POST(req: Request) {
  try {
    const requestId = getRequestId(req);
    const raw = await req.text();
    const { data, signature } = parseBody(req.headers.get("content-type"), raw);

    if (!data || !signature) throw new ApiError(400, "VALIDATION_ERROR", "Missing data/signature");
    const okSig = liqpayVerifySignature(data, signature);
    if (!okSig) throw new ApiError(401, "UNAUTHORIZED", "Invalid provider signature");

    const decoded = liqpayDecodeData(data);
    const providerIntentId = String(decoded.order_id || "");
    if (!providerIntentId) throw new ApiError(400, "VALIDATION_ERROR", "Missing order_id");

    const payment = await prisma.payment.findFirst({
      where: { provider: "liqpay", providerIntentId },
      select: { id: true, status: true, amount: true, currency: true, orderId: true, userId: true, providerIntentId: true },
    });

    if (!payment) {
      return ok(req, { received: true, ignored: true }, { message: "Ignored" });
    }

    const nextStatus = mapLiqPayStatus(decoded.status);

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: nextStatus,
        paidAt: nextStatus === "succeeded" ? new Date() : null,
        raw: { webhook: { data, signature }, liqpay: decoded } as unknown as InputJsonValue,
      },
      select: { id: true, status: true, amount: true, currency: true, paidAt: true, orderId: true, userId: true },
    });

    if (updated.status === "succeeded") {
      const [order, dbUser] = await prisma.$transaction([
        prisma.order.findUnique({ where: { id: updated.orderId }, select: { id: true, status: true, customerUserId: true, performerUserId: true, budget: true } }),
        prisma.user.findUnique({ where: { id: updated.userId }, select: { role: true } }),
      ]);

      if (order && dbUser) {
        const role: "performer" | "customer" = dbUser.role === "performer" ? "performer" : "customer";
        const providerRef = String(
          (decoded as Record<string, unknown>).payment_id ||
            (decoded as Record<string, unknown>).transaction_id ||
            (decoded as Record<string, unknown>).liqpay_order_id ||
            payment.providerIntentId
        );

        await prisma.escrowLock.upsert({
          where: { uniq_order_role_lock: { orderId: order.id, role } },
          update: { status: "locked" },
          create: {
            orderId: order.id,
            userId: updated.userId,
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
          
          // Створюємо запис в notifications з типом "deposit"
          await prisma.notification.create({
            data: {
              userId: order.customerUserId,
              type: "deposit",
              title: "Виконавець вніс гарантійну суму",
              message: `Замовлення #${order.id.slice(-6)}. У вас є 12 годин для внесення гарантійної суми (${depositAmount} ${updated.currency})`,
              data: {
                orderId: order.id,
                type: "deposit_performer_paid",
                role: "customer",
                depositAmount: depositAmount,
                currency: updated.currency,
                deadlineHours: 12,
              } as unknown as InputJsonValue,
            },
          });
          
          for (const device of customerDevices) {
            await expo.sendPush({
              toUserId: order.customerUserId,
              toExpoToken: device.expoPushToken,
              title: "Виконавець вніс гарантійну суму",
              body: `Замовлення #${order.id.slice(-6)}. У вас є 12 годин для внесення гарантійної суми (${depositAmount} ${updated.currency})`,
              data: {
                orderId: order.id,
                type: "deposit_performer_paid",
                role: "customer",
                depositAmount: depositAmount,
                currency: updated.currency,
                deadlineHours: 12,
              },
            });
          }

          // WebSocket сигнал заказчику
          if (process.env.NODE_ENV !== "production") {
            console.log(
              "\n🔔 [Webhook] Відправка WebSocket deposit.performer_paid:",
              `\n   OrderId: ${order.id}`,
              `\n   CustomerUserId: ${order.customerUserId}`,
              `\n   DepositAmount: ${depositAmount} ${updated.currency}`,
              `\n   DeadlineHours: 12\n`
            );
          }
          
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

            // Створюємо запис в notifications з типом "deposit"
            await prisma.notification.create({
              data: {
                userId: order.performerUserId,
                type: "deposit",
                title: "Заказчик вніс гарантійну суму",
                message: `Замовлення #${order.id.slice(-6)}. Заказчик підтвердив оплату. Можна починати роботу.`,
                data: {
                  orderId: order.id,
                  type: "deposit_customer_paid",
                  role: "performer",
                } as unknown as InputJsonValue,
              },
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
            if (process.env.NODE_ENV !== "production") {
              console.log(
                "\n🔔 [Webhook] Відправка WebSocket deposit.customer_required:",
                `\n   OrderId: ${order.id}`,
                `\n   PerformerUserId: ${order.performerUserId}`,
                `\n   CustomerUserId: ${order.customerUserId}\n`
              );
            }
            
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
          const [customerLock, performerLock] = await prisma.$transaction([
            prisma.escrowLock.findFirst({ where: { orderId: order.id, role: "customer", status: "locked" } }),
            prisma.escrowLock.findFirst({ where: { orderId: order.id, role: "performer", status: "locked" } }),
          ]);
          if (customerLock && performerLock) {
            await prisma.$transaction([
              prisma.order.updateMany({ where: { id: order.id, status: { in: ["accepted", "requires_confirmation"] } }, data: { status: "confirmed" } }),
              prisma.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: "confirmed", note: null } }),
              prisma.orderMatch.deleteMany({ where: { orderId: order.id } }),
            ]);

            // WebSocket сигнал обом сторонам про підтвердження
            if (process.env.NODE_ENV !== "production") {
              console.log(
                "\n🔔 [Webhook] Відправка WebSocket order.status_changed:",
                `\n   OrderId: ${order.id}`,
                `\n   FromStatus: ${order.status}`,
                `\n   ToStatus: confirmed`,
                `\n   Targets: [${order.customerUserId}, ${order.performerUserId}]\n`
              );
            }
            
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

    return ok(req, { received: true, payment: { id: updated.id, status: updated.status } }, { message: "OK" });
  } catch (err) {
    return fail(req, err);
  }
}

