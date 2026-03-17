import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { makePage, parsePagination } from "@/lib/pagination";
import type * as Prisma from "@/generated/prisma/internal/prismaNamespace";

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
      user.role === "performer"
        ? ({ performerUserId: user.id } as const)
        : ({ customerUserId: user.id } as const);

    const where = (status === "completed"
      ? { ...baseWhere, order: { is: { status: "completed" } } }
      : status === "active"
        ? { ...baseWhere, order: { is: { status: { in: ["accepted", "confirmed", "started", "arbitration"] } } } }
        : baseWhere) as Prisma.AgreementWhereInput;

    const items = await prisma.agreement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: { order: { select: { locationLabel: true } } },
    });
    const totalCount = await prisma.agreement.count({ where });

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
