import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { notifyUser } from "@/services/notify";
import { publishDomainEvent } from "@/shared";

const progressSchema = z.object({
  percent: z.number().min(0).max(100),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    
    if (user.role !== "performer") {
      throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    }

    const body = progressSchema.parse(await req.json());
    const { percent, note } = body;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, name: true, phone: true, expoPushToken: true } },
      },
    });

    if (!order) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    if (order.performerUserId !== user.id) {
      throw new ApiError(403, "FORBIDDEN", "Ви не є виконавцем цього замовлення");
    }

    if (!["started", "en_route"].includes(order.status)) {
      throw new ApiError(400, "BAD_REQUEST", "Роботу ще не розпочато");
    }

    // Create progress update
    await prisma.workProgressUpdate.create({
      data: {
        orderId,
        userId: user.id,
        percent,
        note: note || null,
      },
    });

    // Check if this is the first time reaching 30%
    const previousUpdates = await prisma.workProgressUpdate.count({
      where: { orderId, percent: { lt: 30 } },
    });

    const hasReached30 = percent >= 30;
    const wasBelow30 = previousUpdates > 0 || percent === 30;
    
    // Get previous max progress
    const previousMax = await prisma.workProgressUpdate.findFirst({
      where: { orderId },
      orderBy: { percent: "desc" },
      select: { percent: true },
    });

    const firstTime30 = hasReached30 && (!previousMax || previousMax.percent < 30);

    // Notify performer that they can request payment if first time 30%
    if (firstTime30) {
      notifyUser({
        userId: user.id,
        type: "progress.30_percent_reached",
        title: "Досягнуто 30% виконання",
        message: `Робота досягла 30% готовності. Ви можете запросити у замовника внесення оставшейся суми (70%).`,
        data: { orderId, orderNumber: order.orderNumber, percent },
      }).catch(() => {});
    }

    // Notify customer about progress
    if (percent >= 30) {
      notifyUser({
        userId: order.customerUserId,
        type: "order.progress_updated",
        title: "Оновлення прогресу",
        message: `Виконавець повідомив про ${percent}% готовності роботи за замовленням #${order.orderNumber || orderId.substring(0,8)}`,
        data: { orderId, orderNumber: order.orderNumber, percent },
      }).catch(() => {});
    }

    // Publish domain event
    await publishDomainEvent({
      type: "order.progress_updated",
      requestId,
      targets: { userIds: [order.customerUserId, user.id] },
      data: { orderId, percent, note },
    });

    return ok(req, { 
      progress: percent,
      canRequestPayment: hasReached30 && !order.customerPart2Deadline,
      message: hasReached30 ? "Досягнуто 30%! Ви можете запросити оплату оставшейся суми" : "Прогрес оновлено" 
    });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірні дані", err.flatten()));
    }
    return fail(req, err);
  }
}
