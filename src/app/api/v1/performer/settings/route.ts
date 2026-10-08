import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { enqueueMatchNewExecutor } from "@/shared";
import { getSubcategoryById, getCategoryById, getTypeById, validatePerformerServiceSpecs } from "@/../services-tree";
import type { Prisma } from "@prisma/client";

// Schema for hierarchical service ID
const serviceIdSchema = z.string().regex(/^\d+(\.\d+)*$/, "Invalid service ID format");

const putSchema = z.object({
  baseLocationLabel: z.preprocess((v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v), z.string().min(1).nullable().optional()),
  baseCoordinate: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  }).nullable().optional(),
  coverage: z.object({
    mode: z.enum(["radius", "country"]),
    radiusKm: z.coerce.number().int().min(0).max(500).nullable().optional(),
  }).nullable().optional(),
  services: z.array(serviceIdSchema).min(1).nullable().optional(),
  // Equipment specs per service id, e.g. { "3.2": { "Ширина внесення штанги (м)": 30 } }.
  // Absent key = wildcard (matches anything). Present values are validated
  // against services-tree options.
  serviceSpecs: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const profile = await prisma.performerProfile.findUnique({
      where: { userId: user.id },
      select: {
        baseLocationLabel: true,
        baseLatitude: true,
        baseLongitude: true,
        coverageMode: true,
        coverageRadiusKm: true,
      },
    });

    const services = await prisma.performerService.findMany({
      where: { performerUserId: user.id },
      select: {
        serviceId: true,
        specs: true,
      },
      orderBy: { serviceId: "asc" },
    });

    const serviceSpecs: Record<string, unknown> = {};
    for (const s of services) {
      const sp = s.specs as Record<string, unknown> | null;
      if (sp && typeof sp === "object" && Object.keys(sp).length > 0) {
        serviceSpecs[s.serviceId] = sp;
      }
    }

    return ok(req, {
      settings: profile
        ? {
            baseLocationLabel: profile.baseLocationLabel,
            baseCoordinate: { lat: profile.baseLatitude, lng: profile.baseLongitude },
            coverage: { mode: profile.coverageMode, radiusKm: profile.coverageRadiusKm },
            services: services.map((s) => s.serviceId),
            serviceSpecs,
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
    const hasBaseLocation = body.baseLocationLabel !== undefined && body.baseLocationLabel !== null;
    const hasBaseCoordinate = body.baseCoordinate !== undefined && body.baseCoordinate !== null;
    const hasCoverage = body.coverage !== undefined && body.coverage !== null;
    const hasServices = body.services !== undefined && body.services !== null;

    if (!hasBaseLocation && !hasBaseCoordinate && !hasCoverage && !hasServices) {
      throw new ApiError(400, "VALIDATION_ERROR", "At least one field must be provided", {
        fieldErrors: { _: ["At least one field must be provided"] },
      });
    }

    // Validate service IDs if provided
    let validatedServices: string[] = [];
    let serviceSpecsMap: Record<string, Record<string, unknown>> = {};
    if (body.serviceSpecs != null && !hasServices) {
      throw new ApiError(400, "VALIDATION_ERROR", "services are required when serviceSpecs is provided", {
        fieldErrors: { services: ["Required when serviceSpecs is provided"] },
      });
    }
    if (hasServices && body.services) {
      // Remove duplicates
      const uniqueServices = Array.from(new Set(body.services));

      // Validate each service ID exists in hierarchy
      const invalidServices: string[] = [];
      for (const serviceId of uniqueServices) {
        // Check if the ID exists in our tree
        const category = getCategoryById(serviceId);
        const subcategory = getSubcategoryById(serviceId);
        const type = getTypeById(serviceId);

        if (!category && !subcategory && !type) {
          invalidServices.push(serviceId);
        }
      }

      if (invalidServices.length > 0) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid service IDs", {
          fieldErrors: { services: [`Invalid service IDs: ${invalidServices.join(', ')}`] },
        });
      }

      validatedServices = uniqueServices;

      // Validate per-service equipment specs (absent key = wildcard)
      serviceSpecsMap = body.serviceSpecs ?? {};
      const specErrors: string[] = [];
      for (const [serviceId, specs] of Object.entries(serviceSpecsMap)) {
        if (!uniqueServices.includes(serviceId)) {
          specErrors.push(`${serviceId}: not in services`);
          continue;
        }
        for (const e of validatePerformerServiceSpecs(serviceId, specs ?? {})) {
          specErrors.push(`${serviceId}: ${e}`);
        }
      }
      if (specErrors.length > 0) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid service specs", {
          fieldErrors: { serviceSpecs: specErrors },
        });
      }
    }

    await prisma.$transaction(async (tx) => {
      // Отримуємо поточні налаштування для часткового оновлення
      const current = await tx.performerProfile.findUnique({
        where: { userId: user.id },
        select: {
          baseLocationLabel: true,
          baseLatitude: true,
          baseLongitude: true,
          coverageMode: true,
          coverageRadiusKm: true,
        },
      });

      // Часткове оновлення profile (geo settings)
      if (hasBaseLocation || hasBaseCoordinate || hasCoverage) {
        const updateData: {
          baseLocationLabel?: string;
          baseLatitude?: number;
          baseLongitude?: number;
          coverageMode?: string;
          coverageRadiusKm?: number | null;
        } = {};

        if (hasBaseLocation) {
          updateData.baseLocationLabel = body.baseLocationLabel ?? current?.baseLocationLabel ?? "";
        }
        if (hasBaseCoordinate) {
          updateData.baseLatitude = body.baseCoordinate!.lat;
          updateData.baseLongitude = body.baseCoordinate!.lng;
        }
        if (hasCoverage) {
          updateData.coverageMode = body.coverage!.mode;
          updateData.coverageRadiusKm = body.coverage!.mode === "radius" ? (body.coverage!.radiusKm ?? null) : null;
        }

        await tx.performerProfile.upsert({
          where: { userId: user.id },
          update: updateData,
          create: {
            userId: user.id,
            baseLocationLabel: updateData.baseLocationLabel ?? "",
            baseLatitude: updateData.baseLatitude ?? 0,
            baseLongitude: updateData.baseLongitude ?? 0,
            coverageMode: updateData.coverageMode ?? "radius",
            coverageRadiusKm: updateData.coverageRadiusKm ?? 50,
            vatPayer: false,
            avgRating: 0,
            reviewCount: 0,
          },
        });
      }

      // Часткове оновлення services
      if (hasServices && validatedServices.length > 0) {
        await tx.performerService.deleteMany({ where: { performerUserId: user.id } });
        
        // Determine service level and create records
        const serviceRecords = validatedServices.map((serviceId) => {
          const parts = serviceId.split('.');
          const level = parts.length;
          return {
            performerUserId: user.id,
            serviceId,
            serviceLevel: level,
            specs: (serviceSpecsMap[serviceId] ?? {}) as Prisma.InputJsonValue,
          };
        });
        
        await tx.performerService.createMany({
          data: serviceRecords,
        });
      }
    });

    if (hasServices || hasCoverage || hasBaseCoordinate) {
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
