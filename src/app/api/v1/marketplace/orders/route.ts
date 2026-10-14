import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { makePage, parsePagination } from "@/lib/pagination";
import {
  maskOrderLocationForMarketplace,
  marketplaceDistanceKm,
} from "@/lib/marketplaceVisibility";

const querySchema = z.object({
  serviceCategoryId: z.string().optional(),
  serviceSubCategoryId: z.string().optional(),
  distanceKmMax: z.coerce.number().optional(),
  sort: z.enum(["distance", "price", "date"]).optional(),
});

export async function GET(req: Request) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");

    const url = new URL(req.url);
    const { limit, offset } = parsePagination(url);
    const q = querySchema.parse({
      serviceCategoryId: url.searchParams.get("serviceCategoryId") ?? undefined,
      serviceSubCategoryId: url.searchParams.get("serviceSubCategoryId") ?? undefined,
      distanceKmMax: url.searchParams.get("distanceKmMax") ?? undefined,
      sort: url.searchParams.get("sort") ?? undefined,
    });

    const whereMatch = {
      performerUserId: user.id,
      status: { in: ["pending", "matched"] },
      ...(q.distanceKmMax != null ? { distanceKm: { lte: q.distanceKmMax } } : {}),
    };

    const orderBy =
      q.sort === "price"
        ? [{ order: { budget: "desc" as const } }]
        : q.sort === "date"
          ? [{ order: { createdAt: "desc" as const } }]
          : [{ createdAt: "asc" as const }];

    const orderWhere = {
      status: "published" as const,
      // Never show your own orders as performer work, even if a stray
      // orderMatch row links them (matching SQL also excludes self).
      customerUserId: { not: user.id },
      ...(q.serviceCategoryId ? { serviceCategoryId: q.serviceCategoryId } : {}),
      ...(q.serviceSubCategoryId ? { serviceSubCategoryId: q.serviceSubCategoryId } : {}),
    };

    const [matches, totalCount] = await prisma.$transaction([
      prisma.orderMatch.findMany({
        where: { ...whereMatch, order: orderWhere },
        orderBy,
        take: limit,
        skip: offset,
        include: {
          order: {
            select: {
              id: true,
              status: true,
              serviceCategoryId: true,
              serviceSubCategoryId: true,
              serviceTypeId: true,
              areaHa: true,
              dateFrom: true,
              dateTo: true,
              budget: true,
              currency: true,
              locationLabel: true,
              orderNumber: true,
              regionName: true,
              settlementName: true,
              lat: true,
              lng: true,
              createdAt: true,
              _count: { select: { applications: { where: { status: "pending" } } } },
            },
          },
        },
      }),
      prisma.orderMatch.count({ where: { ...whereMatch, order: orderWhere } }),
    ]);

    const profile = await prisma.performerProfile.findUnique({
      where: { userId: user.id },
      select: { baseLatitude: true, baseLongitude: true },
    });
    const base = {
      baseLatitude: profile?.baseLatitude ?? null,
      baseLongitude: profile?.baseLongitude ?? null,
    };

    const orderIds = matches.map((m) => m.order.id);
    const myApplications = orderIds.length
      ? await prisma.orderApplication.findMany({
          where: { performerUserId: user.id, orderId: { in: orderIds } },
          select: { id: true, orderId: true, status: true },
        })
      : [];
    const myApplicationByOrder = new Map(
      myApplications.map((a) => [a.orderId, { id: a.id, status: a.status }])
    );

    const items = matches.map((m) => {
        // Masked location only — the marketplace is discovery, never the
        // assigned performer's view. `title` reuses the masked placeholder so
        // the exact address is not smuggled in via the title field.
        const locationMask = maskOrderLocationForMarketplace(m.order, { assigned: false });
        return {
          id: m.order.id,
          orderId: m.order.id,
          title: locationMask.locationLabel,
          serviceCategoryId: m.order.serviceCategoryId,
          serviceSubCategoryId: m.order.serviceSubCategoryId,
          serviceTypeId: m.order.serviceTypeId,
          areaHa: Number(m.order.areaHa),
          durationDays: null,
          price: Number(m.order.budget),
          budget: Number(m.order.budget),
          currency: m.order.currency,
          dateFrom: m.order.dateFrom,
          dateTo: m.order.dateTo,
          orderNumber: m.order.orderNumber,
          status: m.order.status,
          createdAt: m.order.createdAt,
          distanceKm: marketplaceDistanceKm(base, {
            lat: Number(m.order.lat),
            lng: Number(m.order.lng),
          }),
          applicationsCount: m.order._count.applications,
          myApplication: myApplicationByOrder.get(m.order.id) ?? null,
          ...locationMask,
        };
      });

    if (process.env.NODE_ENV !== "production") {
      console.info(`[api] GET /api/v1/marketplace/orders requestId=${requestId} userId=${user.id} total=${totalCount} returned=${items.length}`, {
        orderIds: items.map((i) => i.id),
      });
    }

    return ok(req, { items, page: makePage(limit, offset, totalCount) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
