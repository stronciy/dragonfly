import { ok, fail } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { twoFactorEnabledAt: true },
    });

    return ok(req, {
      twoFactor: {
        enabled: Boolean(dbUser?.twoFactorEnabledAt),
        method: dbUser?.twoFactorEnabledAt ? "totp" : null,
        enabledAt: dbUser?.twoFactorEnabledAt?.toISOString() ?? null,
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}

