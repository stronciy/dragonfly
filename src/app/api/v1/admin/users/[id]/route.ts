import { z } from "zod";
import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { diffFields, writeAuditLog } from "@/lib/adminAudit";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z
    .string()
    .trim()
    .max(32)
    .nullable()
    .optional(),
  reason: z.string().trim().min(1).max(500),
});

/** USR-3: правка имени/телефона пользователя администратором. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const { id } = await ctx.params;

    const parsed = schema.parse(await req.json().catch(() => null));
    const reason = parsed.reason;

    const current = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, phone: true, email: true, role: true },
    });
    if (!current) throw new ApiError(404, "NOT_FOUND", "Користувача не знайдено");

    const next = {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.phone !== undefined ? { phone: parsed.phone } : {}),
    };
    if (Object.keys(next).length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "Немає що змінювати");
    }

    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: next,
        select: { id: true, name: true, phone: true, email: true, role: true },
      });
      const { before, after } = diffFields(
        { name: current.name, phone: current.phone },
        { name: user.name, phone: user.phone }
      );
      await writeAuditLog(tx, req, {
        admin,
        action: "user.update",
        entityType: "user",
        entityId: id,
        reason,
        before,
        after,
      });
      return user;
    });

    return ok(req, { user: updated }, { message: "Оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
