import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";

const schema = z.object({
  serviceCategoryId: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)),
  serviceSubCategoryId: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)),
  serviceTypeId: z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z.string().min(1).nullable().optional()
  ),
  areaHa: z.coerce.number().positive(),
  location: z
    .object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
      regionName: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)).optional(),
    })
    .optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");

    const rawBody = await req.json();
    if (process.env.NODE_ENV !== "production") {
      console.info(`[api] POST /api/v1/orders/quote payload requestId=${requestId}`, rawBody);
    }

    const body = schema.parse(rawBody);

    const [category, subcategory] = await prisma.$transaction([
      prisma.serviceCategory.findUnique({ where: { id: body.serviceCategoryId }, select: { id: true } }),
      prisma.serviceSubcategory.findUnique({
        where: { id: body.serviceSubCategoryId },
        select: { id: true, categoryId: true, _count: { select: { types: true } } },
      }),
    ]);
    if (!category) throw new ApiError(404, "NOT_FOUND", "Service category not found");
    if (!subcategory || subcategory.categoryId !== body.serviceCategoryId) {
      throw new ApiError(404, "NOT_FOUND", "Service subcategory not found");
    }

    const hasTypes = (subcategory._count.types ?? 0) > 0;
    const currency = "UAH";

    if (body.serviceTypeId == null) {
      if (hasTypes) {
        throw new ApiError(400, "VALIDATION_ERROR", "serviceTypeId is required for this subcategory", {
          fieldErrors: { serviceTypeId: ["Required for this subcategory"] },
        });
      }

      const amount = body.areaHa * 100;
      const validUntil = new Date(Date.now() + 60 * 60 * 1000);

      return ok(req, {
        quote: {
          amount,
          currency,
          breakdown: [{ label: "Base", amount }],
          validUntil: validUntil.toISOString(),
        },
      });
    }

    const type = await prisma.serviceType.findUnique({
      where: { subcategoryId_id: { subcategoryId: body.serviceSubCategoryId, id: body.serviceTypeId } },
    });
    if (!type) throw new ApiError(404, "NOT_FOUND", "Service type not found");

    const amount = body.areaHa * 100;
    const validUntil = new Date(Date.now() + 60 * 60 * 1000);

    return ok(req, {
      quote: {
        amount,
        currency,
        breakdown: [{ label: "Base", amount }],
        validUntil: validUntil.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
