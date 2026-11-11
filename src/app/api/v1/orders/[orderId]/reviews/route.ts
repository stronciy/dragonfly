import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef, publishDomainEvent, notifyUser, recomputePerformerRating } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { submitOrderRating } from "@/lib/orderRating";

const schema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

/** Старий шлях оцінки (сумісність зі старими збірками): ті самі правила, що й /rating. */
export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const result = await submitOrderRating({ orderId, userId: user.id, rating: body.rating, comment: body.comment });
    // Видимість оцінки залежить від взаємності: після будь-якої оцінки перераховуємо рейтинг виконавця.
    if (result.performerUserId) await recomputePerformerRating(result.performerUserId);

    await notifyUser({
      userId: result.counterpartyUserId,
      type: "order",
      title: "Вас оцінили",
      message: `Замовлення ${await orderRef(orderId)}. Вас оцінено: ${body.rating}/5.`,
      data: { orderId, type: "order_rated", rating: body.rating },
    });
    await publishDomainEvent({
      type: "order.updated",
      requestId,
      targets: { userIds: [result.counterpartyUserId] },
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

