import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { ExpoPushService } from "@/shared";
import { releaseEscrowForOrder, settleProviderHolds, emitEscrowChanged } from "@/shared";
import { recomputePerformerRating } from "@/shared";
import { customerPaymentPlan } from "@/shared";
import { COMPLETION_CONFIRMED_NOTE } from "@/lib/completionConfirmation";
import { Prisma } from "@prisma/client";

const schema = z.object({
  accepted: z.boolean(),
  comment: z.string().max(1000).optional(),
  rating: z.number().min(1).max(5).optional(),
});

/**
 * POST /api/v1/orders/:orderId/confirm-completion
 *
 * Замовник приймає роботу. Гарантійні суми (застава виконавця і застава
 * замовника) розблоковуються лише тут: виконавець уже має статус completed
 * (він підтвердив завершення), а замовник підтверджує прийняття.
 * Штрафу в цьому маршруті немає: незгоду замовник оформлює арбітражем.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());
    if (!body.accepted) {
      throw new ApiError(400, "VALIDATION_ERROR", "Щоб відхилити роботу, відкрийте арбітраж з причиною та доказами");
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    if (order.status !== "completed") throw new ApiError(409, "CONFLICT", "Роботу ще не завершено");

    // Safety net for orders completed before auto-100% was introduced: the
    // customer must always see a 100% entry in the report history.
    const latestProgress = await prisma.workProgressUpdate.findFirst({
      where: { orderId, percent: { not: null } },
      orderBy: { percent: "desc" },
      select: { percent: true },
    });
    if (latestProgress?.percent == null || latestProgress.percent < 100) {
      await prisma.workProgressUpdate.create({
        data: {
          orderId,
          authorId: order.performerUserId ?? user.id,
          percent: 100,
          comment: "Роботи завершено. Прогрес автоматично встановлено на 100%.",
        },
      });
    }
    
    // Перевірка чи вже не було підтвердження завершення
    // Перевіряємо чи вже є review від цього замовника
    const existingReview = await prisma.review.findFirst({
      where: {
        orderId,
        authorUserId: user.id,
      },
    });
    
    if (existingReview) {
      throw new ApiError(409, "CONFLICT", "Завершення вже підтверджено");
    }

    const alreadyConfirmed = await prisma.orderStatusEvent.findFirst({
      where: { orderId, note: COMPLETION_CONFIRMED_NOTE },
      select: { id: true },
    });
    if (alreadyConfirmed) throw new ApiError(409, "CONFLICT", "Завершення вже підтверджено");

    const plan = customerPaymentPlan(order.budget, order.dateFrom, order.dateTo);
    if (plan.mode === "split") {
      const part2Paid = await prisma.paymentIntent.findFirst({
        where: { orderId, role: "customer", part: 2, status: "paid" },
        select: { id: true },
      });
      if (!part2Paid) {
        throw new ApiError(409, "CONFLICT", "Залишок 70% ще не внесено — закриття можливе після оплати");
      }
    }

    const resolvedArbitration = await prisma.arbitrationResolution.findFirst({
      where: { orderId, status: "approved" },
      select: { id: true },
    });
    if (resolvedArbitration) {
      throw new ApiError(409, "CONFLICT", "Замовлення вже закрито через арбітраж");
    }

    const expo = new ExpoPushService(prisma);

    // Замовник підтверджує завершення
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

      await releaseEscrowForOrder(tx, { orderId, to: "released" });
    });

    await prisma.orderStatusEvent.create({
      data: { orderId, status: "completed", note: COMPLETION_CONFIRMED_NOTE },
    });

    if (order.performerUserId) await recomputePerformerRating(order.performerUserId).catch(() => {});

    await settleProviderHolds({ orderId, to: "released" }).catch(() => {});

    await emitEscrowChanged({
      requestId,
      orderId,
      customerUserId: order.customerUserId,
      performerUserId: order.performerUserId,
      roles: ["performer", "customer"],
      orderStatus: "completed",
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
          body: `Замовлення ${await orderRef(orderId)}. Замовник підтвердив завершення роботи. Гарантійні суми розблоковано.${body.rating ? ` Оцінка: ${body.rating}/5` : ''}`,
          data: {
            orderId,
            type: "order_confirmed_completed",
            role: "performer",
            accepted: true,
            rating: body.rating,
          },
        });
      }

      // Створюємо notification виконавцю
      await prisma.notification.create({
        data: {
          userId: order.performerUserId,
          type: "order",
          title: "Замовлення підтверджено",
          message: `Замовлення ${await orderRef(orderId)}. Замовник підтвердив завершення роботи. Гарантійні суми розблоковано.${body.rating ? ` Оцінка: ${body.rating}/5` : ''}`,
          data: {
            orderId,
            type: "order_confirmed_completed",
            role: "performer",
            accepted: true,
            rating: body.rating,
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
      "\n✅ [ConfirmCompletion] Замовник підтвердив завершення:",
      `\n   OrderId: ${orderId}`,
      `\n   Rating: ${body.rating ?? 'N/A'}`,
      `\n   Comment: ${body.comment ?? 'N/A'}\n`
    );

    return ok(req, {
      order: { id: order.id, status: "completed" },
      review: body.rating ? { rating: body.rating, comment: body.comment } : null,
    }, { message: "Завершення підтверджено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
