import { z } from "zod";
import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

const schema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/** USR-4: снятие блокировки. Сессии не возвращаем — пользователь входит заново. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const { id } = await ctx.params;
    const { reason } = schema.parse(await req.json().catch(() => null));

    const current = await prisma.user.findUnique({
      where: { id },
      select: { id: true, blockedAt: true, blockedReason: true },
    });
    if (!current) throw new ApiError(404, "NOT_FOUND", "Користувача не знайдено");
    if (!current.blockedAt) throw new ApiError(409, "CONFLICT", "Користувач не заблокований");

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { blockedAt: null, blockedReason: null },
        select: { id: true, email: true, blockedAt: true, role: true },
      });
      await writeAuditLog(tx, req, {
        admin,
        action: "user.unblock",
        entityType: "user",
        entityId: id,
        reason,
        before: { blockedAt: current.blockedAt, blockedReason: current.blockedReason },
        after: { blockedAt: null, blockedReason: null },
      });
      return updated;
    });

    return ok(req, { user }, { message: "Блокування знято" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
