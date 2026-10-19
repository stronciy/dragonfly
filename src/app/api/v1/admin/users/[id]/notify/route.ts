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
 *
 * Каналы независимы: сбой пуша или почты не отменяет второй канал и не мешает
 * записать действие в журнал. В ответе — счётчики доставки по каждому каналу.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const { id } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => null));

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, role: true },
    });
    if (!user) throw new ApiError(404, "NOT_FOUND", "Користувача не знайдено");

    // Пуш с orderId открывает заказ в приложении. Чужой/несуществующий заказ
    // отправил бы пользователя не туда, поэтому проверяем принадлежность.
    if (body.orderId) {
      const order = await prisma.order.findUnique({
        where: { id: body.orderId },
        select: { customerUserId: true, performerUserId: true },
      });
      if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
      if (order.customerUserId !== user.id && order.performerUserId !== user.id) {
        throw new ApiError(400, "VALIDATION_ERROR", "Замовлення не належить цьому користувачу");
      }
    }

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
      delivered: 0,
      failed: 0,
      pushError: null as string | null,
      email: false,
      emailError: null as string | null,
    };

    if (body.channel !== "email") {
      const push = await notifyUser({
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
      delivery.devices = push.devices;
      delivery.delivered = push.delivered;
      delivery.failed = push.failed;
      delivery.pushError = push.error;
      // In-app уведомление создано в любом случае; push — только если транспорт
      // принял все отправки.
      delivery.push = push.failed === 0;
    }

    if (body.channel !== "push") {
      if (!emailAvailable) {
        // Канал «обидва»: пуш уходит, письмо — нет. Молча терять email нельзя:
        // админ должен видеть, что получателю ушло не всё.
        delivery.emailError = "SMTP не налаштовано — лист не надіслано";
      } else {
        try {
          await sendAdminMessageEmail({ to: user.email, title, message: body.message });
          delivery.email = true;
        } catch (err) {
          delivery.emailError = err instanceof Error ? err.message : "Невідома помилка";
        }
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
          delivered: delivery.delivered,
          failed: delivery.failed,
          pushError: delivery.pushError,
          email: delivery.email,
          emailError: delivery.emailError,
        },
      });
    });

    const pushMessage = delivery.push
      ? delivery.devices > 0
        ? `Push: надіслано на ${delivery.devices} пристр.`
        : "Push: додано в застосунок (активних пристроїв немає)"
      : body.channel === "email"
        ? null
        : delivery.delivered > 0
          ? `Push: доставлено на ${delivery.delivered} з ${delivery.devices} пристр.`
          : "Push: не доставлено (у застосунку повідомлення є)";

    const message = [
      pushMessage,
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
