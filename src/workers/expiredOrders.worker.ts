import { Worker } from "bullmq";
import { prisma } from "../lib/prisma";
import { getRedisConnectionOptions } from "../queues/connection";
import { ExpoPushService } from "../services/expoPush.service";
import { publishDomainEvent } from "../realtime/publishDomainEvent";
import { enqueueMatchNewOrder } from "../queues/jobs";

type ExpiredOrderJob = { orderId: string };

/**
 * Worker для автоматичної відміни просрочених замовлень
 * 
 * Запускається періодично (кожні 5 хвилин) через scheduler
 * Перевіряє замовлення зі статусом `requires_confirmation` або `accepted` у яких `depositDeadline < now`
 * 
 * При відміні:
 * 1. Переводить замовлення в `cancelled`
 * 2. Звільняє escrow lock виконавця (released)
 * 3. Відправляє Push сповіщення виконавцю про повернення коштів
 * 4. Створює запис в order_status_events
 * 5. Додає замовлення назад в marketplace
 */
export function startExpiredOrdersWorker() {
  const expo = new ExpoPushService(prisma);

  return new Worker<ExpiredOrderJob>(
    "expired-orders",
    async (job) => {
      const { orderId } = job.data;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          customerUserId: true,
          performerUserId: true,
          depositDeadline: true,
          budget: true,
          currency: true,
          locationLabel: true,
        },
      });

      if (!order) {
        process.stdout.write(
          JSON.stringify({ level: "info", msg: "expired_order_skipped", reason: "order_not_found", orderId }) + "\n"
        );
        return;
      }

      if (order.status !== "requires_confirmation" && order.status !== "accepted") {
        process.stdout.write(
          JSON.stringify({
            level: "info",
            msg: "expired_order_skipped",
            reason: "order_not_requires_confirmation",
            orderId,
            status: order.status,
          }) + "\n"
        );
        return;
      }

      if (!order.depositDeadline) {
        process.stdout.write(
          JSON.stringify({ level: "info", msg: "expired_order_skipped", reason: "no_deadline", orderId }) + "\n"
        );
        return;
      }

      const now = new Date();
      const deadline = new Date(order.depositDeadline);

      if (now < deadline) {
        process.stdout.write(
          JSON.stringify({
            level: "info",
            msg: "expired_order_skipped",
            reason: "deadline_not_reached",
            orderId,
            deadline: deadline.toISOString(),
            now: now.toISOString(),
          }) + "\n"
        );
        return;
      }

      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "expired_order_processing",
          orderId,
          deadline: deadline.toISOString(),
          now: now.toISOString(),
        }) + "\n"
      );

      // Знайти payment виконавця для повернення коштів
      const performerPayment = order.performerUserId
        ? await prisma.payment.findFirst({
            where: { orderId, userId: order.performerUserId, provider: "liqpay" },
            select: { id: true, status: true, amount: true },
          })
        : null;

      // Переводимо замовлення в cancelled
      await prisma.$transaction([
        // Змінюємо статус замовлення
        prisma.order.update({
          where: { id: orderId },
          data: { status: "cancelled", performerUserId: null, acceptedAt: null, depositDeadline: null },
        }),

        // Створюємо подію зміни статусу
        prisma.orderStatusEvent.create({
          data: {
            orderId,
            fromStatus: order.status,
            toStatus: "cancelled",
            note: "Час підтвердження заказчиком минув (12 годин) - автоматична відміна",
          },
        }),

        // Звільняємо escrow lock виконавця
        prisma.escrowLock.updateMany({
          where: { orderId, role: "performer", status: "locked" },
          data: { status: "released", releasedAt: now },
        }),

        // Видаляємо order matches (будуть створені заново)
        prisma.orderMatch.deleteMany({ where: { orderId } }),
      ]);

      // Відправляємо Push сповіщення виконавцю
      if (order.performerUserId && performerPayment) {
        const performerDevices = await prisma.device.findMany({
          where: { userId: order.performerUserId, revokedAt: null },
          select: { expoPushToken: true },
        });

        const depositAmount = Number(order.budget) * 0.1;

        // Створюємо запис в notifications
        await prisma.notification.create({
          data: {
            userId: order.performerUserId,
            type: "deposit",
            title: "Замовлення скасовано - кошти повернуто",
            message: `Замовлення #${orderId.slice(-6)} скасовано через спливання часу підтвердження. Гарантійна сума ${depositAmount} ${order.currency} повернута.`,
            data: {
              orderId,
              type: "order_expired_refund",
              role: "performer",
              depositAmount,
              currency: order.currency,
              refunded: true,
              reason: "deposit_timeout",
            },
          },
        });

        for (const device of performerDevices) {
          await expo.sendPush({
            toUserId: order.performerUserId,
            toExpoToken: device.expoPushToken,
            title: "Замовлення скасовано - кошти повернуто",
            body: `Замовлення #${orderId.slice(-6)}. Гарантійна сума повернута.`,
            data: {
              orderId,
              type: "order_expired_refund",
              role: "performer",
              depositAmount,
              currency: order.currency,
              refunded: true,
              reason: "deposit_timeout",
            },
          });
        }

        // WebSocket сигнал виконавцю
        await publishDomainEvent({
          type: "order.expired",
          targets: { userIds: [order.performerUserId] },
          data: { 
            orderId, 
            reason: "deposit_timeout",
            refundStatus: "processing",
            depositAmount,
          },
        });
      }

      // Відправляємо Push сповіщення заказчику
      const customerDevices = await prisma.device.findMany({
        where: { userId: order.customerUserId, revokedAt: null },
        select: { expoPushToken: true },
      });

      for (const device of customerDevices) {
        await expo.sendPush({
          toUserId: order.customerUserId,
          toExpoToken: device.expoPushToken,
          title: "Замовлення скасовано",
          body: `Замовлення #${orderId.slice(-6)} скасовано через спливання часу підтвердження.`,
          data: {
            orderId,
            type: "order_expired_customer",
            role: "customer",
            reason: "deposit_timeout",
          },
        });
      }

      // Створюємо notification заказчику
      await prisma.notification.create({
        data: {
          userId: order.customerUserId,
          type: "order",
          title: "Замовлення скасовано",
          message: `Замовлення #${orderId.slice(-6)} скасовано через спливання часу підтвердження. Виконавець звільнений, замовлення повернуте в біржу.`,
          data: {
            orderId,
            type: "order_expired_customer",
            role: "customer",
            reason: "deposit_timeout",
          },
        },
      });

      // Додаємо замовлення назад в біржу
      await enqueueMatchNewOrder(orderId);

      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "expired_order_completed",
          orderId,
          newStatus: "cancelled",
          performerNotified: !!order.performerUserId,
          customerNotified: true,
          reEnqueued: true,
        }) + "\n"
      );
    },
    { connection: getRedisConnectionOptions(), concurrency: 5 }
  );
}

/**
 * Планувальник: перевіряє замовлення кожні 5 хвилин
 * Використовується cron job або окремий scheduler
 */
export async function scheduleExpiredOrderChecks() {
  const now = new Date();
  
  const expiredOrders = await prisma.order.findMany({
    where: {
      status: { in: ["requires_confirmation", "accepted"] },
      depositDeadline: { lt: now },
    },
    select: { id: true },
  });

  for (const order of expiredOrders) {
    const queue = await import("../queues/queues");
    const q = queue.getExpiredOrdersQueue();
    if (q) {
      await q.add("expire", { orderId: order.id }, { jobId: `expire-${order.id}` });
    }
  }
}
