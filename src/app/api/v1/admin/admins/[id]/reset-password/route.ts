import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { hashAdminPassword } from "@/lib/adminPassword";
import { generateTemporaryPassword } from "@/lib/adminAccounts";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

/** Новий тимчасовий пароль адміна; його старі сесії скидаються. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePanelAdmin(req, "admins.manage");
    const { id } = await ctx.params;
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashAdminPassword(temporaryPassword);

    await prisma.$transaction(async (tx) => {
      const target = await tx.admin.findUnique({ where: { id }, select: { id: true, email: true } });
      if (!target) throw new ApiError(404, "NOT_FOUND", "Адміністратора не знайдено");
      await tx.admin.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true, sessionVersion: { increment: 1 } },
      });
      await writeAuditLog(tx, req, {
        admin: actor,
        action: "admin.reset_password",
        entityType: "admin",
        entityId: id,
        after: { mustChangePassword: true },
      });
    });

    return ok(req, { temporaryPassword }, { message: "Тимчасовий пароль створено" });
  } catch (err) {
    return fail(req, err);
  }
}
