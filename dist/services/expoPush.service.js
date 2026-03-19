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
        const messages = valid.map((v) => ({
            to: v.toExpoToken,
            sound: "default",
            title: v.title,
            body: v.body,
            data: v.data,
        }));
        const chunks = this.expo.chunkPushNotifications(messages);
        const ticketsByIndex = [];
        for (const chunk of chunks) {
            const tickets = (await this.expo.sendPushNotificationsAsync(chunk));
            ticketsByIndex.push(...tickets);
        }
        await this.prisma.notification.createMany({
            data: valid.map((v, i) => {
                var _a, _b;
                return ({
                    userId: v.toUserId,
                    type: "marketplace",
                    title: v.title,
                    message: v.body,
                    data: Object.assign(Object.assign({}, ((_a = v.data) !== null && _a !== void 0 ? _a : {})), { expo: { ticket: (_b = ticketsByIndex[i]) !== null && _b !== void 0 ? _b : null } }),
                });
            }),
        });
        const ticketIdToToken = new Map();
        const receiptIds = ticketsByIndex.flatMap((t, i) => {
            if ((t === null || t === void 0 ? void 0 : t.status) !== "ok" || !t.id)
                return [];
            ticketIdToToken.set(t.id, valid[i].toExpoToken);
            return [t.id];
        });
        await this.handleReceipts(receiptIds, ticketIdToToken);
    }
    async handleReceipts(receiptIds, ticketIdToToken) {
        var _a;
        if (receiptIds.length === 0)
            return;
        const chunks = this.expo.chunkPushNotificationReceiptIds(receiptIds);
        for (const chunk of chunks) {
            const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
            for (const receiptId of chunk) {
                const receipt = receipts[receiptId];
                if (!receipt || receipt.status !== "error")
                    continue;
                const token = ticketIdToToken.get(receiptId);
                const error = (_a = receipt.details) === null || _a === void 0 ? void 0 : _a.error;
                if (token && error === "DeviceNotRegistered") {
                    await this.prisma.device.updateMany({
                        where: { expoPushToken: token },
                        data: { revokedAt: new Date() },
                    });
                }
            }
        }
    }
}
exports.ExpoPushService = ExpoPushService;
