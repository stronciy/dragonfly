import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { ApiError, prisma } from "@/shared";
import { notifyUser } from "@/services/notify";

export const runtime = "nodejs";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_paid") }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(3).max(300) }),
]);

/**
 * Обробка заявки: після банківського переказу — mark_paid, або reject з
 * причиною (кошти повертаються на баланс виконавця автоматично).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const { id } = await ctx.params;
    const body = actionSchema.parse(await req.json());

    const result = await prisma.$transaction(async (tx) => {
      const payout = await tx.payout.findUnique({ where: { id } });
      if (!payout) throw new ApiError(404, "NOT_FOUND", "Заявку не знайдено");
      if (payout.status !== "requested") {
        throw new ApiError(409, "CONFLICT", "Заявку вже оброблено");
      }
      const now = new Date();
      const nextStatus = body.action === "mark_paid" ? "paid" : "rejected";
      const updated = await tx.payout.update({
        where: { id },
        data: {
          status: nextStatus,
          processedAt: now,
          processedByAdminId: admin.id,
          rejectReason: body.action === "reject" ? body.reason : null,
        },
      });
      await writeAuditLog(tx, req, {
        admin,
        action: body.action === "mark_paid" ? "payout.mark_paid" : "payout.reject",
        entityType: "payout",
        entityId: id,
        reason: body.action === "reject" ? body.reason : null,
        before: { status: "requested", amount: Number(payout.amount) },
        after: { status: nextStatus, amount: Number(updated.amount) },
      });
      return { payout, updated };
    });

    const amount = Number(result.updated.amount).toFixed(2);
    const message =
      body.action === "mark_paid"
        ? `Кошти ${amount} ₴ перераховано на ваш рахунок.`
        : `Заявку на ${amount} ₴ відхилено: ${body.action === "reject" ? body.reason : ""}. Кошти повернуто на баланс.`;
    notifyUser({
      userId: result.payout.userId,
      type: "wallet.withdrawal_processed",
      title: body.action === "mark_paid" ? "Виведення виконано" : "Виведення відхилено",
      message,
      data: { payoutId: id, amount: Number(result.updated.amount), status: result.updated.status, action: "view_finance" },
    }).catch(() => {});

    return ok(req, { payout: { id, status: result.updated.status } }, { message: "Заявку оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірні дані", err.flatten()));
    }
    return fail(req, err);
  }
}
