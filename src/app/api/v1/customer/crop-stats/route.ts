import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";

const querySchema = z.object({
  season: z.coerce.number().int().min(2000).max(2100).optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");

    const url = new URL(req.url);
    const { season } = querySchema.parse({ season: url.searchParams.get("season") ?? undefined });
    const resolvedSeason = season ?? new Date().getFullYear();

    const rows = await prisma.customerCropStat.findMany({
      where: { customerUserId: user.id, season: resolvedSeason },
      include: { crop: { select: { id: true, name: true } } },
      orderBy: { cropId: "asc" },
    });

    return ok(req, {
      season: resolvedSeason,
      items: rows.map((r) => ({
        cropId: r.crop.id,
        cropName: r.crop.name,
        areaHa: Number(r.areaHa),
        yieldT: Number(r.yieldT),
      })),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}

