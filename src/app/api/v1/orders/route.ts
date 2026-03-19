import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { enqueueMatchNewOrder } from "@/queues/jobs";
import { makePage, parsePagination } from "@/lib/pagination";

const postSchema = z.object({
  serviceCategoryId: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)),
  serviceSubCategoryId: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)),
  serviceTypeId: z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z.string().min(1).nullable().optional()
  ),
  areaHa: z.coerce.number().positive(),
  dateFrom: z.string().datetime().nullable().optional(),
  dateTo: z.string().datetime().nullable().optional(),
  location: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    addressLabel: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)),
    regionName: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)).optional(),
  }),
  comment: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().max(5000)).optional(),
  budget: z.coerce.number().positive(),
  status: z.enum(["draft", "published"]).optional(),
});

const listQuerySchema = z.object({
  status: z
    .enum([
      "draft",
      "published",
      "accepted",
      "pending_deposit",
      "requires_confirmation",
      "confirmed",
      "started",
      "completed",
      "arbitration",
      "cancelled",
    ])
    .optional(),
  group: z.enum(["all", "active", "closed"]).optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");

    const url = new URL(req.url);
    const { limit, offset } = parsePagination(url);
    const { status, group } = listQuerySchema.parse({
      status: url.searchParams.get("status") ?? undefined,
      group: url.searchParams.get("group") ?? undefined,
    });

    const activeStatuses = ["draft", "published", "accepted", "requires_confirmation", "pending_deposit", "confirmed", "started", "arbitration"] as const;
    const closedStatuses = ["completed", "cancelled"] as const;

    const whereBase = { customerUserId: user.id };
    const where =
      status
        ? { ...whereBase, status }
        : group === "active"
          ? { ...whereBase, status: { in: [...activeStatuses] } }
          : group === "closed"
            ? { ...whereBase, status: { in: [...closedStatuses] } }
            : whereBase;

    const [items, totalCount] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true,
          status: true,
          areaHa: true,
          locationLabel: true,
          lat: true,
          lng: true,
          dateFrom: true,
          dateTo: true,
          budget: true,
          currency: true,
          acceptedAt: true,
          depositDeadline: true,
          createdAt: true,
        },
      }),
      prisma.order.count({ where }),
    ]);

    return ok(req, {
      items: items.map((o) => ({
        id: o.id,
        title: o.locationLabel,
        status: o.status,
        areaHa: Number(o.areaHa),
        locationLabel: o.locationLabel,
        location: { lat: Number(o.lat), lng: Number(o.lng) },
        dateFrom: o.dateFrom,
        dateTo: o.dateTo,
        budget: Number(o.budget),
        acceptedAt: o.acceptedAt,
        depositDeadline: o.depositDeadline,
        depositAmount: Number(o.budget) * 0.1,
        escrowAmount: null,
        createdAt: o.createdAt,
      })),
      page: makePage(limit, offset, totalCount),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");

    const requestId = getRequestId(req);
    const rawBody = await req.json().catch(() => ({}));
    const body = postSchema.parse(rawBody);
    const status = body.status ?? "published";

    if (process.env.NODE_ENV !== "production") {
      console.info(`[api] POST /api/v1/orders requestId=${requestId} userId=${user.id} payload`, {
        serviceCategoryId: body.serviceCategoryId,
        serviceSubCategoryId: body.serviceSubCategoryId,
        serviceTypeId: body.serviceTypeId ?? null,
        areaHa: body.areaHa,
        dateFrom: body.dateFrom ?? null,
        dateTo: body.dateTo ?? null,
        location: { lat: body.location.lat, lng: body.location.lng },
        budget: body.budget,
        status,
      });
    }

    const { categoryOk, subcategoryOk, subcategoryHasTypes, serviceTypeOk } = await prisma.$transaction(async (tx) => {
      const [category, subcategory] = await Promise.all([
        tx.serviceCategory.findUnique({ where: { id: body.serviceCategoryId }, select: { id: true } }),
        tx.serviceSubcategory.findUnique({
          where: { id: body.serviceSubCategoryId },
          select: { id: true, categoryId: true, _count: { select: { types: true } } },
        }),
      ]);

      const categoryOk = Boolean(category);
      const subcategoryOk = Boolean(subcategory) && subcategory?.categoryId === body.serviceCategoryId;
      const subcategoryHasTypes = Boolean(subcategory) && (subcategory?._count.types ?? 0) > 0;

      if (!categoryOk || !subcategoryOk) {
        return { categoryOk, subcategoryOk, subcategoryHasTypes, serviceTypeOk: false };
      }

      if (body.serviceTypeId == null) {
        return { categoryOk, subcategoryOk, subcategoryHasTypes, serviceTypeOk: !subcategoryHasTypes };
      }

      const type = await tx.serviceType.findUnique({
        where: { subcategoryId_id: { subcategoryId: body.serviceSubCategoryId, id: body.serviceTypeId } },
        select: { id: true },
      });

      return { categoryOk, subcategoryOk, subcategoryHasTypes, serviceTypeOk: Boolean(type) };
    });

    if (process.env.NODE_ENV !== "production") {
      console.info(`[api] POST /api/v1/orders catalog_check requestId=${requestId}`, {
        categoryOk,
        subcategoryOk,
        subcategoryHasTypes,
        serviceTypeOk,
      });
    }

    if (!categoryOk) throw new ApiError(404, "NOT_FOUND", "Service category not found");
    if (!subcategoryOk) throw new ApiError(404, "NOT_FOUND", "Service subcategory not found");

    if (body.serviceTypeId == null && subcategoryHasTypes) {
      throw new ApiError(400, "VALIDATION_ERROR", "serviceTypeId is required for this subcategory", {
        fieldErrors: { serviceTypeId: ["Required for this subcategory"] },
      });
    }
    if (body.serviceTypeId != null && !serviceTypeOk) {
      throw new ApiError(404, "NOT_FOUND", "Service type not found");
    }

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          customerUserId: user.id,
          serviceCategoryId: body.serviceCategoryId,
          serviceSubCategoryId: body.serviceSubCategoryId,
          serviceTypeId: body.serviceTypeId ?? null,
          areaHa: body.areaHa,
          dateFrom: body.dateFrom ? new Date(body.dateFrom) : null,
          dateTo: body.dateTo ? new Date(body.dateTo) : null,
          locationLabel: body.location.addressLabel,
          regionName: body.location.regionName ?? null,
          lat: body.location.lat,
          lng: body.location.lng,
          comment: body.comment ?? null,
          budget: body.budget,
          currency: "UAH",
          status,
          statusEvents: {
            create: { fromStatus: null, toStatus: status, note: null },
          },
        },
        select: { id: true, status: true, createdAt: true },
      });

      return created;
    });

    if (process.env.NODE_ENV !== "production") {
      console.info(`[api] POST /api/v1/orders created requestId=${requestId} userId=${user.id}`, order);
    }

    if (order.status === "published") {
      if (process.env.NODE_ENV !== "production") {
        const eligibleCountRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(DISTINCT ps.performer_user_id)::bigint AS count
          FROM performer_services srv
          JOIN performer_settings ps ON ps.performer_user_id = srv.performer_user_id
          JOIN users u ON u.id = ps.performer_user_id
          JOIN orders o ON o.id = ${order.id}
          WHERE srv.service_category_id = o.service_category_id
            AND srv.service_subcategory_id = o.service_subcategory_id
            AND u.role = 'performer'
            AND ps.performer_user_id <> o.customer_user_id
            AND (srv.service_type_id IS NULL OR o.service_type_id IS NULL OR srv.service_type_id = o.service_type_id)
            AND (
              ps.coverage_mode = 'country'
              OR (
                ps.coverage_mode = 'radius'
                AND ps.radius_km IS NOT NULL
                AND ps.base_geo IS NOT NULL
                AND o.location_geo IS NOT NULL
                AND ST_DWithin(ps.base_geo, o.location_geo, (ps.radius_km * 1000)::double precision)
              )
            )
        `;

        const topRows = await prisma.$queryRaw<
          Array<{ performerUserId: string; coverageMode: string; radiusKm: number | null; distanceKm: number | null }>
        >`
          SELECT
            srv.performer_user_id AS "performerUserId",
            ps.coverage_mode AS "coverageMode",
            ps.radius_km AS "radiusKm",
            CASE
              WHEN ps.base_geo IS NOT NULL AND o.location_geo IS NOT NULL THEN (ST_Distance(ps.base_geo, o.location_geo) / 1000.0)
              ELSE NULL
            END AS "distanceKm"
          FROM performer_services srv
          JOIN performer_settings ps ON ps.performer_user_id = srv.performer_user_id
          JOIN users u ON u.id = ps.performer_user_id
          JOIN orders o ON o.id = ${order.id}
          WHERE srv.service_category_id = o.service_category_id
            AND srv.service_subcategory_id = o.service_subcategory_id
            AND u.role = 'performer'
            AND ps.performer_user_id <> o.customer_user_id
            AND (srv.service_type_id IS NULL OR o.service_type_id IS NULL OR srv.service_type_id = o.service_type_id)
            AND (
              ps.coverage_mode = 'country'
              OR (
                ps.coverage_mode = 'radius'
                AND ps.radius_km IS NOT NULL
                AND ps.base_geo IS NOT NULL
                AND o.location_geo IS NOT NULL
                AND ST_DWithin(ps.base_geo, o.location_geo, (ps.radius_km * 1000)::double precision)
              )
            )
          ORDER BY "distanceKm" ASC NULLS LAST
          LIMIT 5
        `;

        const eligibleCount = eligibleCountRows[0]?.count != null ? Number(eligibleCountRows[0].count) : 0;
        console.info(`[api] POST /api/v1/orders match_preview requestId=${requestId} orderId=${order.id}`, {
          eligibleCount,
          top: topRows,
        });
      }

      await enqueueMatchNewOrder(order.id);
      if (process.env.NODE_ENV !== "production") {
        console.info(`[api] POST /api/v1/orders match_enqueued requestId=${requestId} orderId=${order.id}`);
      }
    }

    return ok(req, { order }, { status: 201, message: "Created" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
