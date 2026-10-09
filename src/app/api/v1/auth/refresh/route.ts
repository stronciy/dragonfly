import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { sha256, signAccessToken, verifyRefreshToken } from "@/lib/auth/tokens";
import { isSecureRequest } from "@/lib/cookies";

export async function POST(req: Request) {
  try {
    // Accept the refresh token from the request body (native apps) or the
    // httpOnly cookie (browsers). Native RN fetch cannot be trusted to keep
    // and resend cross-domain httpOnly cookies.
    const body = (await req.json().catch(() => null)) as { refreshToken?: unknown } | null;
    const bodyToken =
      typeof body?.refreshToken === "string" && body.refreshToken.length > 0
        ? body.refreshToken
        : undefined;
    const cookieHeader = req.headers.get("cookie") ?? "";
    const cookieToken = cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("refreshToken="))
      ?.slice("refreshToken=".length);
    const refreshToken = bodyToken ?? cookieToken;

    if (!refreshToken) {
      const res = fail(req, new ApiError(401, "UNAUTHORIZED", "Відсутній refresh-токен"));
      res.cookies.set({
        name: "refreshToken",
        value: "",
        httpOnly: true,
        secure: isSecureRequest(req),
        sameSite: "lax",
        path: "/api/v1/auth",
        maxAge: 0,
      });
      return res;
    }

    let payload: Awaited<ReturnType<typeof verifyRefreshToken>>;
    try {
      payload = await verifyRefreshToken(refreshToken);
    } catch {
      const res = fail(req, new ApiError(401, "UNAUTHORIZED", "Недійсний refresh-токен"));
      res.cookies.set({
        name: "refreshToken",
        value: "",
        httpOnly: true,
        secure: isSecureRequest(req),
        sameSite: "lax",
        path: "/api/v1/auth",
        maxAge: 0,
      });
      return res;
    }

    const tokenHash = await sha256(refreshToken);
    const tokenRow = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { userId: true, revokedAt: true, expiresAt: true },
    });

    if (!tokenRow || tokenRow.revokedAt || tokenRow.expiresAt <= new Date()) {
      const res = fail(req, new ApiError(401, "UNAUTHORIZED", "Строк дії refresh-токена минув"));
      res.cookies.set({
        name: "refreshToken",
        value: "",
        httpOnly: true,
        secure: isSecureRequest(req),
        sameSite: "lax",
        path: "/api/v1/auth",
        maxAge: 0,
      });
      return res;
    }

    const user = await prisma.user.findUnique({
      where: { id: tokenRow.userId },
      select: { id: true, email: true, role: true },
    });

    if (!user) throw new ApiError(401, "UNAUTHORIZED", "Користувача не знайдено");
    if (payload.userId !== user.id) throw new ApiError(401, "UNAUTHORIZED", "Недійсний refresh-токен");

    const accessToken = await signAccessToken({ userId: user.id, email: user.email, role: user.role });
    return ok(req, { accessToken, refreshToken }, { status: 200, message: "Оновлено" });
  } catch (err) {
    return fail(req, err);
  }
}
