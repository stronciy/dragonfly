import { Worker } from "bullmq";
import { prisma } from "../lib/prisma";
import { getRedisConnectionOptions } from "../queues/connection";
import { ExpoPushService } from "../services/expoPush.service";

type MatchNewExecutorJob = { performerUserId: string };

export function startMatchNewExecutorWorker() {
  const expo = new ExpoPushService(prisma);

  return new Worker<MatchNewExecutorJob>(
    "match-new-executor",
    async (job) => {
      const { performerUserId } = job.data;

      const performerUser = await prisma.user.findUnique({ where: { id: performerUserId }, select: { role: true } });
      if (!performerUser || performerUser.role !== "performer") return;

      const settings = await prisma.performerSettings.findUnique({
        where: { performerUserId },
        select: { coverageMode: true, radiusKm: true },
      });

      if (!settings) return;
      if (settings.coverageMode === "radius" && !settings.radiusKm) return;

      const matches = (await prisma.$queryRaw<Array<{ order_id: string; distance_km: number }>>`
        SELECT
          o.id AS order_id,
          (ST_Distance(ps.base_geo, o.location_geo) / 1000.0) AS distance_km
        FROM orders o
        JOIN performer_settings ps
          ON ps.performer_user_id = ${performerUserId}
        JOIN performer_services psvc
          ON psvc.performer_user_id = ps.performer_user_id
        WHERE
          o.status = 'published'
          AND o.customer_user_id <> ps.performer_user_id
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
              AND ST_DWithin(ps.base_geo, o.location_geo, (ps.radius_km * 1000)::double precision)
            )
          )
        ORDER BY distance_km ASC
        LIMIT 500
      `) as Array<{ order_id: string; distance_km: number }>;

      if (matches.length === 0) return;

      await prisma.$transaction(
        matches.map((m) =>
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
        )
      );

      const tokens = (await prisma.device.findMany({
        where: { userId: performerUserId, revokedAt: null },
        select: { expoPushToken: true, userId: true },
      })) as Array<{ expoPushToken: string; userId: string }>;

      if (tokens.length === 0) return;

      await expo.sendBatch(
        tokens.map((t) => ({
          toUserId: t.userId,
          toExpoToken: t.expoPushToken,
          title: "Для вас есть новые заказы",
          body: `Найдено: ${matches.length}`,
          data: { type: "marketplace", count: matches.length },
        }))
      );
    },
    { connection: getRedisConnectionOptions(), concurrency: 10 }
  );
}
