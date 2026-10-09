import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { ExpoPushService } from "@/shared";
import { releaseEscrowForOrder, settleProviderHolds, emitEscrowChanged } from "@/shared";
import { recomputePerformerRating } from "@/shared";
import { Prisma } from "@prisma/client";

const schema = z.object({
  accepted: z.boolean(),
  comment: z.string().max(1000).optional(),
  rating: z.number().min(1).max(5).optional(),
  fine: z.boolean().optional(),
});

/**
 * POST /api/v1/orders/:orderId/confirm-completion
 * 
 * Заказчик підтверджує або відхиляє завершення роботи виконавцем
 * 
 * Якщо accepted=true:
 * - Статус залишається completed
 * - Створюється Review (якщо є rating)
 * - Замовлення переходить в архів (closed)
 * - Відправляється Push виконавцю
 * 
 * Якщо accepted=false:
 * - Статус змінюється на arbitration
 * - Відправляється Push виконавцю
 */
export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Order not found");
    if (order.status !== "completed") throw new ApiError(409, "CONFLICT", "Order is not completed yet");
    
    // Перевірка чи вже не було підтвердження завершення
    // Перевіряємо чи вже є review від цього заказчикa
    const existingReview = await prisma.review.findFirst({
      where: {
        orderId,
        authorUserId: user.id,
      },
    });
    
    if (existingReview) {
      throw new ApiError(409, "CONFLICT", "Order completion already confirmed");
    }

    const resolvedArbitration = await prisma.arbitrationResolution.findFirst({
      where: { orderId, status: "approved" },
      select: { id: true },
    });
    if (resolvedArbitration) {
      throw new ApiError(409, "CONFLICT", "Order was already closed via arbitration");
    }

    const expo = new ExpoPushService(prisma);

    if (body.accepted) {
      // Заказчик підтверджує завершення
      await prisma.$transaction(async (tx) => {
        // Створюємо Review якщо є рейтинг
        if (body.rating && order.performerUserId) {
          await tx.review.create({
            data: {
              orderId,
              performerUserId: order.performerUserId,
              authorUserId: user.id,
              rating: body.rating,
              text: body.comment ?? null,
            },
          });
        }

        if (body.fine && order.performerUserId) {
          await releaseEscrowForOrder(tx, { orderId, role: "performer", to: "forfeited" });
          await releaseEscrowForOrder(tx, { orderId, role: "customer", to: "released" });
        } else {
          await releaseEscrowForOrder(tx, { orderId, to: "released" });
        }
      });

      if (order.performerUserId) await recomputePerformerRating(order.performerUserId).catch(() => {});

      if (body.fine && order.performerUserId) {
        await settleProviderHolds({ orderId, role: "performer", to: "forfeited" }).catch(() => {});
        await settleProviderHolds({ orderId, role: "customer", to: "released" }).catch(() => {});
      } else {
        await settleProviderHolds({ orderId, to: "released" }).catch(() => {});
      }

      await emitEscrowChanged({
        requestId,
        orderId,
        customerUserId: order.customerUserId,
        performerUserId: order.performerUserId,
        roles: ["performer", "customer"],
        orderStatus: "completed",
      });

      // Створюємо notification
      await prisma.notification.create({
        data: {
          userId: order.customerUserId,
          type: "order",
          title: "Замовлення завершено",
          message: `Замовлення #${orderId.slice(-6)} успішно завершено та переміщено в архів.`,
          data: {
            orderId,
            type: "order_confirmed_completed",
            role: "customer",
            accepted: true,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      // Відправляємо Push виконавцю
      if (order.performerUserId) {
        const performerDevices = await prisma.device.findMany({
          where: { userId: order.performerUserId, revokedAt: null },
          select: { expoPushToken: true },
        });

        for (const device of performerDevices) {
          await expo.sendPush({
            toUserId: order.performerUserId,
            toExpoToken: device.expoPushToken,
            title: "Замовлення підтверджено",
            body: body.fine
              ? `Замовлення #${orderId.slice(-6)}. Заказчик підтвердив завершення зі штрафом: ваша застава утримана.${body.rating ? ` Оцінка: ${body.rating}/5` : ''}`
              : `Замовлення #${orderId.slice(-6)}. Заказчик підтвердив завершення роботи. Гарантійні суми розблоковано.${body.rating ? ` Оцінка: ${body.rating}/5` : ''}`,
            data: {
              orderId,
              type: "order_confirmed_completed",
              role: "performer",
              accepted: true,
              rating: body.rating,
              fine: body.fine ?? false,
            },
          });
        }

        // Створюємо notification виконавцю
        await prisma.notification.create({
          data: {
            userId: order.performerUserId,
            type: "order",
            title: "Замовлення підтверджено",
            message: body.fine
              ? `Замовлення #${orderId.slice(-6)}. Заказчик підтвердив завершення зі штрафом: ваша застава утримана.${body.rating ? ` Оцінка: ${body.rating}/5` : ''}`
              : `Замовлення #${orderId.slice(-6)}. Заказчик підтвердив завершення роботи. Гарантійні суми розблоковано.${body.rating ? ` Оцінка: ${body.rating}/5` : ''}`,
            data: {
              orderId,
              type: "order_confirmed_completed",
              role: "performer",
              accepted: true,
              rating: body.rating,
              fine: body.fine ?? false,
            } as unknown as Prisma.InputJsonValue,
          },
        });

        // WebSocket виконавцю
        await publishDomainEvent({
          type: "order.completed",
          requestId,
          targets: { userIds: [order.performerUserId] },
          data: {
            orderId,
            status: "completed",
            confirmedByCustomer: true,
            rating: body.rating,
          },
        });
      }

      console.log(
        "\n✅ [ConfirmCompletion] Заказчик підтвердив завершення:",
        `\n   OrderId: ${orderId}`,
        `\n   Rating: ${body.rating ?? 'N/A'}`,
        `\n   Comment: ${body.comment ?? 'N/A'}\n`
      );

      return ok(req, {
        order: { id: order.id, status: "completed" },
        review: body.rating ? { rating: body.rating, comment: body.comment } : null,
      }, { message: "Completion confirmed" });
    } else {
      // Заказчик відхиляє завершення → арбітраж
      await prisma.$transaction([
        prisma.order.update({
          where: { id: orderId },
          data: { status: "arbitration" },
        }),
        prisma.orderStatusEvent.create({
          data: {
            orderId,
            status: "arbitration",
            note: body.comment ?? "Заказчик відхилив завершення",
          },
        }),
      ]);

      // Створюємо notification
      await prisma.notification.create({
        data: {
          userId: order.customerUserId,
          type: "order",
          title: "Відкрито арбітраж",
          message: `Замовлення #${orderId.slice(-6)}. Заказчик відхилив завершення. Відкрито арбітраж.`,
          data: {
            orderId,
            type: "order_rejected_completion",
            role: "customer",
            accepted: false,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      // Відправляємо Push виконавцю
      if (order.performerUserId) {
        const performerDevices = await prisma.device.findMany({
          where: { userId: order.performerUserId, revokedAt: null },
          select: { expoPushToken: true },
        });

        for (const device of performerDevices) {
          await expo.sendPush({
            toUserId: order.performerUserId,
            toExpoToken: device.expoPushToken,
            title: "Замовлення відхилено",
            body: `Замовлення #${orderId.slice(-6)}. Заказчик відхилив завершення. Відкрито арбітраж.`,
            data: {
              orderId,
              type: "order_rejected_completion",
              role: "performer",
              accepted: false,
            },
          });
        }

        // Створюємо notification виконавцю
        await prisma.notification.create({
          data: {
            userId: order.performerUserId,
            type: "order",
            title: "Замовлення відхилено",
            message: `Замовлення #${orderId.slice(-6)}. Заказчик відхилив завершення. Відкрито арбітраж.`,
            data: {
              orderId,
              type: "order_rejected_completion",
              role: "performer",
              accepted: false,
            } as unknown as Prisma.InputJsonValue,
          },
        });

        // WebSocket виконавцю
        await publishDomainEvent({
          type: "order.status_changed",
          requestId,
          targets: { userIds: [order.performerUserId, order.customerUserId] },
          data: {
            orderId,
            fromStatus: "completed",
            toStatus: "arbitration",
          },
        });
      }

      console.log(
        "\n❌ [ConfirmCompletion] Заказчик відхилив завершення:",
        `\n   OrderId: ${orderId}`,
        `\n   Reason: ${body.comment ?? 'N/A'}\n`
      );

      return ok(req, {
        order: { id: order.id, status: "arbitration" },
      }, { message: "Completion rejected, arbitration opened" });
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
