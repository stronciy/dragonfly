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
 * USR-5: завершить все сессии пользователя.
 * `sessionVersion += 1` обесценивает access-токены (проверка в `requireUser`),
 * удаление refresh-токенов не даёт продлить сессию.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const { id } = await ctx.params;
    const { reason } = schema.parse(await req.json().catch(() => null));

    const current = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, sessionVersion: true },
    });
    if (!current) throw new ApiError(404, "NOT_FOUND", "Користувача не знайдено");

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { sessionVersion: { increment: 1 } },
        select: { id: true, sessionVersion: true },
      });
      const removed = await tx.refreshToken.deleteMany({ where: { userId: id } });
      await writeAuditLog(tx, req, {
        admin,
        action: "user.revoke_sessions",
        entityType: "user",
        entityId: id,
        reason,
        before: { sessionVersion: current.sessionVersion },
        after: { sessionVersion: updated.sessionVersion, refreshTokensRemoved: removed.count },
      });
      return { sessionVersion: updated.sessionVersion, refreshTokensRemoved: removed.count };
    });

    return ok(req, { result }, { message: "Сесії завершено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
