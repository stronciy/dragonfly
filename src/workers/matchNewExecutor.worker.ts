import { Worker } from "bullmq";
import { prisma } from "../lib/prisma";
import { getRedisConnectionOptions } from "../queues/connection";
import { ExpoPushService } from "../services/expoPush.service";
import { publishDomainEvent } from "../realtime/publishDomainEvent";
import { getOnlineUserIds } from "../realtime/presence";

type MatchNewExecutorJob = { performerUserId: string };

export function startMatchNewExecutorWorker() {
  const expo = new ExpoPushService(prisma);

  return new Worker<MatchNewExecutorJob>(
    "match-new-executor",
    async (job) => {
      const { performerUserId } = job.data;

      const performerUser = await prisma.user.findUnique({ where: { id: performerUserId }, select: { role: true } });
      if (!performerUser || performerUser.role !== "performer") return;

      const settings = await prisma.performerProfile.findUnique({
        where: { userId: performerUserId },
        select: { coverageMode: true, radiusKm: true },
      });

      if (!settings) return;
      if (settings.coverageMode === "radius" && !settings.radiusKm) return;

      const matches = (await prisma.$queryRaw<Array<{ order_id: string; distance_km: number }>>`
        SELECT
          o.id AS order_id,
          (
            6371.0 * acos(
              least(1.0, greatest(-1.0,
                cos(radians(pp.base_lat)) * cos(radians(o.lat)) *
                cos(radians(o.lng) - radians(pp.base_lng)) +
                sin(radians(pp.base_lat)) * sin(radians(o.lat))
              ))
            )
          ) AS distance_km
        FROM orders o
        JOIN performer_profiles pp
          ON pp.user_id = ${performerUserId}
        JOIN performer_services psvc
          ON psvc.performer_user_id = pp.user_id
        WHERE
          o.status = 'published'
          AND o.customer_user_id <> pp.user_id
          AND psvc.service_category_id = o.service_category_id
          AND psvc.service_subcategory_id = o.service_subcategory_id
          AND (
            psvc.service_type_id IS NULL
            OR o.service_type_id IS NULL
            OR psvc.service_type_id = o.service_type_id
          )
          AND (
            pp.coverage_mode = 'country'
            OR (
              pp.coverage_mode = 'radius'
              AND pp.radius_km IS NOT NULL
              AND (
                6371.0 * acos(
                  least(1.0, greatest(-1.0,
                    cos(radians(pp.base_lat)) * cos(radians(o.lat)) *
                    cos(radians(o.lng) - radians(pp.base_lng)) +
                    sin(radians(pp.base_lat)) * sin(radians(o.lat))
                  ))
                )
              ) <= pp.radius_km
            )
          )
        ORDER BY distance_km ASC
        LIMIT 500
      `) as Array<{ order_id: string; distance_km: number }>;

      const existing = await prisma.orderMatch.findMany({ where: { performerUserId }, select: { orderId: true } });
      const existingIds = new Set(existing.map((m) => m.orderId));
      const nextIds = new Set(matches.map((m) => m.order_id));

      const removedOrderIds: string[] = [];
      for (const id of existingIds) {
        if (!nextIds.has(id)) removedOrderIds.push(id);
      }
      const addedOrderIds: string[] = [];
      for (const id of nextIds) {
        if (!existingIds.has(id)) addedOrderIds.push(id);
      }

      await prisma.$transaction(
        [
          ...matches.map((m) =>
            prisma.orderMatch.upsert({
              where: {
                uniq_performer_order_match: { performerUserId, orderId: m.order_id },
              },
              create: {
                performerUserId,
                orderId: m.order_id,
                distanceKm: m.distance_km,
              },
              update: { distanceKm: m.distance_km },
            })
          ),
          ...(removedOrderIds.length
            ? [
                prisma.orderMatch.deleteMany({
                  where: { performerUserId, orderId: { in: removedOrderIds } },
                }),
              ]
            : []),
        ]
      );

      if (addedOrderIds.length) {
        await publishDomainEvent({
          type: "marketplace.match_added",
          targets: { userIds: [performerUserId] },
          data: { performerUserId, orderIds: addedOrderIds },
        });
      }
      if (removedOrderIds.length) {
        await publishDomainEvent({
          type: "marketplace.match_removed",
          targets: { userIds: [performerUserId] },
          data: { performerUserId, orderIds: removedOrderIds },
        });
      }

      const tokens = (await prisma.device.findMany({
        where: { userId: performerUserId, revokedAt: null },
        select: { expoPushToken: true, userId: true },
      })) as Array<{ expoPushToken: string; userId: string }>;

      if (tokens.length === 0) return;
      if (addedOrderIds.length === 0) return;

      const online = await getOnlineUserIds([performerUserId]);
      const skipOnline = String(process.env.PUSH_SKIP_IF_ONLINE || "").toLowerCase() === "true";
      if (skipOnline && online.has(performerUserId)) return;

      try {
        await expo.sendBatch(
          tokens.map((t) => ({
            toUserId: t.userId,
            toExpoToken: t.expoPushToken,
            title: "Для вас есть новые заказы",
            body: `Найдено: ${matches.length}`,
            data: { type: "marketplace", count: matches.length },
          }))
        );
      } catch (err) {
        process.stdout.write(
          JSON.stringify({
            level: "error",
            msg: "match_new_executor_push_failed",
            performerUserId,
            error: err instanceof Error ? err.message : String(err),
          }) + "\n"
        );
      }
    },
    { connection: getRedisConnectionOptions(), concurrency: 10 }
  );
}
