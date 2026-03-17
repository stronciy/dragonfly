import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  reason: z.string().min(3).max(5000),
  evidenceMediaIds: z.array(z.string().min(1)).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

    const canOpen =
      (user.role === "customer" && order.customerUserId === user.id) ||
      (user.role === "performer" && order.performerUserId === user.id);
    if (!canOpen) throw new ApiError(404, "NOT_FOUND", "Order not found");
    if (order.status === "cancelled") throw new ApiError(403, "FORBIDDEN", "Order cancelled");

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.arbitrationCase.findUnique({ where: { orderId } });
      if (existing) return existing;

      await tx.order.update({ where: { id: orderId }, data: { status: "arbitration" } });
      await tx.orderMatch.deleteMany({ where: { orderId } });
      await tx.orderStatusEvent.create({
        data: { orderId, fromStatus: order.status, toStatus: "arbitration", note: body.reason },
      });

      const created = await tx.arbitrationCase.create({
        data: { orderId, openedByUserId: user.id, reason: body.reason, status: "opened" },
      });

      return created;
    });

    return ok(req, { order: { id: orderId, status: "arbitration" }, case: { id: result.id, status: result.status, createdAt: result.createdAt } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
