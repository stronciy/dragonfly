import { ok, fail } from "@/lib/apiResponse";
import { prisma } from "@/lib/prisma";
import { sha256 } from "@/lib/auth/tokens";

export async function POST(req: Request) {
  try {
    const cookieHeader = req.headers.get("cookie") ?? "";
    const refreshToken = cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("refreshToken="))
      ?.slice("refreshToken=".length);

    if (refreshToken) {
      const tokenHash = await sha256(refreshToken);
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    const res = ok(req, {}, { status: 200, message: "Logged out" });
    res.cookies.set({
      name: "refreshToken",
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/v1/auth",
      maxAge: 0,
    });

    return res;
  } catch (err) {
    return fail(req, err);
  }
}
