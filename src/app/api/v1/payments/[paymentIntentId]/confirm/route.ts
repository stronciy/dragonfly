import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { publishDomainEvent } from "@/shared";
import { confirmDeposit } from "@/shared";
import { notifyUser } from "@/shared";

const schema = z.object({
  providerPayload: z.object({
    provider: z.literal("liqpay"),
    data: z.string().min(1),
    signature: z.string().min(1),
  }),
});

export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { paymentIntentId } = await ctx.params;
    const body = schema.parse(await req.json());

    const pre = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { order: { select: { id: true, customerUserId: true, performerUserId: true } } },
    });
    if (!pre) throw new ApiError(404, "NOT_FOUND", "Payment intent not found");
    const allowed =
      (pre.role === "customer" && pre.order.customerUserId === user.id) ||
      (pre.role === "performer" && pre.order.performerUserId === user.id);
    if (!allowed) throw new ApiError(404, "NOT_FOUND", "Payment intent not found");

    const { order, intent, duplicate } = await prisma.$transaction((tx) =>
      confirmDeposit(tx, {
        paymentIntentId,
        data: body.providerPayload.data,
        signature: body.providerPayload.signature,
      })
    );

    if (!duplicate) {
      if (intent.role === "performer") {
        const targets = { userIds: [order.customerUserId, order.performerUserId!].filter(Boolean) as string[] };
        await publishDomainEvent({
          type: "deposit.performer_paid",
          requestId,
          targets,
          data: { orderId: order.id, status: order.status },
        });
        await publishDomainEvent({
          type: "escrow.changed",
          requestId,
          targets,
          data: { orderId: order.id, role: "performer", status: order.status },
        });
        await publishDomainEvent({
          type: "order.status_changed",
          requestId,
          targets,
          data: { orderId: order.id, fromStatus: "accepted", toStatus: order.status },
        });
        await publishDomainEvent({
          type: "deposit.customer_required",
          requestId,
          targets: { userIds: [order.customerUserId] },
          data: { orderId: order.id, status: order.status },
        });
        await publishDomainEvent({
          type: "payment:required",
          requestId,
          targets: { userIds: [order.customerUserId] },
          data: { orderId: order.id, status: order.status },
        });
        await notifyUser({
          userId: order.customerUserId,
          type: "deposit",
          title: "Виконавець вніс гарантійну суму",
          message: `Замовлення #${order.id.slice(-6)}. Внесіть свою гарантійну суму протягом 12 годин.`,
          data: { orderId: order.id, type: "deposit_customer_required", role: "customer" },
        });
      } else {
        const targets = { userIds: [order.customerUserId, order.performerUserId!].filter(Boolean) as string[] };
        await publishDomainEvent({
          type: "deposit.customer_paid",
          requestId,
          targets,
          data: { orderId: order.id, status: order.status },
        });
        await publishDomainEvent({
          type: "escrow.changed",
          requestId,
          targets,
          data: { orderId: order.id, role: "customer", status: order.status },
        });
        await publishDomainEvent({
          type: "order.status_changed",
          requestId,
          targets,
          data: {
            orderId: order.id,
            fromStatus: "requires_confirmation",
            toStatus: order.status,
          },
        });
        await publishDomainEvent({
          type: "order.confirmed",
          requestId,
          targets,
          data: { orderId: order.id },
        });
        await publishDomainEvent({
          type: "order:confirmed",
          requestId,
          targets,
          data: { orderId: order.id },
        });
        if (order.performerUserId) {
          await notifyUser({
            userId: order.performerUserId,
            type: "deposit",
            title: "Замовник вніс гарантійну суму",
            message: `Замовлення #${order.id.slice(-6)} підтверджено. Можна починати роботу.`,
            data: { orderId: order.id, type: "order_confirmed", role: "performer" },
          });
        }
      }
    }

    return ok(req, {
      order: { id: order.id, status: order.status },
      paymentIntent: { id: intent.id, status: intent.status },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
