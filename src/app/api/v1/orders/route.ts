import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { enqueueMatchNewOrder } from "@/queues/jobs";

const postSchema = z.object({
  serviceCategoryId: z.string().min(1),
  serviceSubCategoryId: z.string().min(1),
  serviceTypeId: z.string().min(1).nullable().optional(),
  areaHa: z.number().positive(),
  dateFrom: z.string().datetime().nullable().optional(),
  dateTo: z.string().datetime().nullable().optional(),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    addressLabel: z.string().min(1),
    regionName: z.string().min(1).optional(),
  }),
  comment: z.string().max(5000).optional(),
  budget: z.number().positive(),
  status: z.enum(["draft", "published"]).optional(),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");

    const body = postSchema.parse(await req.json());
    const status = body.status ?? "published";

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

    if (order.status === "published") {
      await enqueueMatchNewOrder(order.id);
    }

    return ok(req, { order }, { status: 201, message: "Created" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
