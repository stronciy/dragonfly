import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";

const patchSchema = z
  .object({
    name: z.string().min(1).transform((s) => s.trim()).optional(),
    phone: z.string().min(5).max(32).optional(),
    email: z
      .string()
      .email()
      .transform((s) => s.trim().toLowerCase())
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Немає полів для оновлення" });

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    return ok(req, { user });
  } catch (err) {
    return fail(req, err);
  }
}

export async function PATCH(req: Request) {
  try {
    const authUser = await requireUser(req);
    const body = patchSchema.parse(await req.json());

    if (body.email && body.email !== authUser.email) {
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) throw new ApiError(409, "CONFLICT", "Цей email вже використовується");
    }

    const user = await prisma.user.update({
      where: { id: authUser.id },
      data: { name: body.name, phone: body.phone, email: body.email },
      select: { id: true, name: true, email: true, phone: true, role: true, avatarUrl: true, createdAt: true },
    });

    return ok(req, { user }, { message: "Оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
