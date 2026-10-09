import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { signAccessToken } from "@/lib/auth/tokens";
import { prisma } from "@/shared";

const schema = z.object({
  role: z.enum(["customer", "performer"]),
});

export async function PATCH(req: Request) {
  try {
    const user = await requireUser(req);
    const body = schema.parse(await req.json());

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: user.id },
        data: { role: body.role },
        select: { id: true, name: true, email: true, role: true },
      });

      if (body.role === "customer") {
        await tx.customerProfile.upsert({
          where: { userId: user.id },
          update: {},
          create: { userId: user.id },
        });
      } else {
        await tx.performerProfile.upsert({
          where: { userId: user.id },
          update: {},
          create: { userId: user.id },
        });
      }

      return u;
    });

    const accessToken = await signAccessToken({
      userId: updated.id,
      email: updated.email,
      role: updated.role,
    });

    return ok(req, { user: updated, accessToken }, { message: "Роль оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    if (err instanceof ApiError) {
      return fail(req, err);
    }
    console.error("[PATCH /api/v1/users/me/role] Unexpected error:", err);
    return fail(req, new ApiError(500, "INTERNAL_ERROR", "Не вдалося оновити роль"));
  }
}
