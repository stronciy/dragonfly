import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { verify } from "otplib";

const schema = z.object({
  secret: z.string().min(1),
  code: z.string().min(6).max(8),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = schema.parse(await req.json());

    const okCode = verify({ token: body.code, secret: body.secret });
    if (!okCode) throw new ApiError(400, "VALIDATION_ERROR", "Invalid code");

    const enabledAt = new Date();
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: body.secret, twoFactorEnabledAt: enabledAt },
    });

    return ok(req, { twoFactor: { enabled: true, method: "totp", enabledAt: enabledAt.toISOString() } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}

