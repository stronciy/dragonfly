import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { makePage, parsePagination } from "@/lib/pagination";

const postSchema = z.object({
  name: z.string().min(1),
  areaHa: z.number().positive(),
  addressLabel: z.string().min(1).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  points: z.any().optional(),
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
          addressLabel: true,
          lat: true,
          lng: true,
          points: true,
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
        addressLabel: f.addressLabel,
        centroid: f.lat != null && f.lng != null ? { lat: Number(f.lat), lng: Number(f.lng) } : null,
        points: f.points,
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
        addressLabel: body.addressLabel ?? null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        points: body.points ?? null,
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
