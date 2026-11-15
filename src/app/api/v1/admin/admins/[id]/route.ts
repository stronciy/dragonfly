import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { ADMIN_ACCOUNT_SELECT, assertNotLastActiveSuperadmin, assertNotSelf, assertRole } from "@/lib/adminAccounts";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

const updateSchema = z
  .object({
    role: z.string().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.active !== undefined, { message: "Немає змін" });

/** Зміна ролі або вимкнення/увімкнення адміна. Вимкнення скидає всі його сесії. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePanelAdmin(req, "admins.manage");
    const { id } = await ctx.params;
    const body = updateSchema.parse(await req.json());
    const nextRole = body.role !== undefined ? assertRole(body.role) : undefined;

    assertNotSelf(actor, id);

    const updated = await prisma.$transaction(async (tx) => {
      const target = await tx.admin.findUnique({
        where: { id },
        select: { id: true, email: true, role: true, active: true, sessionVersion: true },
      });
      if (!target) throw new ApiError(404, "NOT_FOUND", "Адміністратора не знайдено");

      const demotes = nextRole !== undefined && nextRole !== "superadmin" && target.role === "superadmin";
      const deactivates = body.active === false && target.active;
      if ((demotes || deactivates) && target.role === "superadmin" && target.active) {
        await assertNotLastActiveSuperadmin(tx, id);
      }

      const data: { role?: string; active?: boolean; sessionVersion?: { increment: number } } = {};
      if (nextRole !== undefined) data.role = nextRole;
      if (body.active !== undefined) data.active = body.active;
      if (deactivates) data.sessionVersion = { increment: 1 };

      const result = await tx.admin.update({ where: { id }, data, select: ADMIN_ACCOUNT_SELECT });

      await writeAuditLog(tx, req, {
        admin: actor,
        action: nextRole !== undefined ? "admin.update_role" : body.active ? "admin.activate" : "admin.deactivate",
        entityType: "admin",
        entityId: id,
        before: { role: target.role, active: target.active },
        after: { role: result.role, active: result.active },
      });
      return result;
    });

    return ok(req, { admin: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", err.issues[0]?.message ?? "Помилка валідації", err.flatten()));
    }
    return fail(req, err);
  }
}
