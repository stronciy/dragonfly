import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";

export async function PATCH(req: Request, ctx: { params: Promise<{ notificationId: string }> }) {
  try {
    const user = await requireUser(req);
    const { notificationId } = await ctx.params;

    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
      select: { id: true, userId: true, readAt: true },
    });

    if (!notification || notification.userId !== user.id) throw new ApiError(404, "NOT_FOUND", "Сповіщення не знайдено");

    const updated = await prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: notification.readAt ?? new Date() },
      select: { id: true, readAt: true },
    });

    return ok(req, { notification: updated }, { message: "Позначено як прочитане" });
  } catch (err) {
    return fail(req, err);
  }
}
