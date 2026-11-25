import { z } from "zod";
import { fail, getRequestId, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { customerPaymentPlan } from "@/lib/deposit";
import {
  ApiError,
  emitEscrowChanged,
  notifyUser,
  orderRef,
  prisma,
  publishDomainEvent,
  recomputePerformerRating,
  releaseEscrowForOrder,
  settleProviderHolds,
} from "@/shared";

export const runtime = "nodejs";

const schema = z
  .object({
    /** Сторона-переможець; none — спір закрито без переможця і проигравшего (ничья). */
    winner: z.enum(["customer", "performer", "none"]),
    /** true — застава програлої сторони утримується (штраф); false — обидві застави повертаються. */
    penalty: z.boolean(),
    reason: z.string().trim().min(1).max(2000),
  })
  .refine((v) => !(v.winner === "none" && v.penalty), {
    message: "Без переможця штраф не застосовується",
    path: ["penalty"],
  });

/**
 * Рішення адміністратора в арбітражі: визначає, чия сторона виграла, чи штрафувати
 * (утримати заставу програлої сторони), і закриває замовлення як `completed` через арбітраж.
 */
export async function POST(req: Request, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const admin = await requirePanelAdmin(req, "arbitration.decide");
    const requestId = getRequestId(req);
    const { caseId } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => null));

    const arbitrationCase = await prisma.arbitrationCase.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        orderId: true,
        status: true,
        ruling: { select: { id: true } },
        order: {
          select: {
            id: true,
            status: true,
            budget: true,
            dateFrom: true,
            dateTo: true,
            customerUserId: true,
            performerUserId: true,
          },
        },
      },
    });
    if (!arbitrationCase) throw new ApiError(404, "NOT_FOUND", "Арбітражний кейс не знайдено");
    if (!["open", "admin_assigned"].includes(arbitrationCase.status) || arbitrationCase.ruling) {
      throw new ApiError(409, "CONFLICT", "Кейс уже закрито рішенням");
    }
    const { order } = arbitrationCase;
    if (order.status !== "arbitration") throw new ApiError(409, "CONFLICT", "Замовлення не в арбітражі");
    if (!order.performerUserId) throw new ApiError(409, "CONFLICT", "У замовлення немає Виконавця");

    // Той самий інваріант, що й у арбітражі за згодою сторін: довгий заказ
    // закривається лише після внесення залишку 70%.
    if (customerPaymentPlan(order.budget, order.dateFrom, order.dateTo).mode === "split") {
      const part2Paid = await prisma.paymentIntent.findFirst({
        where: { orderId: order.id, role: "customer", part: 2, status: "paid" },
        select: { id: true },
      });
      if (!part2Paid) {
        throw new ApiError(409, "CONFLICT", "Залишок 70% ще не внесено — закриття можливе після оплати");
      }
    }

    const isDraw = body.winner === "none";
    const decision = isDraw ? "draw" : `${body.winner}_wins${body.penalty ? "_penalty" : ""}`;
    const winnerLabel = isDraw
      ? "без переможця (спір закрито за згодою)"
      : body.winner === "customer"
        ? "на боці Замовника"
        : "на боці Виконавця";
    const now = new Date();

    // Куди йдуть кошти кожної сторони. Для замовника released = списання на
    // рахунок компанії (оплата виконавцю), refunded = повернення замовнику.
    // Для виконавця released = розблокування застави, forfeited = штраф.
    const settlements: Array<{ role: "customer" | "performer"; to: "released" | "refunded" | "forfeited" }> =
      body.winner === "customer"
        ? [
            { role: "customer", to: "refunded" },
            { role: "performer", to: body.penalty ? "forfeited" : "released" },
          ]
        : body.winner === "performer"
          ? [
              { role: "customer", to: body.penalty ? "forfeited" : "released" },
              { role: "performer", to: "released" },
            ]
          : [
              { role: "customer", to: "released" },
              { role: "performer", to: "released" },
            ];

    await prisma.$transaction(async (tx) => {
      await tx.arbitrationRuling.create({
        data: {
          arbitrationCaseId: caseId,
          adminId: admin.id,
          decision,
          reason: body.reason,
        },
      });
      await tx.arbitrationCase.update({
        where: { id: caseId },
        data: { status: "resolved", resolvedAt: now, assigneeAdminId: admin.id },
      });
      await tx.order.update({
        where: { id: order.id },
        data: { status: "completed", completedAt: now },
      });
      await tx.orderStatusEvent.create({
        data: {
          orderId: order.id,
          status: "completed",
          note: `Арбітраж закрито рішенням адміністратора ${winnerLabel}${body.penalty ? " зі штрафом" : ""}: ${body.reason}`,
        },
      });
      await tx.orderMatch.deleteMany({ where: { orderId: order.id } });

      for (const s of settlements) {
        await releaseEscrowForOrder(tx, { orderId: order.id, role: s.role, to: s.to });
      }

      await writeAuditLog(tx, req, {
        admin,
        action: "arbitration.ruling",
        entityType: "arbitration_case",
        entityId: caseId,
        reason: body.reason,
        before: { status: arbitrationCase.status },
        after: { status: "resolved", decision },
      });
    });

    for (const s of settlements) {
      await settleProviderHolds({ orderId: order.id, role: s.role, to: s.to }).catch(() => {});
    }

    await recomputePerformerRating(order.performerUserId).catch(() => {});

    await emitEscrowChanged({
      requestId,
      orderId: order.id,
      customerUserId: order.customerUserId,
      performerUserId: order.performerUserId,
      roles: ["performer", "customer"],
      orderStatus: "completed",
    });

    const number = await orderRef(order.id);
    const outcome =
      body.penalty && !isDraw
        ? `Рішення ${winnerLabel}, застава іншої сторони утримана.`
        : `Рішення ${winnerLabel}, застави повернуто.`;
    for (const userId of [order.customerUserId, order.performerUserId]) {
      await notifyUser({
        userId,
        type: "arbitration",
        title: "Арбітраж завершено",
        message: `Замовлення ${number}. ${outcome}`,
        data: { orderId: order.id, type: "arbitration_resolved", caseId, decision, action: "view_order" },
      });
    }

    await publishDomainEvent({
      type: "arbitration.resolved",
      requestId,
      targets: { userIds: [order.customerUserId, order.performerUserId] },
      data: { orderId: order.id, caseId, decision },
    });

    return ok(req, { decision }, { message: "Рішення збережено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Некоректне рішення", err.flatten()));
    }
    return fail(req, err);
  }
}
