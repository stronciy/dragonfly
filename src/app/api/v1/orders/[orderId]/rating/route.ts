import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef, publishDomainEvent, notifyUser, recomputePerformerRating } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { getOrderRatingState, submitOrderRating } from "@/lib/orderRating";

export const runtime = "nodejs";

const schema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

/** Стан оцінки для поточного учасника: чи закрито заказ, чи можна оцінити, чи вже оцінено. */
export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const { state } = await getOrderRatingState(orderId, user.id);
    // Стан оцінки не кешується: після оцінки повторний запит мусить бачити
    // `ratedByMe: true`, інакше картка знову просить поставити оцінку.
    return ok(req, { rating: state }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(req, err);
  }
}

/** Одна оцінка на учасника після закриття заказу: заказчик оцінює виконавця і навпаки. */
export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const result = await submitOrderRating({ orderId, userId: user.id, rating: body.rating, comment: body.comment });

    // Відгук уже збережено — побічні ефекти не повинні перетворювати успішну
    // оцінку на помилку, інакше клієнт показує «не вдалося» і просить оцінити ще раз.
    if (result.performerUserId) {
      await recomputePerformerRating(result.performerUserId).catch(() => {});
    }
    const number = await orderRef(orderId);
    await notifyUser({
      userId: result.counterpartyUserId,
      type: "order",
      title: "Вас оцінили",
      message: `Замовлення ${number}. Вас оцінено: ${body.rating}/5.`,
      data: { orderId, type: "order_rated", role: result.role === "customer" ? "performer" : "customer", rating: body.rating },
    }).catch(() => {});
    await publishDomainEvent({
      type: "order.updated",
      requestId,
      targets: { userIds: [user.id, result.counterpartyUserId] },
      data: { orderId },
    }).catch(() => {});

    const { state } = await getOrderRatingState(orderId, user.id);
    return ok(req, { rating: state }, { status: 201, message: "Оцінку збережено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}

