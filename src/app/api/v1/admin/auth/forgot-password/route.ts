import { randomInt, randomUUID } from "node:crypto";
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
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  try {
    const body = schema.parse(await req.json());
    const ip = getClientIp(req);

    console.info(
      "[admin-reset] request received",
      JSON.stringify({ requestId, email: body.email, ip })
    );

    const allowed = await checkAdminPasswordResetRateLimit(ip, body.email);
    if (!allowed) {
      console.warn(
        "[admin-reset] rate limited; no email sent",
        JSON.stringify({ requestId, email: body.email, ip })
      );
      return genericResponse(req);
    }

    const admin = await prisma.admin.findUnique({
      where: { email: body.email },
      select: { id: true, email: true, active: true },
    });
    if (!admin || !admin.active) {
      console.warn(
        "[admin-reset] active admin not found; no email sent",
        JSON.stringify({
          requestId,
          email: body.email,
          found: Boolean(admin),
          active: admin?.active ?? false,
        })
      );
      return genericResponse(req);
    }

    const code = randomInt(0, 1000000).toString().padStart(6, "0");
    const codeHash = await sha256(code);

    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await prisma.$transaction([
      prisma.adminPasswordResetToken.updateMany({
        where: { adminId: admin.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.adminPasswordResetToken.create({
        data: {
          adminId: admin.id,
          codeHash,
          expiresAt,
        },
      }),
    ]);

    console.info(
      "[admin-reset] code generated; sending email",
      JSON.stringify({
        requestId,
        adminId: admin.id,
        to: admin.email,
        expiresAt: expiresAt.toISOString(),
      })
    );

    try {
      const info = await sendAdminPasswordResetCode(admin.email, code);
      console.info(
        "[admin-reset] code email sent",
        JSON.stringify({
          requestId,
          adminId: admin.id,
          to: admin.email,
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          response: info.response,
        })
      );
    } catch (err) {
      console.error(
        "[admin-reset] code email failed",
        JSON.stringify({
          requestId,
          adminId: admin.id,
          to: admin.email,
          message: err instanceof Error ? err.message : String(err),
        })
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
      console.warn(
        "[admin-reset] validation failed",
        JSON.stringify({ requestId, issues: err.issues })
      );
      return fail(
        req,
        new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten())
      );
    }
    console.error(
      "[admin-reset] request failed",
      JSON.stringify({
        requestId,
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return fail(req, err);
  }
}
