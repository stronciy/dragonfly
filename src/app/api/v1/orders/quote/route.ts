import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";

const schema = z.object({
  serviceCategoryId: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)),
  serviceSubCategoryId: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)).optional(),
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
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");

    const rawBody = await req.json();
    if (process.env.NODE_ENV !== "production") {
      console.info(`[api] POST /api/v1/orders/quote payload requestId=${requestId}`, rawBody);
    }

    const body = schema.parse(rawBody);

    // Handle hierarchical IDs: if serviceSubCategoryId is not provided, try to infer it
    let serviceCategoryId = body.serviceCategoryId;
    let serviceSubCategoryId = body.serviceSubCategoryId;
    let serviceTypeId = body.serviceTypeId;

    // If serviceSubCategoryId is not provided, determine hierarchy from serviceCategoryId
    if (!serviceSubCategoryId) {
      const parts = serviceCategoryId.split('.');
      if (parts.length === 1) {
        // Only category provided (e.g., "1") - need to get a subcategory
        // For quote purposes, we can use the first subcategory
        const firstSubcategory = await prisma.serviceSubcategory.findFirst({
          where: { categoryId: serviceCategoryId },
          orderBy: { id: 'asc' },
          select: { id: true },
        });
        if (!firstSubcategory) {
          throw new ApiError(400, "VALIDATION_ERROR", "Для цієї категорії не знайдено підкатегорій", {
            fieldErrors: { serviceSubCategoryId: ["Немає доступних підкатегорій"] },
          });
        }
        serviceSubCategoryId = firstSubcategory.id;
        serviceTypeId = null; // Reset type since we're changing subcategory
      } else if (parts.length >= 2) {
        // Subcategory or type provided (e.g., "1.1" or "1.1.1")
        // Use the first two parts as subcategory
        serviceSubCategoryId = parts.slice(0, 2).join('.');
        
        // If 3 parts provided, it's a type ID
        if (parts.length === 3) {
          serviceTypeId = serviceCategoryId;
          serviceCategoryId = parts[0]; // Extract category from hierarchical ID
        }
      }
    }

    if (process.env.NODE_ENV !== "production") {
      console.info(`[api] POST /api/v1/orders/quote resolved IDs requestId=${requestId}`, {
        serviceCategoryId,
        serviceSubCategoryId,
        serviceTypeId,
      });
    }

    const [category, subcategory] = await prisma.$transaction([
      prisma.serviceCategory.findUnique({ where: { id: serviceCategoryId }, select: { id: true } }),
      prisma.serviceSubcategory.findUnique({
        where: { id: serviceSubCategoryId },
        select: { id: true, categoryId: true, _count: { select: { types: true } } },
      }),
    ]);
    if (!category) throw new ApiError(404, "NOT_FOUND", "Категорію послуг не знайдено");
    if (!subcategory || subcategory.categoryId !== serviceCategoryId) {
      throw new ApiError(404, "NOT_FOUND", "Підкатегорію послуг не знайдено");
    }

    const hasTypes = (subcategory._count.types ?? 0) > 0;
    const currency = "UAH";

    if (serviceTypeId == null) {
      if (hasTypes) {
        throw new ApiError(400, "VALIDATION_ERROR", "Для цієї підкатегорії потрібен serviceTypeId", {
          fieldErrors: { serviceTypeId: ["Обов'язково для цієї підкатегорії"] },
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

    if (!serviceSubCategoryId) {
      throw new ApiError(400, "VALIDATION_ERROR", "Потрібна підкатегорія послуги", {
        fieldErrors: { serviceSubCategoryId: ["Required"] },
      });
    }

    const type = await prisma.serviceType.findUnique({
      where: { subcategoryId_id: { subcategoryId: serviceSubCategoryId, id: serviceTypeId } },
    });
    if (!type) throw new ApiError(404, "NOT_FOUND", "Тип послуги не знайдено");

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
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
