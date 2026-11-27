import { z } from "zod";
import { formatUahAmount } from "@/lib/money";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef, customerPaymentPlan, part2DeadlineFor, captureCustomerInitialDeposit } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/services/notify";
import { Prisma } from "@prisma/client";

const schema = z.object({
  status: z.enum(["en_route", "started", "completed"]),
});

const allowedTransitions: Record<string, Array<string>> = {
  confirmed: ["en_route", "started"],
  en_route: ["started"],
  started: ["completed"],
};

const statusEventType = {
  en_route: "order.en_route",
  started: "order.started",
  completed: "order.completed",
} as const;

export async function PATCH(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль Виконавця");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    const allowed = allowedTransitions[order.status] ?? [];
    if (!allowed.includes(body.status)) throw new ApiError(400, "VALIDATION_ERROR", "Невірна зміна статусу");

    if (body.status === "started" && order.dateFrom && new Date(order.dateFrom).getTime() > Date.now()) {
      const earlyStart = await prisma.earlyStartRequest.findFirst({
        where: { orderId, status: "approved" },
        orderBy: { createdAt: "desc" },
      });
      if (!earlyStart) {
        throw new ApiError(400, "VALIDATION_ERROR", "Ранній старт ще не погоджено Замовником");
      }
    }

    const plan = customerPaymentPlan(order.budget, order.dateFrom, order.dateTo);
    const isSplit = plan.mode === "split";
    let part2Deadline: Date | null = null;
    if (body.status === "started" && isSplit) {
      part2Deadline = part2DeadlineFor(new Date());
    }

    // >2 діб: завершити роботу можна лише після 100% у звіті та оплати 70%.
    // Підтвердження 30% Замовником більше не блокує завершення: якщо Виконавець
    // пропустив етап 30%, 30% і 70% зараховуються разом після фінального підтвердження.
    if (body.status === "completed" && isSplit) {
      const [part2Paid, latestProgress] = await Promise.all([
        prisma.paymentIntent.findFirst({
          where: { orderId, role: "customer", part: 2, status: "paid" },
          select: { id: true },
        }),
        prisma.workProgressUpdate.findFirst({
          where: { orderId, percent: { not: null } },
          orderBy: { percent: "desc" },
          select: { percent: true },
        }),
      ]);
      if (!part2Paid) {
        throw new ApiError(409, "CONFLICT", "Замовник ще не вніс залишок 70%");
      }
      if ((latestProgress?.percent ?? 0) < 100) {
        throw new ApiError(409, "CONFLICT", "Спочатку зафіксуйте 100% виконання у звіті");
      }
    }

    const { order: updated, completedProgress } = await prisma.$transaction(async (tx) => {
      const u = await tx.order.update({
        where: { id: orderId },
        data: {
          status: body.status,
          ...(part2Deadline ? { customerPart2Deadline: part2Deadline } : {}),
          ...(body.status === "completed" ? { completedAt: new Date() } : {}),
        },
      });
      await tx.orderStatusEvent.create({
        data: { orderId, status: body.status, note: null },
      });

      let completedProgress: { id: string; comment: string | null } | null = null;
      if (body.status === "completed") {
        await tx.orderMatch.deleteMany({ where: { orderId } });

        // Finishing the work always means 100% progress. Create an explicit
        // history entry for both sides, unless 100% was already recorded.
        const latest = await tx.workProgressUpdate.findFirst({
          where: { orderId, percent: { not: null } },
          orderBy: { percent: "desc" },
          select: { percent: true },
        });
        if (latest?.percent == null || latest.percent < 100) {
          completedProgress = await tx.workProgressUpdate.create({
            data: {
              orderId,
              authorId: order.performerUserId ?? user.id,
              percent: 100,
              comment: "Роботи завершено. Прогрес автоматично встановлено на 100%.",
            },
            select: { id: true, comment: true },
          });
        }
      }
      return { order: u, completedProgress };
    });

    // Старт split-замовлення: одразу списуємо 30% з холду Замовника.
    // Помилку не блокуємо — повторні спроби будуть на прогресі 30%,
    // підтвердженні 30% і фінальному підтвердженні.
    if (body.status === "started" && isSplit) {
      try {
        await captureCustomerInitialDeposit(orderId);
      } catch (e) {
        console.warn(
          "[status] customer initial 30% capture failed, will retry",
          { orderId, error: e instanceof Error ? e.message : String(e) }
        );
      }
    }

    // Відправляємо Push та In-App сповіщення замовнику через notifyUser
    const statusTitles: Record<string, string> = {
      en_route: "Виконавець виїхав до поля",
      started: "Виконавець почав роботу",
      completed: "Виконавець завершив роботу",
    };
    const title = statusTitles[body.status] || "Оновлення замовлення";
    let message = "";
    const ref = await orderRef(orderId);
    if (body.status === "en_route") {
      message = `Замовлення ${ref}. Виконавець вирушив до місця виконання робіт.`;
    } else if (body.status === "started") {
      message = `Замовлення ${ref}. Виконавець розпочав виконання робіт.`;
    } else if (body.status === "completed") {
      message = `Замовлення ${ref}. Виконавець завершив виконання робіт. Перевірте та підтвердіть.`;
    }

    await notifyUser({
      userId: order.customerUserId,
      type: "order",
      title,
      message,
      data: {
        orderId,
        type: `order_${body.status}`,
        role: "customer",
        newStatus: body.status,
        action: "view_order",
        actorId: user.id,
      },
    });

    // WebSocket для оновлення екрану
    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [updated.customerUserId, updated.performerUserId!].filter(Boolean) as string[] },
      data: { orderId: updated.id, fromStatus: order.status, toStatus: updated.status, actorId: user.id },
    });
    
    // Додаткове специфічне сповіщення для замовника
    await publishDomainEvent({
      type: statusEventType[body.status],
      requestId,
      targets: { userIds: [updated.customerUserId] },
      data: { 
        orderId: updated.id, 
        status: updated.status,
        performerId: updated.performerUserId,
        actorId: user.id,
        title,
        message,
      },
    });

    if (part2Deadline) {
      const deadlineLabel = part2Deadline.toLocaleString("uk-UA", {
        timeZone: "Europe/Kyiv",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      // Повідомляємо замовника про 24-годинний строк на внесення залишку 70%
      notifyUser({
        userId: order.customerUserId,
        type: "payment",
        title: "Внесення залишку 70%",
        message: `Замовлення ${ref}. Виконавець розпочав виконання робіт. Внесіть залишок 70% (${formatUahAmount(plan.part2Amount)}) в ескроу протягом 24 годин (до ${deadlineLabel}). Якщо кошти не надійдуть у строк, Виконавець має право припинити роботи та покинути об'єкт.`,
        data: {
          orderId,
          amount: Number(plan.part2Amount),
          deadline: part2Deadline.toISOString(),
          role: "customer",
          action: "pay_part2",
        },
      }).catch(() => {});

      // Повідомляємо виконавця про 24-годинний строк для замовника
      notifyUser({
        userId: user.id,
        type: "order.started",
        title: "Роботи розпочато",
        message: `Ви розпочали виконання робіт. Замовнику надано 24 години на внесення залишку 70% (до ${deadlineLabel}). При досягненні 30% готовності робіт вам буде зараховано 30% вартості замовлення на баланс гаманця (доступно до виведення).`,
        data: { orderId, orderNumber: order.orderNumber, action: "view_order" },
      }).catch(() => {});

      await publishDomainEvent({
        type: "deposit.customer_part2_required",
        requestId,
        targets: { userIds: [order.customerUserId, user.id] },
        data: {
          orderId,
          amount: Number(plan.part2Amount),
          deadline: part2Deadline.toISOString(),
        },
      });
    }

    if (completedProgress) {
      console.info(
        `[api] PATCH /api/v1/orders/${orderId}/status auto-progress-100 requestId=${requestId} orderId=${orderId} progressId=${completedProgress.id} performerUserId=${updated.performerUserId}`
      );
      // Notify both clients so the new 100% history entry appears immediately.
      await publishDomainEvent({
        type: "order.progress_updated",
        requestId,
        targets: {
          userIds: [updated.customerUserId, updated.performerUserId!].filter(Boolean) as string[],
        },
        data: {
          orderId: updated.id,
          percent: 100,
          note: completedProgress.comment,
          actorId: user.id,
          title: "Роботи завершено",
          message: "Прогрес автоматично оновлено до 100%",
        },
      });
    }

    return ok(
      req,
      {
        order: { id: updated.id, status: updated.status },
        completedProgress: completedProgress
          ? { id: completedProgress.id, percent: 100, comment: completedProgress.comment }
          : null,
      },
      { message: "Статус оновлено" }
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
