import { z } from "zod";
import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { isEmailConfigured, sendAdminMessageEmail } from "@/lib/email";
import { notifyUser } from "@/services/notify";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

const schema = z.object({
  channel: z.enum(["push", "email", "both"]),
  title: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(2000),
  /** Если сообщение про заказ — пуш откроет его в приложении. */
  orderId: z.string().trim().max(64).optional(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Связаться с участником заказа: push (in-app + Expo) и/или email.
 *
 * Push идёт через общий `notifyUser`, поэтому сообщение появляется и в списке
 * уведомлений приложения — администратор не может «выстрелить в пустоту»,
 * даже если у пользователя сейчас нет активных устройств.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const { id } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => null));

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, role: true, blockedAt: true },
    });
    if (!user) throw new ApiError(404, "NOT_FOUND", "Користувача не знайдено");

    const title = body.title ?? "Повідомлення від Dragonfly";
    const emailAvailable = isEmailConfigured();
    if (body.channel === "email" && !emailAvailable) {
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "SMTP не налаштовано — лист не надіслано. Напишіть у push або зверніться телефоном."
      );
    }

    const delivery = {
      push: false,
      devices: 0,
      email: false,
      emailError: null as string | null,
    };

    if (body.channel !== "email") {
      delivery.devices = await prisma.device.count({
        where: { userId: user.id, revokedAt: null },
      });
      await notifyUser({
        userId: user.id,
        type: "admin_message",
        title,
        message: body.message,
        data: {
          source: "admin",
          role: user.role,
          action: "view_order",
          ...(body.orderId ? { orderId: body.orderId } : {}),
        },
      });
      delivery.push = true;
    }

    if (body.channel !== "push" && emailAvailable) {
      try {
        await sendAdminMessageEmail({ to: user.email, title, message: body.message });
        delivery.email = true;
      } catch (err) {
        delivery.emailError = err instanceof Error ? err.message : "Невідома помилка";
      }
    }

    const reason = body.reason ?? `Адмін-повідомлення: ${body.message.slice(0, 160)}`;
    await prisma.$transaction(async (tx) => {
      await writeAuditLog(tx, req, {
        admin,
        action: "user.notify",
        entityType: "user",
        entityId: user.id,
        reason,
        after: {
          channel: body.channel,
          title,
          message: body.message,
          orderId: body.orderId ?? null,
          push: delivery.push,
          devices: delivery.devices,
          email: delivery.email,
          emailError: delivery.emailError,
        },
      });
    });

    const message = [
      delivery.push
        ? delivery.devices > 0
          ? `Push: надіслано на ${delivery.devices} пристр.`
          : "Push: додано в застосунок (активних пристроїв немає)"
        : null,
      delivery.email ? "Email: надіслано" : null,
      delivery.emailError ? `Email: ${delivery.emailError}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return ok(req, { delivery }, { message: message || "Готово" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
