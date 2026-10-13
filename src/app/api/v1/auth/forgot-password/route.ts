import { randomInt } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { sha256 } from "@/lib/auth/tokens";
import { sendPasswordResetCode } from "@/lib/email";
import { checkPasswordResetRateLimit, getClientIp } from "@/lib/middleware/resetRateLimit";

const schema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.trim().toLowerCase()),
});

const CODE_TTL_MS = 15 * 60 * 1000;

function genericResponse(req: Request) {
  return ok(req, {}, { status: 200, message: "Якщо email існує, код надіслано" });
}

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const allowed = await checkPasswordResetRateLimit(getClientIp(req), body.email);
    if (!allowed) return genericResponse(req);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true, email: true },
    });
    if (!user) return genericResponse(req);

    const code = randomInt(0, 1000000).toString().padStart(6, "0");
    const codeHash = await sha256(code);

    await prisma.$transaction([
      prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.passwordResetToken.create({
        data: { userId: user.id, codeHash, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
      }),
    ]);

    await sendPasswordResetCode(user.email, code);

    return genericResponse(req);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
