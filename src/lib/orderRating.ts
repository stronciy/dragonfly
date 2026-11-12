import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { COMPLETION_CONFIRMED_NOTE } from "@/lib/completionConfirmation";

export type RatingRole = "customer" | "performer";

/**
 * Оцінка — останній крок після закриття заказу. Заказ закритий, коли він
 * `completed` і або заказчик підтвердив завершення, або арбітраж вирішено.
 */
export async function getOrderRatingState(orderId: string, userId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, customerUserId: true, performerUserId: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  const role: RatingRole | null =
    userId === order.customerUserId ? "customer" : userId === order.performerUserId ? "performer" : null;
  if (!role) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

  const [confirmed, resolved, mine] = await Promise.all([
    prisma.orderStatusEvent.findFirst({
      where: { orderId, note: COMPLETION_CONFIRMED_NOTE },
      select: { id: true },
    }),
    prisma.arbitrationCase.findFirst({
      where: { orderId, status: { in: ["resolved", "closed"] } },
      select: { id: true },
    }),
    prisma.review.findFirst({ where: { orderId, authorUserId: userId }, select: { id: true, rating: true } }),
  ]);

  const closed = order.status === "completed" && (Boolean(confirmed) || Boolean(resolved));
  return {
    order,
    role,
    counterpartyUserId: role === "customer" ? order.performerUserId : order.customerUserId,
    state: {
      role,
      closed,
      canRate: closed && !mine && Boolean(order.performerUserId),
      ratedByMe: Boolean(mine),
      myRating: mine?.rating ?? null,
    },
  };
}

export async function submitOrderRating(args: {
  orderId: string;
  userId: string;
  rating: number;
  comment?: string;
}) {
  const ctx = await getOrderRatingState(args.orderId, args.userId);
  if (!ctx.state.closed) {
    throw new ApiError(409, "CONFLICT", "Оцінити можна лише після закриття заказу");
  }
  if (ctx.state.ratedByMe) throw new ApiError(409, "CONFLICT", "Оцінку вже надіслано");
  if (!ctx.counterpartyUserId) throw new ApiError(409, "CONFLICT", "Немає кого оцінювати");

  const text = args.comment?.trim() ? args.comment.trim() : null;
  const targetIsPerformer = ctx.role === "customer";
  await prisma.review.create({
    data: {
      orderId: args.orderId,
      authorUserId: args.userId,
      performerUserId: targetIsPerformer ? ctx.counterpartyUserId : null,
      customerUserId: targetIsPerformer ? null : ctx.counterpartyUserId,
      rating: args.rating,
      text,
    },
  });
  return {
    counterpartyUserId: ctx.counterpartyUserId,
    role: ctx.role,
    targetIsPerformer,
    performerUserId: ctx.order.performerUserId,
  };
}
