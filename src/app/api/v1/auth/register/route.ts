import bcrypt from "bcryptjs";
import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { sha256, signAccessToken, signRefreshToken } from "@/lib/auth/tokens";
import { isSecureRequest } from "@/lib/cookies";

const schema = z.object({
  name: z.string().min(1).transform((s) => s.trim()),
  email: z
    .string()
    .email()
    .transform((s) => s.trim().toLowerCase()),
  password: z
    .string()
    .min(8, "Пароль має містити щонайменше 8 символів")
    .regex(/[A-ZА-ЯІЇЄҐ]/, "Пароль має містити щонайменше одну велику літеру")
    .regex(/\d/, "Пароль має містити щонайменше одну цифру"),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const existing = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } });
    if (existing) throw new ApiError(409, "CONFLICT", "Цей email вже використовується");

    const passwordHash = await bcrypt.hash(body.password, 12);

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: body.name,
          email: body.email,
          passwordHash,
          role: "customer",
          customerProfile: { create: {} },
        },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
      });

      return created;
    });

    const accessToken = await signAccessToken({ userId: user.id, email: user.email, role: user.role, sv: 0 });
    const refreshToken = await signRefreshToken({ userId: user.id, jti: crypto.randomUUID() });
    const tokenHash = await sha256(refreshToken);
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    });

    const res = ok(
      req,
      { user, accessToken, refreshToken },
      { status: 201, message: "Зареєстровано" }
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
