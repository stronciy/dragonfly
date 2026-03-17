import bcrypt from "bcryptjs";
import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { sha256, signAccessToken, signRefreshToken } from "@/lib/auth/tokens";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true, name: true, email: true, role: true, passwordHash: true },
    });

    if (!user) throw new ApiError(401, "UNAUTHORIZED", "Invalid credentials");

    const okPassword = await bcrypt.compare(body.password, user.passwordHash);
    if (!okPassword) throw new ApiError(401, "UNAUTHORIZED", "Invalid credentials");

    const accessToken = await signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = await signRefreshToken({ userId: user.id, jti: crypto.randomUUID() });
    const tokenHash = await sha256(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    const res = ok(
      req,
      { accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } },
      { status: 200, message: "Logged in" }
    );

    const isProd = process.env.NODE_ENV === "production";
    res.cookies.set({
      name: "refreshToken",
      value: refreshToken,
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/api/v1/auth",
      maxAge: 7 * 24 * 60 * 60,
    });

    return res;
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
