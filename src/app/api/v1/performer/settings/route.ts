import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { enqueueMatchNewExecutor } from "@/queues/jobs";

const serviceSchema = z.object({
  serviceCategoryId: z.string().min(1),
  serviceSubCategoryId: z.string().min(1),
  serviceTypeId: z.string().min(1).nullable().optional(),
});

const putSchema = z.object({
  baseLocationLabel: z.string().min(1),
  baseCoordinate: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  coverage: z.object({
    mode: z.enum(["radius", "country"]),
    radiusKm: z.number().int().min(0).max(500).nullable().optional(),
  }),
  services: z.array(serviceSchema).min(1),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const settings = await prisma.performerSettings.findUnique({
      where: { performerUserId: user.id },
      select: {
        baseLocationLabel: true,
        baseLat: true,
        baseLng: true,
        coverageMode: true,
        radiusKm: true,
      },
    });

    const services = await prisma.performerService.findMany({
      where: { performerUserId: user.id },
      select: {
        serviceCategoryId: true,
        serviceSubCategoryId: true,
        serviceTypeId: true,
      },
      orderBy: [{ serviceCategoryId: "asc" }, { serviceSubCategoryId: "asc" }],
    });

    return ok(req, {
      settings: settings
        ? {
            baseLocationLabel: settings.baseLocationLabel,
            baseCoordinate: { lat: Number(settings.baseLat), lng: Number(settings.baseLng) },
            coverage: { mode: settings.coverageMode, radiusKm: settings.radiusKm },
            services,
          }
        : null,
    });
  } catch (err) {
    return fail(req, err);
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const body = putSchema.parse(await req.json());
    if (body.coverage.mode === "radius" && (body.coverage.radiusKm ?? null) === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "radiusKm is required for radius mode");
    }

    await prisma.$transaction(async (tx) => {
      await tx.performerProfile.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      });

      await tx.performerSettings.upsert({
        where: { performerUserId: user.id },
        update: {
          baseLocationLabel: body.baseLocationLabel,
          baseLat: body.baseCoordinate.lat,
          baseLng: body.baseCoordinate.lng,
          coverageMode: body.coverage.mode,
          radiusKm: body.coverage.mode === "radius" ? (body.coverage.radiusKm ?? null) : null,
        },
        create: {
          performerUserId: user.id,
          baseLocationLabel: body.baseLocationLabel,
          baseLat: body.baseCoordinate.lat,
          baseLng: body.baseCoordinate.lng,
          coverageMode: body.coverage.mode,
          radiusKm: body.coverage.mode === "radius" ? (body.coverage.radiusKm ?? null) : null,
        },
      });

      await tx.performerService.deleteMany({ where: { performerUserId: user.id } });
      await tx.performerService.createMany({
        data: body.services.map((s) => ({
          performerUserId: user.id,
          serviceCategoryId: s.serviceCategoryId,
          serviceSubCategoryId: s.serviceSubCategoryId,
          serviceTypeId: s.serviceTypeId ?? null,
        })),
      });
    });

    await enqueueMatchNewExecutor(user.id);

    return ok(req, { ok: true }, { message: "Saved" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
