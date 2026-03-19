import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { verify } from "otplib";

const schema = z.object({
  code: z.string().min(6).max(8),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = schema.parse(await req.json());

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { twoFactorSecret: true, twoFactorEnabledAt: true },
    });

    if (!dbUser?.twoFactorSecret || !dbUser.twoFactorEnabledAt) {
      return ok(req, { twoFactor: { enabled: false } });
    }

    const okCode = verify({ token: body.code, secret: dbUser.twoFactorSecret });
    if (!okCode) throw new ApiError(400, "VALIDATION_ERROR", "Invalid code");

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: null, twoFactorEnabledAt: null },
    });

    return ok(req, { twoFactor: { enabled: false } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}

