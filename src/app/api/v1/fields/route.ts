import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { makePage, parsePagination } from "@/lib/pagination";

const postSchema = z.object({
  name: z.string().min(1),
  areaHa: z.number().positive(),
  regionName: z.string().min(1).optional(),
  geometry: z.any().optional(),
  centroid: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");

    const url = new URL(req.url);
    const { limit, offset } = parsePagination(url);

    const where = { ownerUserId: user.id };
    const [items, totalCount] = await prisma.$transaction([
      prisma.field.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true,
          name: true,
          areaHa: true,
          regionName: true,
          centroidLat: true,
          centroidLng: true,
          status: true,
          createdAt: true,
        },
      }),
      prisma.field.count({ where }),
    ]);

    return ok(req, {
      items: items.map((f) => ({
        id: f.id,
        name: f.name,
        areaHa: Number(f.areaHa),
        regionName: f.regionName,
        centroid: f.centroidLat != null && f.centroidLng != null ? { lat: Number(f.centroidLat), lng: Number(f.centroidLng) } : null,
        status: f.status,
        createdAt: f.createdAt,
      })),
      page: makePage(limit, offset, totalCount),
    });
  } catch (err) {
    return fail(req, err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");

    const body = postSchema.parse(await req.json());

    const field = await prisma.field.create({
      data: {
        ownerUserId: user.id,
        name: body.name,
        areaHa: body.areaHa,
        regionName: body.regionName ?? null,
        geometry: body.geometry ?? null,
        centroidLat: body.centroid?.lat ?? null,
        centroidLng: body.centroid?.lng ?? null,
      },
    });

    return ok(req, { field }, { status: 201, message: "Created" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
