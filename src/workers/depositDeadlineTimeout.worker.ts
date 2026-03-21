import { Worker } from "bullmq";
import { prisma } from "../lib/prisma";
import { getRedisConnectionOptions } from "../queues/connection";
import { ExpoPushService } from "../services/expoPush.service";
import { publishDomainEvent } from "../realtime/publishDomainEvent";

type DepositDeadlineTimeoutJob = { orderId: string };

/**
 * Worker для обробки тайм-ауту депозиту (12 годин)
 * 
 * Запускається періодично (кожні 5 хвилин) через cron job
 * Перевіряє замовлення зі статусом `requires_confirmation` у яких `depositDeadline < now`
 * 
 * При тайм-ауті:
 * 1. Переводить замовлення в `published` (або `cancelled` за бізнес-правилом)
 * 2. Звільняє escrow lock виконавця (released)
 * 3. Видаляє order matches
 * 4. Відправляє Push сповіщення виконавцю і заказчику
 * 5. Створює запис в order_status_events
 */
export function startDepositDeadlineTimeoutWorker() {
  const expo = new ExpoPushService(prisma);

  return new Worker<DepositDeadlineTimeoutJob>(
    "deposit-deadline-timeout",
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
          JSON.stringify({ level: "info", msg: "deposit_timeout_skipped", reason: "order_not_found", orderId }) + "\n"
        );
        return;
      }

      if (order.status !== "requires_confirmation") {
        process.stdout.write(
          JSON.stringify({
            level: "info",
            msg: "deposit_timeout_skipped",
            reason: "order_not_requires_confirmation",
            orderId,
            status: order.status,
          }) + "\n"
        );
        return;
      }

      if (!order.depositDeadline) {
        process.stdout.write(
          JSON.stringify({ level: "info", msg: "deposit_timeout_skipped", reason: "no_deadline", orderId }) + "\n"
        );
        return;
      }

      const now = new Date();
      const deadline = new Date(order.depositDeadline);

      if (now < deadline) {
        process.stdout.write(
          JSON.stringify({
            level: "info",
            msg: "deposit_timeout_skipped",
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
          msg: "deposit_timeout_processing",
          orderId,
          deadline: deadline.toISOString(),
          now: now.toISOString(),
        }) + "\n"
      );

      // Переводимо замовлення в published (повертаємо в біржу)
      // Або можна в cancelled за бізнес-правилом
      const newStatus = "published";

      await prisma.$transaction([
        // Змінюємо статус замовлення
        prisma.order.update({
          where: { id: orderId },
          data: { status: newStatus, performerUserId: null, acceptedAt: null, depositDeadline: null },
        }),

        // Створюємо подію зміни статусу
        prisma.orderStatusEvent.create({
          data: {
            orderId,
            fromStatus: "requires_confirmation",
            toStatus: newStatus,
            note: "Час підтвердження заказчиком минув (12 годин)",
          },
        }),

        // Звільняємо escrow lock виконавця
        prisma.escrowLock.updateMany({
          where: { orderId, role: "performer", status: "locked" },
          data: { status: "released", releasedAt: now },
        }),

        // Видаляємо order matches (щоб з'явився в біржі знову)
        prisma.orderMatch.deleteMany({ where: { orderId } }),
      ]);

      // Відправляємо Push сповіщення виконавцю
      if (order.performerUserId) {
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
            title: "Час підтвердження минув",
            message: `Замовлення #${orderId.slice(-6)}. Заказчик не підтвердив вчасно. Гарантійна сума ${depositAmount} ${order.currency} повернута.`,
            data: {
              orderId,
              type: "deposit_timeout",
              role: "performer",
              depositAmount,
              currency: order.currency,
              refunded: true,
            },
          },
        });

        for (const device of performerDevices) {
          await expo.sendPush({
            toUserId: order.performerUserId,
            toExpoToken: device.expoPushToken,
            title: "Час підтвердження минув",
            body: `Замовлення #${orderId.slice(-6)}. Гарантійна сума повернута.`,
            data: {
              orderId,
              type: "deposit_timeout",
              role: "performer",
              depositAmount,
              currency: order.currency,
              refunded: true,
            },
          });
        }

        // WebSocket сигнал виконавцю
        await publishDomainEvent({
          type: "deposit.timeout",
          targets: { userIds: [order.performerUserId] },
          data: { orderId, refunded: true, depositAmount },
        });
      }

      // Відправляємо Push сповіщення заказчику (нагадування)
      const customerDevices = await prisma.device.findMany({
        where: { userId: order.customerUserId, revokedAt: null },
        select: { expoPushToken: true },
      });

      for (const device of customerDevices) {
        await expo.sendPush({
          toUserId: order.customerUserId,
          toExpoToken: device.expoPushToken,
          title: "Замовлення не підтверджено",
          body: `Замовлення #${orderId.slice(-6)} повернуте в біржу. Виконавець звільнений.`,
          data: {
            orderId,
            type: "deposit_timeout_customer",
            role: "customer",
          },
        });
      }

      // Створюємо notification заказчику
      await prisma.notification.create({
        data: {
          userId: order.customerUserId,
          type: "order",
          title: "Замовлення не підтверджено",
          message: `Замовлення #${orderId.slice(-6)} повернуте в біржу. Виконавець звільнений через спливання часу підтвердження.`,
          data: {
            orderId,
            type: "order_timeout",
            role: "customer",
          },
        },
      });

      // Якщо замовлення повертається в біржу - створюємо нові matches
      if (newStatus === "published") {
        const candidates = (await prisma.$queryRaw<
          Array<{ performer_user_id: string; distance_km: number }>
        >`
          SELECT
            ps.performer_user_id,
            (
              6371.0 * acos(
                least(1.0, greatest(-1.0,
                  cos(radians(ps.base_lat)) * cos(radians(o.lat)) *
                  cos(radians(o.lng) - radians(ps.base_lng)) +
                  sin(radians(ps.base_lat)) * sin(radians(o.lat))
                ))
              )
            ) AS distance_km
          FROM performer_settings ps
          JOIN users u ON u.id = ps.performer_user_id
          JOIN performer_services psvc ON psvc.performer_user_id = ps.performer_user_id
          JOIN orders o ON o.id = ${orderId}
          WHERE
            o.status = 'published'
            AND u.role = 'performer'
            AND ps.performer_user_id <> o.customer_user_id
            AND psvc.service_category_id = o.service_category_id
            AND psvc.service_subcategory_id = o.service_subcategory_id
            AND (
              psvc.service_type_id IS NULL
              OR o.service_type_id IS NULL
              OR psvc.service_type_id = o.service_type_id
            )
            AND (
              ps.coverage_mode = 'country'
              OR (
                ps.coverage_mode = 'radius'
                AND ps.radius_km IS NOT NULL
                AND (
                  6371.0 * acos(
                    least(1.0, greatest(-1.0,
                      cos(radians(ps.base_lat)) * cos(radians(o.lat)) *
                      cos(radians(o.lng) - radians(ps.base_lng)) +
                      sin(radians(ps.base_lat)) * sin(radians(o.lat))
                    ))
                  )
                ) <= ps.radius_km
              )
            )
          ORDER BY distance_km ASC
          LIMIT 500
        `) as Array<{ performer_user_id: string; distance_km: number }>;

        if (candidates.length > 0) {
          await prisma.$transaction(
            candidates.map((c) =>
              prisma.orderMatch.upsert({
                where: {
                  uniq_performer_order_match: {
                    performerUserId: c.performer_user_id,
                    orderId,
                  },
                },
                create: {
                  performerUserId: c.performer_user_id,
                  orderId,
                  distanceKm: c.distance_km,
                },
                update: { distanceKm: c.distance_km },
              })
            )
          );

          // WebSocket сигнал про новий match
          await publishDomainEvent({
            type: "marketplace.match_added",
            targets: { userIds: candidates.map((c) => c.performer_user_id) },
            data: { orderId },
          });
        }
      }

      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "deposit_timeout_completed",
          orderId,
          newStatus,
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
export async function scheduleDepositDeadlineTimeoutChecks() {
  const overdueOrders = await prisma.order.findMany({
    where: {
      status: "requires_confirmation",
      depositDeadline: {
        lt: new Date(),
      },
    },
    select: { id: true },
  });

  for (const order of overdueOrders) {
    const queue = await import("../queues/queues");
    const q = queue.getDepositDeadlineTimeoutQueue();
    if (q) {
      await q.add("timeout", { orderId: order.id }, { jobId: `timeout-${order.id}` });
    }
  }
}
