"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpoPushService = void 0;
const expo_server_sdk_1 = require("expo-server-sdk");
class ExpoPushService {
    constructor(prisma) {
        this.prisma = prisma;
        this.expo = new expo_server_sdk_1.Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN || undefined });
    }
    async sendPush(req) {
        await this.sendBatch([req]);
    }
    async sendBatch(reqs) {
        const valid = reqs.filter((r) => expo_server_sdk_1.Expo.isExpoPushToken(r.toExpoToken));
        const invalid = reqs.filter((r) => !expo_server_sdk_1.Expo.isExpoPushToken(r.toExpoToken));
        if (invalid.length) {
            await this.prisma.device.updateMany({
                where: { expoPushToken: { in: invalid.map((i) => i.toExpoToken) } },
                data: { revokedAt: new Date() },
            });
        }
        if (valid.length === 0)
            return;
        await this.prisma.notification.createMany({
            data: valid.map((v) => {
                var _a;
                return ({
                    userId: v.toUserId,
                    type: "marketplace",
                    title: v.title,
                    message: v.body,
                    data: ((_a = v.data) !== null && _a !== void 0 ? _a : {}),
                });
            }),
        });
        const messages = valid.map((v) => ({
            to: v.toExpoToken,
            sound: "default",
            title: v.title,
            body: v.body,
            data: v.data,
        }));
        const chunks = this.expo.chunkPushNotifications(messages);
        const ticketChunks = [];
        for (const chunk of chunks) {
            const tickets = await this.expo.sendPushNotificationsAsync(chunk);
            ticketChunks.push(...tickets);
        }
        const receiptIds = ticketChunks.flatMap((t) => (t.status === "ok" && t.id ? [t.id] : []));
        await this.handleReceipts(receiptIds);
    }
    async handleReceipts(receiptIds) {
        if (receiptIds.length === 0)
            return;
        const chunks = this.expo.chunkPushNotificationReceiptIds(receiptIds);
        for (const chunk of chunks) {
            await this.expo.getPushNotificationReceiptsAsync(chunk);
        }
    }
}
exports.ExpoPushService = ExpoPushService;
