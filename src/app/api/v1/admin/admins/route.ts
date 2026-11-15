import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { hashAdminPassword } from "@/lib/adminPassword";
import { ADMIN_ACCOUNT_SELECT, assertRole, generateTemporaryPassword } from "@/lib/adminAccounts";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(190),
  role: z.string(),
});

/** Список адміністраторів панелі (лише для суперадміна). */
export async function GET(req: Request) {
  try {
    await requirePanelAdmin(req, "admins.manage");
    const admins = await prisma.admin.findMany({
      orderBy: { createdAt: "asc" },
      select: ADMIN_ACCOUNT_SELECT,
    });
    return ok(req, { admins });
  } catch (err) {
    return fail(req, err);
  }
}

/** Новий адмін зі тимчасовим паролем. Пароль повертається лише у цій відповіді. */
export async function POST(req: Request) {
  try {
    const actor = await requirePanelAdmin(req, "admins.manage");
    const body = createSchema.parse(await req.json());
    const role = assertRole(body.role);

    const existing = await prisma.admin.findUnique({ where: { email: body.email }, select: { id: true } });
    if (existing) throw new ApiError(409, "CONFLICT", "Адміністратор з таким email уже є");

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashAdminPassword(temporaryPassword);

    const admin = await prisma.$transaction(async (tx) => {
      const created = await tx.admin.create({
        data: { email: body.email, role, passwordHash, mustChangePassword: true, active: true },
        select: ADMIN_ACCOUNT_SELECT,
      });
      await writeAuditLog(tx, req, {
        admin: actor,
        action: "admin.create",
        entityType: "admin",
        entityId: created.id,
        after: { email: created.email, role: created.role },
      });
      return created;
    });

    return ok(req, { admin, temporaryPassword }, { status: 201, message: "Адміністратора створено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Перевірте email і роль", err.flatten()));
    }
    return fail(req, err);
  }
}
