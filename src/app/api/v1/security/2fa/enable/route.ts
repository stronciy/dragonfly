import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { verify } from "otplib";

const schema = z.object({
  setupId: z.string().min(1),
  code: z.string().min(6).max(8),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = schema.parse(await req.json());

    const setup = await prisma.twoFactorSetup.findUnique({
      where: { id: body.setupId },
      select: { id: true, userId: true, secret: true, expiresAt: true, consumedAt: true },
    });

    if (!setup || setup.userId !== user.id) throw new ApiError(404, "NOT_FOUND", "Setup not found");
    if (setup.consumedAt) throw new ApiError(409, "CONFLICT", "Setup already used");
    if (setup.expiresAt <= new Date()) throw new ApiError(409, "CONFLICT", "Setup expired");

    const okCode = verify({ token: body.code, secret: setup.secret });
    if (!okCode) throw new ApiError(400, "VALIDATION_ERROR", "Invalid code");

    const enabledAt = new Date();
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { twoFactorSecret: setup.secret, twoFactorEnabledAt: enabledAt },
      }),
      prisma.twoFactorSetup.update({ where: { id: setup.id }, data: { consumedAt: enabledAt } }),
    ]);

    return ok(req, { twoFactor: { enabled: true, method: "totp", enabledAt: enabledAt.toISOString() } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}

