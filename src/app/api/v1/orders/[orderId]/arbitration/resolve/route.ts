import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import {
  getLatestArbitrationResolution,
  serializeArbitrationResolution,
} from "@/shared";

const schema = z.object({
  decision: z.enum(["close_plain", "close_fine"]),
  reason: z.string().max(2000).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(2000).optional(),
});

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || (order.customerUserId !== user.id && order.performerUserId !== user.id)) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    const latest = await getLatestArbitrationResolution(orderId);
    return ok(req, { resolution: latest ? serializeArbitrationResolution(latest) : null });
  } catch (err) {
    return fail(req, err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    if (order.status !== "arbitration") {
      throw new ApiError(409, "CONFLICT", "Замовлення не в арбітражі");
    }

    const pending = await getLatestArbitrationResolution(orderId);
    if (pending && pending.status === "pending") {
      throw new ApiError(409, "CONFLICT", "Пропозиція вже очікує рішення");
    }

    const created = await prisma.arbitrationResolution.create({
      data: {
        orderId,
        proposedById: user.id,
        decision: body.decision,
        status: "pending",
        reason: body.reason?.trim() ? body.reason.trim() : null,
        rating: body.rating ?? null,
        comment: body.comment?.trim() ? body.comment.trim() : null,
      },
    });

    if (order.performerUserId) {
      await notifyUser({
        userId: order.performerUserId,
        type: "arbitration",
        title: "Запропоновано рішення спору",
        message:
          body.decision === "close_fine"
            ? `Замовлення ${await orderRef(orderId)}. Замовник пропонує закрити спір зі штрафом (утримання вашої застави). Підтвердіть або відхиліть.`
            : `Замовлення ${await orderRef(orderId)}. Замовник пропонує закрити спір без штрафу (застави повертаються). Підтвердіть або відхиліть.`,
        data: { orderId, type: "arbitration_resolve_requested", role: "performer" },
      });
      await publishDomainEvent({
        type: "arbitration.resolve_requested",
        requestId,
        targets: { userIds: [order.performerUserId] },
        data: { orderId },
      });
    }

    return ok(req, { resolution: serializeArbitrationResolution(created) }, { status: 201, message: "Пропозицію створено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
