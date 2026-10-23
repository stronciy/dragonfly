import { randomInt } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { sha256 } from "@/lib/auth/tokens";
import { sendPasswordResetCode } from "@/lib/email";
import { checkPasswordResetRateLimit, getClientIp } from "@/lib/middleware/resetRateLimit";

const schema = z.object({
  // trim/lowercase ДО .email(), інакше "  User@Example.com " відхиляється
  // як невалідний email, хоча контракт обіцяє нормалізацію.
  email: z.string().trim().toLowerCase().email(),
});

const CODE_TTL_MS = 15 * 60 * 1000;

function genericResponse(req: Request) {
  return ok(req, {}, { status: 200, message: "Якщо email існує, код надіслано" });
}

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const ip = getClientIp(req);
    // Ліміт ТІЛЬКИ по IP (email-ліміт прибрано — він блокував реальних
    // користувачів під час повторних спроб). Див. resetRateLimit.ts.
    const allowed = await checkPasswordResetRateLimit(ip);
    if (!allowed) {
      // Відповідь навмисно така сама, але для підтримки видно, що лист
      // не пішов саме через IP-ліміт, а не через збій SMTP. Email-ліміту
      // більше немає — блокувати може лише перевищення 20 запитів з однієї
      // IP за 15 хв (захист від спам-бомб/перебору).
      console.warn("[password-reset] rate limited; no email sent", {
        email: body.email,
        ip,
      });
      return genericResponse(req);
    }

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

    // Відповідаємо одразу після збереження коду: SMTP може відповідати до
    // 10-20 с (таймаути nodemailer), а мобільний клієнт чекає лише 5 с і
    // показував би "timeout" на успішно створеному коді. sendPasswordResetCode
    // самостійно ловить помилки доставки й пише їх у лог.
    void sendPasswordResetCode(user.email, code).catch((err) => {
      console.error("[email] Не вдалося відправити код відновлення пароля:", err);
    });

    return genericResponse(req);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
