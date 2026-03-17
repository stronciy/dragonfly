import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";

const schema = z.object({
  serviceCategoryId: z.string().min(1),
  serviceSubCategoryId: z.string().min(1),
  serviceTypeId: z.string().min(1).optional(),
  areaHa: z.number().positive(),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      regionName: z.string().min(1).optional(),
    })
    .optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");

    const body = schema.parse(await req.json());
    if (!body.serviceTypeId) throw new ApiError(400, "VALIDATION_ERROR", "serviceTypeId is required for quote");

    const type = await prisma.serviceType.findUnique({ where: { id: body.serviceTypeId } });
    if (!type) throw new ApiError(404, "NOT_FOUND", "Service type not found");

    const pricePerHa = Number(type.pricePerHa ?? 0);
    if (pricePerHa <= 0) throw new ApiError(503, "INTERNAL_ERROR", "Pricing not configured");

    const amount = Math.max(pricePerHa * body.areaHa, Number(type.minPrice ?? 0));
    const validUntil = new Date(Date.now() + 60 * 60 * 1000);

    return ok(req, {
      quote: {
        amount,
        currency: type.currency,
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
