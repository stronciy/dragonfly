import { Worker } from "bullmq";
import { prisma } from "../lib/prisma";
import { getRedisConnectionOptions } from "../queues/connection";
import { ExpoPushService } from "../services/expoPush.service";
import { formatOrderDateRange } from "../lib/matching";

type MatchNewOrderJob = { orderId: string };

export function startMatchNewOrderWorker() {
  const expo = new ExpoPushService(prisma);

  return new Worker<MatchNewOrderJob>(
    "match-new-order",
    async (job) => {
      const { orderId } = job.data;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          areaHa: true,
          dateFrom: true,
          dateTo: true,
          budget: true,
          currency: true,
          locationLabel: true,
          regionName: true,
          serviceCategoryId: true,
          serviceSubCategoryId: true,
          serviceTypeId: true,
        },
      });

      if (!order || order.status !== "published") return;

      const category = await prisma.serviceCategory.findUnique({
        where: { id: order.serviceCategoryId },
        select: { name: true },
      });
      const subcategory = await prisma.serviceSubcategory.findUnique({
        where: { id: order.serviceSubCategoryId },
        select: { name: true },
      });
      const type = order.serviceTypeId
        ? await prisma.serviceType.findUnique({
            where: { subcategoryId_id: { subcategoryId: order.serviceSubCategoryId, id: order.serviceTypeId } },
            select: { name: true },
          })
        : null;

      const candidates = (await prisma.$queryRaw<
        Array<{ performer_user_id: string; distance_km: number }>
      >`
        SELECT
          ps.performer_user_id,
          (ST_Distance(ps.base_geo, o.location_geo) / 1000.0) AS distance_km
        FROM performer_settings ps
        JOIN performer_services psvc
          ON psvc.performer_user_id = ps.performer_user_id
        JOIN orders o
          ON o.id = ${orderId}
        WHERE
          o.status = 'published'
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
      `) as Array<{ performer_user_id: string; distance_km: number }>;

      if (candidates.length === 0) return;

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

      const tokens = (await prisma.device.findMany({
        where: {
          userId: { in: candidates.map((c) => c.performer_user_id) },
          revokedAt: null,
        },
        select: { expoPushToken: true, userId: true },
      })) as Array<{ expoPushToken: string; userId: string }>;

      if (tokens.length === 0) return;

      const serviceLabel = [category?.name, subcategory?.name, type?.name].filter(Boolean).join(" / ");
      const dateRange = formatOrderDateRange(order.dateFrom, order.dateTo);
      const budget = `${Number(order.budget)} ${order.currency}`;
      const location = [order.locationLabel, order.regionName].filter(Boolean).join(", ");
      const title = serviceLabel ? `Новий заказ: ${serviceLabel}` : "Новий заказ поруч";
      const body = [location, `${Number(order.areaHa)} га`, budget, dateRange].filter(Boolean).join(" • ");

      await expo.sendBatch(
        tokens.map((t) => ({
          toUserId: t.userId,
          toExpoToken: t.expoPushToken,
          title,
          body,
          data: {
            type: "marketplace",
            orderId: order.id,
            serviceCategoryId: order.serviceCategoryId,
            serviceSubCategoryId: order.serviceSubCategoryId,
            serviceTypeId: order.serviceTypeId,
            areaHa: Number(order.areaHa),
            budget: Number(order.budget),
            currency: order.currency,
            dateFrom: order.dateFrom?.toISOString() ?? null,
            dateTo: order.dateTo?.toISOString() ?? null,
            locationLabel: order.locationLabel,
            regionName: order.regionName ?? null,
          },
        }))
      );
    },
    { connection: getRedisConnectionOptions(), concurrency: 10 }
  );
}
