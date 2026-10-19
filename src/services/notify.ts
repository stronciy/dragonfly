import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ExpoPushService } from "./expoPush.service";

export type NotifyUserResult = {
  /** Сколько активных устройств было у пользователя. */
  devices: number;
  /** Сколько отправок Expo принял без транспортной ошибки. */
  delivered: number;
  failed: number;
  error: string | null;
};

/**
 * In-app уведомление + push на все активные устройства.
 *
 * Пуш — побочный канал: ошибка транспорта не пробрасывается наружу. Иначе
 * недоступный Expo валит бизнес-действие (смену статуса, депозит, сообщение
 * админа), хотя уведомление в приложении уже создано. Вызывающий получает
 * счётчики доставки и сам решает, что показать пользователю/админу.
 */
export async function notifyUser(args: {
  userId: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
}): Promise<NotifyUserResult> {
  await prisma.notification.create({
    data: {
      userId: args.userId,
      type: args.type,
      title: args.title,
      message: args.message,
      data: args.data as unknown as Prisma.InputJsonValue,
    },
  });

  const expo = new ExpoPushService(prisma);
  const devices = await prisma.device.findMany({
    where: { userId: args.userId, revokedAt: null },
    select: { expoPushToken: true },
  });

  // Устройства шлём параллельно: последовательный цикл растягивал ответ
  // пропорционально их количеству.
  const results = await Promise.allSettled(
    devices.map((device) =>
      expo.sendPush({
        toUserId: args.userId,
        toExpoToken: device.expoPushToken,
        title: args.title,
        body: args.message,
        data: args.data,
      })
    )
  );

  const result: NotifyUserResult = {
    devices: devices.length,
    delivered: 0,
    failed: 0,
    error: null,
  };
  for (const settled of results) {
    if (settled.status === "fulfilled") {
      result.delivered += 1;
    } else {
      result.failed += 1;
      result.error ??= settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    }
  }

  if (result.failed > 0) {
    process.stdout.write(
      JSON.stringify({
        level: "warn",
        msg: "notify_push_failed",
        userId: args.userId,
        devices: result.devices,
        failed: result.failed,
        error: result.error,
      }) + "\n"
    );
  }

  return result;
}
