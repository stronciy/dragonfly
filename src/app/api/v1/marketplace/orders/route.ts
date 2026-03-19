import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { makePage, parsePagination } from "@/lib/pagination";

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
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

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
      ...(q.distanceKmMax != null ? { distanceKm: { lte: q.distanceKmMax } } : {}),
    };

    const orderBy =
      q.sort === "price"
        ? [{ order: { budget: "desc" as const } }]
        : q.sort === "date"
          ? [{ order: { createdAt: "desc" as const } }]
          : [{ distanceKm: "asc" as const }];

    const orderWhere = {
      status: "published" as const,
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
              regionName: true,
              lat: true,
              lng: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.orderMatch.count({ where: { ...whereMatch, order: orderWhere } }),
    ]);

    const items = matches.map((m) => ({
        id: m.order.id,
        orderId: m.order.id,
        title: m.order.locationLabel,
        serviceCategoryId: m.order.serviceCategoryId,
        serviceSubCategoryId: m.order.serviceSubCategoryId,
        serviceTypeId: m.order.serviceTypeId,
        areaHa: Number(m.order.areaHa),
        durationDays: null,
        price: Number(m.order.budget),
        budget: Number(m.order.budget),
        currency: m.order.currency,
        distanceKm: Number(m.distanceKm),
        dateFrom: m.order.dateFrom,
        dateTo: m.order.dateTo,
        locationLabel: m.order.locationLabel,
        addressLabel: m.order.locationLabel,
        regionName: m.order.regionName,
        location: {
          lat: Number(m.order.lat),
          lng: Number(m.order.lng),
          locationLabel: m.order.locationLabel,
          addressLabel: m.order.locationLabel,
          regionName: m.order.regionName,
        },
        status: m.order.status,
        createdAt: m.order.createdAt,
      }));

    if (process.env.NODE_ENV !== "production") {
      console.info(`[api] GET /api/v1/marketplace/orders requestId=${requestId} userId=${user.id} total=${totalCount} returned=${items.length}`, {
        orderIds: items.map((i) => i.id),
      });
    }

    return ok(req, { items, page: makePage(limit, offset, totalCount) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
