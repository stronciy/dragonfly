import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;

    const match = await prisma.orderMatch.findUnique({
      where: { uniq_performer_order_match: { performerUserId: user.id, orderId } },
      include: { order: true },
    });

    if (!match || match.order.status !== "published") throw new ApiError(404, "NOT_FOUND", "Order not found");

    return ok(req, {
      order: {
        id: match.order.id,
        status: match.order.status,
        serviceCategoryId: match.order.serviceCategoryId,
        serviceSubCategoryId: match.order.serviceSubCategoryId,
        serviceTypeId: match.order.serviceTypeId,
        areaHa: Number(match.order.areaHa),
        location: {
          lat: Number(match.order.lat),
          lng: Number(match.order.lng),
          locationLabel: match.order.locationLabel,
          addressLabel: match.order.locationLabel,
          regionName: match.order.regionName,
        },
        dateFrom: match.order.dateFrom,
        dateTo: match.order.dateTo,
        comment: match.order.comment,
        quote: { amount: Number(match.order.budget), currency: match.order.currency },
        deposit: { performerDepositAmount: Number(match.order.budget) * 0.1, currency: match.order.currency },
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
