import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request, ctx: { params: Promise<{ agreementId: string }> }) {
  try {
    const user = await requireUser(req);
    const { agreementId } = await ctx.params;

    const agreement = await prisma.agreement.findUnique({
      where: { id: agreementId },
      include: { documents: true, order: { select: { id: true } } },
    });

    if (!agreement) throw new ApiError(404, "NOT_FOUND", "Agreement not found");
    const allowed =
      (user.role === "customer" && agreement.customerUserId === user.id) ||
      (user.role === "performer" && agreement.performerUserId === user.id);
    if (!allowed) throw new ApiError(404, "NOT_FOUND", "Agreement not found");

    return ok(req, {
      agreement: {
        id: agreement.id,
        orderId: agreement.orderId,
        performer: null,
        lineItems: [{ label: "Total", amount: Number(agreement.amountTotal) }],
        payments: [],
        documents: agreement.documents.map((d) => ({ id: d.id, type: d.type, url: d.url })),
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
