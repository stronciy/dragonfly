import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import { formatOrderDateRange } from "@/shared";
import { getLatestEarlyStartRequest, serializeEarlyStartRequest } from "@/shared";

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (
      !order ||
      (order.customerUserId !== user.id && order.performerUserId !== user.id)
    ) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    const latest = await getLatestEarlyStartRequest(orderId);
    return ok(req, { earlyStart: latest ? serializeEarlyStartRequest(latest) : null });
  } catch (err) {
    return fail(req, err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    if (order.status !== "confirmed") {
      throw new ApiError(409, "CONFLICT", "Ранній старт можна запросити лише для підтверджених замовлень");
    }
    if (!order.dateFrom || new Date(order.dateFrom).getTime() <= Date.now()) {
      throw new ApiError(409, "CONFLICT", "Роботу вже можна починати, погодження не потрібне");
    }

    const pending = await getLatestEarlyStartRequest(orderId);
    if (pending && pending.status === "pending") {
      throw new ApiError(409, "CONFLICT", "Запит раннього старту вже очікує");
    }

    const created = await prisma.earlyStartRequest.create({
      data: { orderId, requestedById: user.id, status: "pending" },
    });

    await notifyUser({
      userId: order.customerUserId,
      type: "order",
      title: "Виконавець просить почати раніше",
      message: `Замовлення ${await orderRef(orderId)}. Виконавець готовий розпочати роботи достроково (заплановано: ${formatOrderDateRange(order.dateFrom, order.dateTo) ?? "—"}). Підтвердіть, щоб відкрити кнопку старту.`,
      data: { orderId, type: "early_start_requested", role: "customer" },
    });
    await publishDomainEvent({
      type: "order.early_start_requested",
      requestId,
      targets: { userIds: [order.customerUserId] },
      data: { orderId },
    });

    return ok(req, { earlyStart: serializeEarlyStartRequest(created) }, { status: 201, message: "Запит створено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
