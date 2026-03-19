"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpoPushService = void 0;
const expo_server_sdk_1 = require("expo-server-sdk");
class ExpoPushService {
    constructor(prisma) {
        this.prisma = prisma;
        this.expo = new expo_server_sdk_1.Expo({ accessToken: this.getAccessToken() });
    }
    getAccessToken() {
        const token = process.env.EXPO_ACCESS_TOKEN;
        if (!token)
            return undefined;
        const t = token.trim();
        if (!t)
            return undefined;
        const looksLikeJwt = t.split(".").length === 3;
        const looksLikeExpoToken = t.startsWith("expo_");
        if (looksLikeJwt || looksLikeExpoToken)
            return t;
        if (process.env.NODE_ENV !== "production") {
            process.stdout.write(JSON.stringify({ level: "warn", msg: "expo_access_token_ignored_invalid_format" }) + "\n");
        }
        return undefined;
    }
    async sendPush(req) {
        await this.sendBatch([req]);
    }
    async sendBatch(reqs) {
        const valid = reqs.filter((r) => expo_server_sdk_1.Expo.isExpoPushToken(r.toExpoToken));
        const invalid = reqs.filter((r) => !expo_server_sdk_1.Expo.isExpoPushToken(r.toExpoToken));
        if (process.env.NODE_ENV !== "production") {
            process.stdout.write(JSON.stringify({
                level: "info",
                msg: "expo_push_send_begin",
                requestCount: reqs.length,
                validCount: valid.length,
                invalidCount: invalid.length,
            }) + "\n");
        }
        if (invalid.length) {
            await this.prisma.device.updateMany({
                where: { expoPushToken: { in: invalid.map((i) => i.toExpoToken) } },
                data: { revokedAt: new Date() },
            });
        }
        if (valid.length === 0) {
            if (process.env.NODE_ENV !== "production") {
                process.stdout.write(JSON.stringify({ level: "info", msg: "expo_push_no_valid_tokens" }) + "\n");
            }
            return;
        }
        const messages = valid.map((v) => ({
            to: v.toExpoToken,
            sound: "default",
            title: v.title,
            body: v.body,
            data: v.data,
        }));
        const chunks = this.expo.chunkPushNotifications(messages);
        const ticketsByIndex = [];
        try {
            for (const chunk of chunks) {
                const tickets = (await this.expo.sendPushNotificationsAsync(chunk));
                ticketsByIndex.push(...tickets);
            }
        }
        catch (err) {
            process.stdout.write(JSON.stringify({
                level: "error",
                msg: "expo_push_send_error",
                error: err instanceof Error ? err.message : String(err),
            }) + "\n");
            throw err;
        }
        if (process.env.NODE_ENV !== "production") {
            const okCount = ticketsByIndex.filter((t) => (t === null || t === void 0 ? void 0 : t.status) === "ok").length;
            const errorCount = ticketsByIndex.filter((t) => (t === null || t === void 0 ? void 0 : t.status) === "error").length;
            process.stdout.write(JSON.stringify({
                level: "info",
                msg: "expo_push_send_result",
                ticketCount: ticketsByIndex.length,
                okCount,
                errorCount,
            }) + "\n");
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
