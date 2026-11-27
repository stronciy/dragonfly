import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, prisma, orderRef, customerPaymentPlan, captureCustomerInitialDeposit, emitEscrowChanged } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { notifyUser } from "@/services/notify";
import { publishWalletChanged } from "@/services/payoutEvents";
import { COMPLETION_CONFIRMED_NOTE, PART1_CONFIRMED_NOTE } from "@/lib/completionConfirmation";

const CONFIRMABLE_STATUSES = ["en_route", "started", "completed"];

/**
 * POST /api/v1/orders/:orderId/confirm-progress
 *
 * Замовник підтверджує виконання перших 30% робіт (split-замовлення). Перша
 * частина оплати списується з холду на рахунок компанії і стає доступною
 * виконавцю до виведення. Незгоду замовник оформлює арбітражем.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль Замовника");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    if (customerPaymentPlan(order.budget, order.dateFrom, order.dateTo).mode !== "split") {
      throw new ApiError(409, "CONFLICT", "Для цього замовлення проміжне підтвердження не передбачене");
    }
    if (!CONFIRMABLE_STATUSES.includes(order.status)) {
      throw new ApiError(409, "CONFLICT", "Підтвердити 30% робіт зараз неможливо");
    }

    const reached30 = await prisma.workProgressUpdate.findFirst({
      where: { orderId, percent: 30 },
      select: { id: true },
    });
    if (!reached30) throw new ApiError(409, "CONFLICT", "Виконавець ще не зафіксував 30% робіт");

    const markers = await prisma.orderStatusEvent.findMany({
      where: { orderId, note: { in: [PART1_CONFIRMED_NOTE, COMPLETION_CONFIRMED_NOTE] } },
      select: { note: true },
    });
    if (markers.length > 0) throw new ApiError(409, "CONFLICT", "30% робіт вже підтверджено");

    try {
      await captureCustomerInitialDeposit(orderId);
    } catch (e) {
      throw new ApiError(
        502,
        "BAD_GATEWAY",
        `Не вдалося списати кошти: ${e instanceof Error ? e.message : String(e)}. Спробуйте пізніше.`
      );
    }

    await prisma.orderStatusEvent.create({
      data: { orderId, status: order.status, note: PART1_CONFIRMED_NOTE },
    });

    await emitEscrowChanged({
      requestId,
      orderId,
      customerUserId: order.customerUserId,
      performerUserId: order.performerUserId,
      roles: ["performer", "customer"],
      orderStatus: order.status,
    });

    if (order.performerUserId) {
      await publishWalletChanged({ userId: order.performerUserId, orderId }).catch(() => {});
      await notifyUser({
        userId: order.performerUserId,
        type: "order",
        title: "Замовник підтвердив 30% робіт",
        message: `Замовлення ${await orderRef(orderId)}. Замовник підтвердив виконання 30% робіт — 30% вартості зараховано на баланс і доступно до виведення.`,
        data: { orderId, type: "order_part1_confirmed", role: "performer" },
      }).catch(() => {});
    }

    return ok(req, { order: { id: order.id, status: order.status, part1Confirmed: true } }, { message: "30% робіт підтверджено" });
  } catch (err) {
    return fail(req, err);
  }
}
