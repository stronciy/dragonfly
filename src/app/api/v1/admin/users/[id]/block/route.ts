import { z } from "zod";
import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

const schema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/**
 * USR-4: блокировка пользователя.
 *
 * Блокировка должна ещё и завершать активные сессии: поднимаем
 * `sessionVersion` (access-токены старых устройств перестают проходить
 * проверку в `requireUser`) и удаляем refresh-токены. Проверка `blockedAt`
 * есть в `requireUser` и на входе, поэтому блокировка не косметическая.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const { id } = await ctx.params;
    const { reason } = schema.parse(await req.json().catch(() => null));

    const current = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, blockedAt: true, sessionVersion: true },
    });
    if (!current) throw new ApiError(404, "NOT_FOUND", "Користувача не знайдено");
    if (current.blockedAt) throw new ApiError(409, "CONFLICT", "Користувача вже заблоковано");

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          blockedAt: new Date(),
          blockedReason: reason,
          sessionVersion: { increment: 1 },
        },
        select: { id: true, email: true, blockedAt: true, blockedReason: true, role: true },
      });
      await tx.refreshToken.deleteMany({ where: { userId: id } });
      await writeAuditLog(tx, req, {
        admin,
        action: "user.block",
        entityType: "user",
        entityId: id,
        reason,
        before: { blockedAt: null },
        after: { blockedAt: updated.blockedAt, blockedReason: reason },
      });
      return updated;
    });

    return ok(req, { user }, { message: "Користувача заблоковано" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
