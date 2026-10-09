import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import { getLatestEarlyStartRequest, serializeEarlyStartRequest } from "@/shared";

const schema = z.object({ reason: z.string().max(2000).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => ({})));

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    const pending = await getLatestEarlyStartRequest(orderId);
    if (!pending || pending.status !== "pending") {
      throw new ApiError(409, "CONFLICT", "Немає активного запиту раннього старту");
    }

    const decided = await prisma.earlyStartRequest.update({
      where: { id: pending.id },
      data: { status: "rejected", reason: body.reason ?? null, decidedAt: new Date() },
    });

    if (order.performerUserId) {
      await notifyUser({
        userId: order.performerUserId,
        type: "order",
        title: "Достроковий старт відхилено",
        message: `Замовлення #${orderId.slice(-6)}. Замовник не погодив достроковий початок${body.reason ? `: ${body.reason.slice(0, 120)}` : ""}. Старт — з запланованої дати.`,
        data: { orderId, type: "early_start_rejected", role: "performer" },
      });
      await publishDomainEvent({
        type: "order.early_start_rejected",
        requestId,
        targets: { userIds: [order.performerUserId] },
        data: { orderId },
      });
    }

    return ok(req, { earlyStart: serializeEarlyStartRequest(decided) }, { message: "Ранній старт відхилено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
