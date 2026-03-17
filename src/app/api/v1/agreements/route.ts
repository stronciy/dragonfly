import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { makePage, parsePagination } from "@/lib/pagination";

const querySchema = z.object({
  status: z.enum(["active", "completed"]).optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const { limit, offset } = parsePagination(url);
    const { status } = querySchema.parse({ status: url.searchParams.get("status") ?? undefined });

    const baseWhere =
      user.role === "performer" ? { performerUserId: user.id } : { customerUserId: user.id };

    const where =
      status === "completed"
        ? { ...baseWhere, order: { status: "completed" as const } }
        : status === "active"
          ? { ...baseWhere, order: { status: { in: ["accepted", "confirmed", "started", "arbitration"] as const } } }
          : baseWhere;

    const [items, totalCount] = await prisma.$transaction([
      prisma.agreement.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: { order: { select: { locationLabel: true } } },
      }),
      prisma.agreement.count({ where }),
    ]);

    return ok(req, {
      items: items.map((a) => ({
        id: a.id,
        orderId: a.orderId,
        title: a.order.locationLabel,
        amountTotal: Number(a.amountTotal),
        currency: a.currency,
        performedAt: a.performedAt,
        documents: [],
      })),
      page: makePage(limit, offset, totalCount),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
