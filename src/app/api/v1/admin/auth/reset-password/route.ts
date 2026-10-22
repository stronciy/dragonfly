import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError, prisma } from "@/shared";
import { sha256 } from "@/lib/auth/tokens";
import { hashAdminPassword } from "@/lib/adminPassword";
import { writeAuditLog } from "@/lib/adminAudit";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Некоректний email"),
  code: z.string().trim().regex(/^\d{6}$/, "Код має містити 6 цифр"),
  newPassword: z
    .string()
    .min(8, "Пароль має містити щонайменше 8 символів")
    .regex(/[A-ZА-ЯІЇЄҐ]/, "Пароль має містити щонайменше одну велику літеру")
    .regex(/\d/, "Пароль має містити щонайменше одну цифру"),
});

const MAX_ATTEMPTS = 5;

function invalidCode(req: Request) {
  return fail(
    req,
    new ApiError(400, "INVALID_CODE", "Невірний або прострочений код")
  );
}

/**
 * AUTH: finish admin password reset with the 6-digit code from email.
 *
 * The backend updates `admins.password_hash` itself because the panel's DB
 * role is read-only. The panel uses the same scrypt format, so the new password
 * works immediately in the panel login.
 */
export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const admin = await prisma.admin.findUnique({
      where: { email: body.email },
      select: {
        id: true,
        email: true,
        role: true,
        active: true,
        sessionVersion: true,
      },
    });
    if (!admin || !admin.active) return invalidCode(req);

    const token = await prisma.adminPasswordResetToken.findFirst({
      where: {
        adminId: admin.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!token) return invalidCode(req);

    const codeHash = await sha256(body.code);
    const attemptsExceeded = token.attempts >= MAX_ATTEMPTS;
    const codeMatches =
      codeHash.length === token.codeHash.length &&
      timingSafeEqual(Buffer.from(codeHash), Buffer.from(token.codeHash));

    if (attemptsExceeded || !codeMatches) {
      await prisma.adminPasswordResetToken.update({
        where: { id: token.id },
        data: { attempts: { increment: 1 } },
      });
      return invalidCode(req);
    }

    const passwordHash = await hashAdminPassword(body.newPassword);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.admin.update({
        where: { id: admin.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          sessionVersion: { increment: 1 },
        },
      });
      await tx.adminPasswordResetToken.updateMany({
        where: { adminId: admin.id, usedAt: null },
        data: { usedAt: now },
      });
      await writeAuditLog(tx, req, {
        admin: { id: admin.id, email: admin.email, role: admin.role },
        action: "admin.password_reset",
        entityType: "admin",
        entityId: admin.id,
        reason: "Відновлення пароля через email",
        after: { sessionVersion: admin.sessionVersion + 1 },
      });
    });

    return ok(req, {}, { status: 200, message: "Пароль адміністратора оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(
        req,
        new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten())
      );
    }
    return fail(req, err);
  }
}
