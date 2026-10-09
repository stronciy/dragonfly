import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";

export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { paymentIntentId } = await ctx.params;

    const intent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { order: { select: { customerUserId: true, performerUserId: true } } },
    });
    if (!intent) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");

    const isParty =
      intent.order.customerUserId === user.id || intent.order.performerUserId === user.id;
    if (!isParty) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");

    if (intent.status === "paid") {
      throw new ApiError(409, "CONFLICT", "Оплату вже проведено, скасувати неможливо");
    }
    if (intent.status === "pending") {
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: "pending" },
        data: { status: "cancelled" },
      });
    }

    return ok(req, { paymentIntent: { id: intent.id, status: intent.status === "pending" ? "cancelled" : intent.status } }, {
      message: "OK",
    });
  } catch (err) {
    return fail(req, err);
  }
}
