import bcrypt from "bcryptjs";
import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { sha256 } from "@/lib/auth/tokens";

const schema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.trim().toLowerCase()),
  code: z.string().regex(/^\d{6}$/, "Код має містити 6 цифр"),
  newPassword: z
    .string()
    .min(8, "Пароль має містити щонайменше 8 символів")
    .regex(/[A-ZА-ЯІЇЄҐ]/, "Пароль має містити щонайменше одну велику літеру")
    .regex(/\d/, "Пароль має містити щонайменше одну цифру"),
});

const MAX_ATTEMPTS = 5;

function invalidCode(req: Request) {
  return fail(req, new ApiError(400, "INVALID_CODE", "Невірний або прострочений код"));
}

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true },
    });
    if (!user) return invalidCode(req);

    const token = await prisma.passwordResetToken.findFirst({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!token) return invalidCode(req);

    const codeHash = await sha256(body.code);
    const attemptsExceeded = token.attempts >= MAX_ATTEMPTS;
    const codeMatches = codeHash === token.codeHash;

    if (attemptsExceeded || !codeMatches) {
      await prisma.passwordResetToken.update({
        where: { id: token.id },
        data: { attempts: { increment: 1 } },
      });
      return invalidCode(req);
    }

    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    const now = new Date();

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      }),
      prisma.passwordResetToken.update({
        where: { id: token.id },
        data: { usedAt: now },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    return ok(req, {}, { status: 200, message: "Пароль оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
