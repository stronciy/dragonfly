import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { makePage, parsePagination } from "@/lib/pagination";

const querySchema = z.object({
  status: z.enum(["pending", "paid", "failed"]).optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const url = new URL(req.url);
    const { limit, offset } = parsePagination(url);
    const { status } = querySchema.parse({ status: url.searchParams.get("status") ?? undefined });

    const where: any = { performerUserId: user.id };
    if (status) where.status = status;

    const [items, totalCount] = await prisma.$transaction([
      prisma.payout.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
      prisma.payout.count({ where }),
    ]);

    return ok(req, { items, page: makePage(limit, offset, totalCount) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
