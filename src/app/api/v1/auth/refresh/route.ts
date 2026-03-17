import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { sha256, signAccessToken, verifyRefreshToken } from "@/lib/auth/tokens";

export async function POST(req: Request) {
  try {
    const cookieHeader = req.headers.get("cookie") ?? "";
    const refreshToken = cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("refreshToken="))
      ?.slice("refreshToken=".length);

    if (!refreshToken) throw new ApiError(401, "UNAUTHORIZED", "Missing refresh token");

    let payload: Awaited<ReturnType<typeof verifyRefreshToken>>;
    try {
      payload = await verifyRefreshToken(refreshToken);
    } catch {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid refresh token");
    }

    const tokenHash = await sha256(refreshToken);
    const tokenRow = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { userId: true, revokedAt: true, expiresAt: true },
    });

    if (!tokenRow || tokenRow.revokedAt || tokenRow.expiresAt <= new Date()) {
      throw new ApiError(401, "UNAUTHORIZED", "Refresh token expired");
    }

    const user = await prisma.user.findUnique({
      where: { id: tokenRow.userId },
      select: { id: true, email: true, role: true },
    });

    if (!user) throw new ApiError(401, "UNAUTHORIZED", "User not found");
    if (payload.userId !== user.id) throw new ApiError(401, "UNAUTHORIZED", "Invalid refresh token");

    const accessToken = await signAccessToken({ userId: user.id, email: user.email, role: user.role });
    return ok(req, { accessToken }, { status: 200, message: "Refreshed" });
  } catch (err) {
    return fail(req, err);
  }
}
