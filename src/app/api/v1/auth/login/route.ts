import bcrypt from "bcryptjs";
import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { sha256, signAccessToken, signRefreshToken } from "@/lib/auth/tokens";
import { isSecureRequest } from "@/lib/cookies";

const schema = z.object({
  email: z
    .string()
    .email()
    .transform((s) => s.trim().toLowerCase()),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true, name: true, email: true, role: true, passwordHash: true, sessionVersion: true },
    });

    if (!user) throw new ApiError(401, "UNAUTHORIZED", "Невірний логін або пароль");

    const okPassword = await bcrypt.compare(body.password, user.passwordHash);
    if (!okPassword) throw new ApiError(401, "UNAUTHORIZED", "Невірний логін або пароль");

    // Single active session: bump the version (kicks older access tokens) and
    // revoke every other refresh token, so other devices are logged out.
    const sessionVersion = (user.sessionVersion ?? 0) + 1;

    const refreshToken = await signRefreshToken({ userId: user.id, jti: crypto.randomUUID() });
    const tokenHash = await sha256(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.$transaction([
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { sessionVersion },
      }),
      prisma.refreshToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
      }),
    ]);

    const accessToken = await signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      sv: sessionVersion,
    });

    const res = ok(
      req,
      {
        accessToken,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        // Also returned for native clients that cannot rely on cross-domain
        // httpOnly cookies (RN fetch). Cookie stays for browsers.
        refreshToken,
      },
      { status: 200, message: "Вхід виконано" }
    );

    res.cookies.set({
      name: "refreshToken",
      value: refreshToken,
      httpOnly: true,
      secure: isSecureRequest(req),
      sameSite: "lax",
      path: "/api/v1/auth",
      maxAge: 7 * 24 * 60 * 60,
    });

    return res;
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
