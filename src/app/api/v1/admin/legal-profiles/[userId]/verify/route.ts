import { z } from "zod";
import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { ApiError, notifyUser, prisma } from "@/shared";

export const runtime = "nodejs";

const schema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * USR-6: подтверждение юридических данных исполнителя.
 *
 * Панель сверяет реквизиты (ЄДРПОУ/IBAN) с реестром вручную и ставит отметку.
 * Повторная отметка — конфликт: журнал должен однозначно показывать, кто и
 * когда подтвердил. Причина необязательна, но попадает в журнал, если указана.
 */
export async function POST(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const { userId } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => ({})));
    const reason = body.reason?.trim() || null;

    const profile = await prisma.legalProfile.findUnique({
      where: { userId },
      select: { id: true, verifiedAt: true },
    });
    if (!profile) {
      throw new ApiError(404, "NOT_FOUND", "Юридичні дані не заповнені");
    }
    if (profile.verifiedAt) {
      throw new ApiError(409, "CONFLICT", "Юридичні дані вже підтверджено");
    }

    const verifiedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.legalProfile.update({
        where: { userId },
        data: { verifiedAt, verifiedByUserId: admin.id },
      });
      await writeAuditLog(tx, req, {
        admin,
        action: "legal.verify",
        entityType: "user",
        entityId: userId,
        reason,
        before: { verifiedAt: null },
        after: { verifiedAt: verifiedAt.toISOString() },
      });
    });

    // Уведомление — побочный канал: сбой доставки не должен отменять отметку.
    await Promise.allSettled([
      notifyUser({
        userId,
        type: "profile",
        title: "Юридичні дані підтверджено",
        message: "Адміністратор підтвердив ваші юридичні дані.",
        data: { type: "legal_verified" },
      }),
    ]);

    return ok(
      req,
      { verifiedAt: verifiedAt.toISOString() },
      { message: "Юридичні дані підтверджено" }
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
