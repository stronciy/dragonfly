import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { makePage, parsePagination } from "@/lib/pagination";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const url = new URL(req.url);
    const { limit, offset } = parsePagination(url);

    const where = { userId: user.id };
    const [items, totalCount] = await prisma.$transaction([
      prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
      prisma.notification.count({ where }),
    ]);

    return ok(req, { items, page: makePage(limit, offset, totalCount) });
  } catch (err) {
    return fail(req, err);
  }
}
