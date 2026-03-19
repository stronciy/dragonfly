"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMatchNewOrderWorker = startMatchNewOrderWorker;
const bullmq_1 = require("bullmq");
const expo_server_sdk_1 = require("expo-server-sdk");
const prisma_1 = require("../lib/prisma");
const connection_1 = require("../queues/connection");
const expoPush_service_1 = require("../services/expoPush.service");
const matching_1 = require("../lib/matching");
const publishDomainEvent_1 = require("../realtime/publishDomainEvent");
const presence_1 = require("../realtime/presence");
function startMatchNewOrderWorker() {
    const expo = new expoPush_service_1.ExpoPushService(prisma_1.prisma);
    return new bullmq_1.Worker("match-new-order", async (job) => {
        const { orderId } = job.data;
        const order = await prisma_1.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                customerUserId: true,
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
        if (!order) {
            process.stdout.write(JSON.stringify({ level: "info", msg: "match_new_order_skipped", reason: "order_not_found", orderId }) + "\n");
            return;
        }
        if (order.status !== "published") {
            process.stdout.write(JSON.stringify({ level: "info", msg: "match_new_order_skipped", reason: "order_not_published", orderId, status: order.status }) + "\n");
            return;
        }
        const category = await prisma_1.prisma.serviceCategory.findUnique({
            where: { id: order.serviceCategoryId },
            select: { name: true },
        });
        const subcategory = await prisma_1.prisma.serviceSubcategory.findUnique({
            where: { id: order.serviceSubCategoryId },
            select: { name: true },
        });
        const type = order.serviceTypeId
            ? await prisma_1.prisma.serviceType.findUnique({
                where: { subcategoryId_id: { subcategoryId: order.serviceSubCategoryId, id: order.serviceTypeId } },
                select: { name: true },
            })
            : null;
        const candidates = (await prisma_1.prisma.$queryRaw `
        SELECT
          ps.performer_user_id,
          (ST_Distance(ps.base_geo, o.location_geo) / 1000.0) AS distance_km
        FROM performer_settings ps
        JOIN users u
          ON u.id = ps.performer_user_id
        JOIN performer_services psvc
          ON psvc.performer_user_id = ps.performer_user_id
        JOIN orders o
          ON o.id = ${orderId}
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
              AND ST_DWithin(ps.base_geo, o.location_geo, (ps.radius_km * 1000)::double precision)
            )
          )
        ORDER BY distance_km ASC
        LIMIT 500
      `);
        if (candidates.length === 0) {
            process.stdout.write(JSON.stringify({ level: "info", msg: "match_new_order_no_candidates", orderId }) + "\n");
            return;
        }
        await prisma_1.prisma.$transaction(candidates.map((c) => prisma_1.prisma.orderMatch.upsert({
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
        })));
        await (0, publishDomainEvent_1.publishDomainEvent)({
            type: "marketplace.match_added",
            targets: { userIds: candidates.map((c) => c.performer_user_id) },
            data: { orderId: order.id },
        });
        const tokens = (await prisma_1.prisma.device.findMany({
            where: {
                userId: { in: candidates.map((c) => c.performer_user_id) },
                revokedAt: null,
            },
            select: { expoPushToken: true, userId: true },
        }));
        if (tokens.length === 0) {
            process.stdout.write(JSON.stringify({ level: "info", msg: "match_new_order_no_devices", orderId, candidateCount: candidates.length }) + "\n");
            return;
        }
        const online = await (0, presence_1.getOnlineUserIds)(Array.from(new Set(tokens.map((t) => t.userId))));
        const pushTokens = tokens.filter((t) => !online.has(t.userId));
        if (pushTokens.length === 0) {
            process.stdout.write(JSON.stringify({ level: "info", msg: "match_new_order_push_skipped_online", orderId, onlineCount: online.size }) + "\n");
            return;
        }
        const validTokenCount = tokens.filter((t) => expo_server_sdk_1.Expo.isExpoPushToken(t.expoPushToken)).length;
        process.stdout.write(JSON.stringify({
            level: "info",
            msg: "match_new_order_ready_to_notify",
            orderId,
            candidateCount: candidates.length,
            deviceCount: tokens.length,
            validTokenCount,
        }) + "\n");
        const serviceLabel = [category === null || category === void 0 ? void 0 : category.name, subcategory === null || subcategory === void 0 ? void 0 : subcategory.name, type === null || type === void 0 ? void 0 : type.name].filter(Boolean).join(" / ");
        const dateRange = (0, matching_1.formatOrderDateRange)(order.dateFrom, order.dateTo);
        const budget = `${Number(order.budget)} ${order.currency}`;
        const location = [order.locationLabel, order.regionName].filter(Boolean).join(", ");
        const title = serviceLabel ? `Новий заказ: ${serviceLabel}` : "Новий заказ поруч";
        const body = [location, `${Number(order.areaHa)} га`, budget, dateRange].filter(Boolean).join(" • ");
        await expo.sendBatch(pushTokens.map((t) => {
            var _a, _b, _c, _d, _e;
            return ({
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
                    dateFrom: (_b = (_a = order.dateFrom) === null || _a === void 0 ? void 0 : _a.toISOString()) !== null && _b !== void 0 ? _b : null,
                    dateTo: (_d = (_c = order.dateTo) === null || _c === void 0 ? void 0 : _c.toISOString()) !== null && _d !== void 0 ? _d : null,
                    locationLabel: order.locationLabel,
                    regionName: (_e = order.regionName) !== null && _e !== void 0 ? _e : null,
                },
            });
        }));
        process.stdout.write(JSON.stringify({ level: "info", msg: "match_new_order_notified", orderId, sentTo: pushTokens.length }) + "\n");
    }, { connection: (0, connection_1.getRedisConnectionOptions)(), concurrency: 10 });
}
