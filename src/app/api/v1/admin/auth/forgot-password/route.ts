import { randomInt } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError, prisma } from "@/shared";
import { sha256 } from "@/lib/auth/tokens";
import { sendAdminPasswordResetCode } from "@/lib/email";
import {
  checkAdminPasswordResetRateLimit,
  getClientIp,
} from "@/lib/middleware/resetRateLimit";

export const runtime = "nodejs";

const schema = z.object({
  email: z
    .string()
    .email("Некоректний email")
    .transform((s) => s.trim().toLowerCase()),
});

const CODE_TTL_MS = 15 * 60 * 1000;

function genericResponse(req: Request) {
  return ok(req, {}, { status: 200, message: "Якщо email існує, код надіслано" });
}

/**
 * AUTH: forgot password for the admin panel.
 *
 * This endpoint is public by design (the admin is locked out), so it must not
 * reveal whether an email belongs to an active administrator. Rate limiting is
 * shared with the app's password reset in spirit but uses its own Redis bucket.
 */
export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const allowed = await checkAdminPasswordResetRateLimit(getClientIp(req), body.email);
    if (!allowed) return genericResponse(req);

    const admin = await prisma.admin.findUnique({
      where: { email: body.email },
      select: { id: true, email: true, active: true },
    });
    if (!admin || !admin.active) return genericResponse(req);

    const code = randomInt(0, 1000000).toString().padStart(6, "0");
    const codeHash = await sha256(code);

    await prisma.$transaction([
      prisma.adminPasswordResetToken.updateMany({
        where: { adminId: admin.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.adminPasswordResetToken.create({
        data: {
          adminId: admin.id,
          codeHash,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      }),
    ]);

    try {
      await sendAdminPasswordResetCode(admin.email, code);
    } catch (err) {
      console.error(
        "[admin-reset] Не вдалося надіслати код:",
        err instanceof Error ? err.message : err
      );
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "Не вдалося надіслати лист. Перевірте налаштування SMTP.",
        undefined,
        true
      );
    }

    return genericResponse(req);
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
