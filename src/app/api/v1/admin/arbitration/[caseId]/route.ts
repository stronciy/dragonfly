import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

/** Кейс з листуванням (сторони + адмін), замовленням, заставами і рішенням. */
export async function GET(req: Request, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    await requirePanelAdmin(req);
    const { caseId } = await ctx.params;

    const arbitrationCase = await prisma.arbitrationCase.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        orderId: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        openedByUserId: true,
        assigneeAdmin: { select: { id: true, email: true } },
        ruling: {
          select: {
            decision: true,
            reason: true,
            createdAt: true,
            admin: { select: { id: true, email: true } },
          },
        },
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            text: true,
            channel: true,
            createdAt: true,
            user: { select: { id: true, name: true, role: true } },
            admin: { select: { id: true, email: true } },
            media: { select: { id: true, url: true, mimeType: true, name: true } },
          },
        },
      },
    });
    if (!arbitrationCase) throw new ApiError(404, "NOT_FOUND", "Арбітражний кейс не знайдено");

    const order = await prisma.order.findUnique({
      where: { id: arbitrationCase.orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        budget: true,
        areaHa: true,
        dateFrom: true,
        dateTo: true,
        customerUserId: true,
        performerUserId: true,
        customer: { select: { id: true, name: true, phone: true } },
        escrowLocks: { select: { role: true, amount: true, status: true } },
      },
    });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    const performer = order.performerUserId
      ? await prisma.user.findUnique({
          where: { id: order.performerUserId },
          select: { id: true, name: true, phone: true },
        })
      : null;

    return ok(req, { case: arbitrationCase, order, performer });
  } catch (err) {
    return fail(req, err);
  }
}
