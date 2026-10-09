import { ok, fail } from "@/lib/apiResponse";
import { prisma } from "@/shared";
import { sha256 } from "@/lib/auth/tokens";
import { isSecureRequest } from "@/lib/cookies";

export async function POST(req: Request) {
  try {
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

    if (refreshToken) {
      const tokenHash = await sha256(refreshToken);
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    const res = ok(req, {}, { status: 200, message: "Вихід виконано" });
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
  } catch (err) {
    return fail(req, err);
  }
}
