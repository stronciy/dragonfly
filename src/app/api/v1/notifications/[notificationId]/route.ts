import { ok, fail } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";

/**
 * DELETE /api/v1/notifications/[notificationId]
 * Видаляє одне сповіщення користувача за ID.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ notificationId: string }> }) {
  try {
    const user = await requireUser(req);
    const { notificationId } = await ctx.params;

    const deleted = await prisma.notification.deleteMany({
      where: { id: notificationId, userId: user.id },
    });

    return ok(req, { success: true, count: deleted.count }, { message: "Сповіщення видалено" });
  } catch (err) {
    return fail(req, err);
  }
}
