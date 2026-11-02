import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef } from "@/shared";
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
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
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
        throw new ApiError(400, "VALIDATION_ERROR", "Ранній старт ще не погоджено замовником");
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.order.update({
        where: { id: orderId },
        data: {
          status: body.status,
          ...(body.status === "completed" ? { completedAt: new Date() } : {}),
        },
      });
      await tx.orderStatusEvent.create({
        data: { orderId, status: body.status, note: null },
      });
      if (body.status === "completed") {
        await tx.orderMatch.deleteMany({ where: { orderId } });
      }
      return u;
    });

    // Відправляємо Push та In-App сповіщення замовнику через notifyUser
    if (body.status === "en_route") {
      await notifyUser({
        userId: order.customerUserId,
        type: "order",
        title: "Виконавець виїхав до поля",
        message: `Замовлення ${await orderRef(orderId)}. Виконавець вирушив до місця виконання робіт.`,
        data: {
          orderId,
          type: "order_en_route",
          role: "customer",
          newStatus: "en_route",
          action: "view_order",
        },
      });
    } else if (body.status === "started") {
      await notifyUser({
        userId: order.customerUserId,
        type: "order",
        title: "Виконавець почав роботу",
        message: `Замовлення ${await orderRef(orderId)}. Виконавець розпочав виконання робіт.`,
        data: {
          orderId,
          type: "order_started",
          role: "customer",
          newStatus: "started",
          action: "view_order",
        },
      });
    } else if (body.status === "completed") {
      await notifyUser({
        userId: order.customerUserId,
        type: "order",
        title: "Виконавець завершив роботу",
        message: `Замовлення ${await orderRef(orderId)}. Виконавець завершив виконання робіт. Перевірте та підтвердіть.`,
        data: {
          orderId,
          type: "order_completed",
          role: "customer",
          newStatus: "completed",
          action: "view_order",
        },
      });
    }

    // WebSocket для оновлення екрану
    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [updated.customerUserId, updated.performerUserId!].filter(Boolean) as string[] },
      data: { orderId: updated.id, fromStatus: order.status, toStatus: updated.status },
    });
    
    // Додаткове специфічне сповіщення
    await publishDomainEvent({
      type: statusEventType[body.status],
      requestId,
      targets: { userIds: [updated.customerUserId] },
      data: { 
        orderId: updated.id, 
        status: updated.status,
        performerId: updated.performerUserId,
      },
    });

    return ok(req, { order: { id: updated.id, status: updated.status } }, { message: "Статус оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
