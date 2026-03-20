import bcrypt from "bcryptjs";
import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  name: z.string().min(1).transform((s) => s.trim()),
  email: z
    .string()
    .email()
    .transform((s) => s.trim().toLowerCase()),
  password: z.string().min(6),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());

    const existing = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } });
    if (existing) throw new ApiError(409, "CONFLICT", "Email already in use");

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

    return ok(req, { user }, { status: 201, message: "Registered" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
