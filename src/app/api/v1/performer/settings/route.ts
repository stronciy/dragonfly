import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { enqueueMatchNewExecutor } from "@/queues/jobs";

const serviceSchema = z.object({
  serviceCategoryId: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)),
  serviceSubCategoryId: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1)),
  serviceTypeId: z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z.string().min(1).nullable().optional()
  ),
});

const putSchema = z.object({
  baseLocationLabel: z.preprocess((v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v), z.string().min(1).nullable().optional()),
  baseCoordinate: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  }).optional(),
  coverage: z.object({
    mode: z.enum(["radius", "country"]),
    radiusKm: z.coerce.number().int().min(0).max(500).nullable().optional(),
  }).optional(),
  services: z.array(serviceSchema).min(1).optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const profile = await prisma.performerProfile.findUnique({
      where: { userId: user.id },
      select: {
        baseLocation: true,
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
      settings: profile
        ? {
            baseLocationLabel: profile.baseLocation,
            baseCoordinate: { lat: Number(profile.baseLat), lng: Number(profile.baseLng) },
            coverage: { mode: profile.coverageMode, radiusKm: profile.radiusKm },
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
    
    // Перевірка: coverage.mode = radius вимагає radiusKm
    if (body.coverage?.mode === "radius" && (body.coverage.radiusKm ?? null) === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "radiusKm is required for radius mode", {
        fieldErrors: { "coverage.radiusKm": ["Required for radius mode"] },
      });
    }
    
    // Перевірка: хоча б одне поле має бути заповнено
    const hasBaseLocation = body.baseLocationLabel !== undefined && body.baseLocationLabel !== null;
    const hasBaseCoordinate = body.baseCoordinate !== undefined;
    const hasCoverage = body.coverage !== undefined;
    const hasServices = body.services !== undefined;
    
    if (!hasBaseLocation && !hasBaseCoordinate && !hasCoverage && !hasServices) {
      throw new ApiError(400, "VALIDATION_ERROR", "At least one field must be provided", {
        fieldErrors: { _: ["At least one field must be provided"] },
      });
    }

    await prisma.$transaction(async (tx) => {
      // Отримуємо поточні налаштування для часткового оновлення
      const current = await tx.performerProfile.findUnique({
        where: { userId: user.id },
        select: {
          baseLocation: true,
          baseLat: true,
          baseLng: true,
          coverageMode: true,
          radiusKm: true,
        },
      });

      // Часткове оновлення profile (geo settings)
      if (hasBaseLocation || hasBaseCoordinate || hasCoverage) {
        const updateData: {
          baseLocation?: string;
          baseLat?: number;
          baseLng?: number;
          coverageMode?: "radius" | "country";
          radiusKm?: number | null;
        } = {};

        if (hasBaseLocation) {
          updateData.baseLocation = body.baseLocationLabel ?? current?.baseLocation ?? "";
        }
        if (hasBaseCoordinate) {
          updateData.baseLat = body.baseCoordinate!.lat;
          updateData.baseLng = body.baseCoordinate!.lng;
        }
        if (hasCoverage) {
          updateData.coverageMode = body.coverage!.mode;
          updateData.radiusKm = body.coverage!.mode === "radius" ? (body.coverage!.radiusKm ?? null) : null;
        }

        await tx.performerProfile.upsert({
          where: { userId: user.id },
          update: updateData,
          create: {
            userId: user.id,
            baseLocation: updateData.baseLocation ?? "",
            baseLat: updateData.baseLat ?? 0,
            baseLng: updateData.baseLng ?? 0,
            coverageMode: updateData.coverageMode ?? "country",
            radiusKm: updateData.radiusKm ?? null,
          },
        });
      }

      // Часткове оновлення services
      if (hasServices && body.services) {
        await tx.performerService.deleteMany({ where: { performerUserId: user.id } });
        await tx.performerService.createMany({
          data: body.services.map((s) => ({
            performerUserId: user.id,
            serviceCategoryId: s.serviceCategoryId,
            serviceSubCategoryId: s.serviceSubCategoryId,
            serviceTypeId: s.serviceTypeId ?? null,
          })),
        });
      }
    });

    if (body.services !== undefined || body.coverage !== undefined || body.baseCoordinate !== undefined) {
      await enqueueMatchNewExecutor(user.id);
    }

    return ok(req, { ok: true }, { message: "Saved" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
