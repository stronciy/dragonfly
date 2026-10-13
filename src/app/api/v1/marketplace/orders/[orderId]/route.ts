import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { safeDepositAmount } from "@/shared";
import {
  maskOrderLocationForMarketplace,
  marketplaceDistanceKm,
} from "@/lib/marketplaceVisibility";

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    const isAssigned = order.performerUserId === user.id;
    // Your own orders are never performer work (open them as customer).
    if (order.customerUserId === user.id && !isAssigned)
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    const match = isAssigned
      ? null
      : await prisma.orderMatch.findUnique({
          where: {
            uniq_performer_order_match: { performerUserId: user.id, orderId },
          },
        });
    if (!isAssigned && !match) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    const deposit = safeDepositAmount(order.budget);

    const profile = await prisma.performerProfile.findUnique({
      where: { userId: user.id },
      select: { baseLatitude: true, baseLongitude: true },
    });
    const distanceKm = marketplaceDistanceKm(
      {
        baseLatitude: profile?.baseLatitude ?? null,
        baseLongitude: profile?.baseLongitude ?? null,
      },
      { lat: Number(order.lat), lng: Number(order.lng) }
    );

    return ok(req, {
        order: {
          id: order.id,
          status: order.status,
          serviceCategoryId: order.serviceCategoryId,
          serviceSubCategoryId: order.serviceSubCategoryId,
          serviceTypeId: order.serviceTypeId,
          areaHa: Number(order.areaHa),
          dateFrom: order.dateFrom,
          dateTo: order.dateTo,
          budget: Number(order.budget),
          priceUah: Number(order.budget),
          currency: order.currency,
          orderNumber: order.orderNumber,
          comment: order.comment,
          acceptedAt: order.acceptedAt,
          depositDeadline: order.depositDeadline,
          depositAmount: Number(deposit),
          depositUah: Number(deposit),
          deposit: {
            performerDepositAmount: Number(deposit),
            amount: Number(deposit),
            currency: order.currency,
          },
          performerUserId: order.performerUserId,
          createdAt: order.createdAt,
          distanceKm,
          // Full address/geo only for the assigned performer once confirmed.
          ...maskOrderLocationForMarketplace(order, { assigned: isAssigned }),
        },
      }
    );
  } catch (err) {
    return fail(req, err);
  }
}
