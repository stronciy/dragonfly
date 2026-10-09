import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import { recomputePerformerRating } from "@/shared";

const schema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    if (order.status !== "completed") {
      throw new ApiError(409, "CONFLICT", "Замовника можна оцінити лише після завершення робіт");
    }

    const existing = await prisma.review.findFirst({ where: { orderId, authorUserId: user.id } });
    if (existing) throw new ApiError(409, "CONFLICT", "Відгук вже надіслано");

    await prisma.review.create({
      data: {
        orderId,
        customerUserId: order.customerUserId,
        authorUserId: user.id,
        rating: body.rating,
        text: body.comment?.trim() ? body.comment.trim() : null,
      },
    });
    await recomputePerformerRating(user.id);

    await notifyUser({
      userId: order.customerUserId,
      type: "order",
      title: "Вас оцінили",
      message: `Замовлення ${await orderRef(orderId)}. Виконавець оцінив співпрацю: ${body.rating}/5.`,
      data: { orderId, type: "customer_rated", role: "customer", rating: body.rating },
    });
    await publishDomainEvent({
      type: "order.updated",
      requestId,
      targets: { userIds: [order.customerUserId] },
      data: { orderId },
    });

    return ok(req, { rated: true }, { status: 201, message: "Відгук надіслано" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
