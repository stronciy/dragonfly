import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { makePage, parsePagination } from "@/lib/pagination";
import { ApiError } from "@/lib/errors";

const querySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const { limit, offset } = parsePagination(url);
    const { unreadOnly } = querySchema.parse({ unreadOnly: url.searchParams.get("unreadOnly") ?? undefined });

    const where = {
      userId: user.id,
      ...(unreadOnly ? { readAt: null } : {}),
    };

    const [items, totalCount] = await prisma.$transaction([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: { id: true, title: true, message: true, type: true, createdAt: true, readAt: true },
      }),
      prisma.notification.count({ where }),
    ]);

    return ok(req, { items, page: makePage(limit, offset, totalCount) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
