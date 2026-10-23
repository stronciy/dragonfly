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

function successResponse(req: Request) {
  return ok(req, {}, { status: 200, message: "Код надіслано на email" });
}

/**
 * AUTH: forgot password.
 *
 * Свідомо розкриваємо існування акаунта (`404 EMAIL_NOT_FOUND`): користувач,
 * який ввів пошту без акаунта, інакше чекає листа, якого не буде, і не розуміє,
 * що сталося. Ціна — можливість перевіряти, чи зареєстрована пошта (email
 * enumeration). Захист: IP-ліміт (20 запитів / 15 хв) у resetRateLimit.ts,
 * тож масовий перебір з однієї адреси дорогий; коди все одно живуть 15 хв і
 * на користувача існує лише один активний токен.
 */
export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const ip = getClientIp(req);
    // Ліміт ТІЛЬКИ по IP (email-ліміт прибрано — він блокував реальних
    // користувачів під час повторних спроб). Див. resetRateLimit.ts.
    const allowed = await checkPasswordResetRateLimit(ip);
    if (!allowed) {
      // Тепер, коли ми відкрито відповідаємо про існування акаунта, мовчазний
      // 200 на ліміті виглядав би як «лист надіслано». Кажемо прямо.
      console.warn("[password-reset] rate limited; no email sent", {
        email: body.email,
        ip,
      });
      throw new ApiError(
        429,
        "TOO_MANY_REQUESTS",
        "Забагато спроб відновлення пароля. Спробуйте через 15 хвилин."
      );
    }

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true, email: true, blockedAt: true, blockedReason: true },
    });

    if (!user) {
      console.info("[password-reset] account not found", { email: body.email, ip });
      throw new ApiError(
        404,
        "EMAIL_NOT_FOUND",
        "Акаунта з такою поштою не знайдено. Перевірте email або створіть новий акаунт.",
        { email: body.email }
      );
    }

    // Заблокований акаунт не має отримувати код: інакше людина скине пароль,
    // а вхід усе одно впаде з 403. Кажемо причину одразу.
    if (user.blockedAt) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Акаунт заблоковано адміністратором. Зверніться до підтримки.",
        { reason: user.blockedReason ?? null }
      );
    }

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

    return successResponse(req);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
