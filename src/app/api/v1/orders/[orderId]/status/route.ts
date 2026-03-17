import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  status: z.enum(["started", "completed"]),
});

const allowedTransitions: Record<string, Array<string>> = {
  confirmed: ["started"],
  started: ["completed"],
};

export async function PATCH(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Order not found");

    const allowed = allowedTransitions[order.status] ?? [];
    if (!allowed.includes(body.status)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid status transition");

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.order.update({ where: { id: orderId }, data: { status: body.status } });
      await tx.orderStatusEvent.create({
        data: { orderId, fromStatus: order.status, toStatus: body.status, note: null },
      });
      if (body.status === "completed") {
        await tx.orderMatch.deleteMany({ where: { orderId } });
        await tx.agreement.upsert({
          where: { orderId },
          update: { performedAt: new Date(), amountTotal: u.budget, currency: u.currency, customerUserId: u.customerUserId, performerUserId: u.performerUserId! },
          create: { orderId, performedAt: new Date(), amountTotal: u.budget, currency: u.currency, customerUserId: u.customerUserId, performerUserId: u.performerUserId! },
        });
      }
      return u;
    });

    return ok(req, { order: { id: updated.id, status: updated.status } }, { message: "Status updated" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
