import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import type { PrismaClient } from "../generated/prisma/client";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace";

type ExpoTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: unknown };

export type PushRequest = {
  toUserId: string;
  toExpoToken: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export class ExpoPushService {
  private expo = new Expo({ accessToken: this.getAccessToken() });

  constructor(private prisma: PrismaClient) {}

  private getAccessToken() {
    const token = process.env.EXPO_ACCESS_TOKEN;
    if (!token) return undefined;
    const t = token.trim();
    if (!t) return undefined;

    const looksLikeJwt = t.split(".").length === 3;
    const looksLikeExpoToken = t.startsWith("expo_");
    if (looksLikeJwt || looksLikeExpoToken) return t;

    if (process.env.NODE_ENV !== "production") {
      process.stdout.write(JSON.stringify({ level: "warn", msg: "expo_access_token_ignored_invalid_format" }) + "\n");
    }
    return undefined;
  }

  async sendPush(req: PushRequest) {
    await this.sendBatch([req]);
  }

  async sendBatch(reqs: PushRequest[]) {
    const valid = reqs.filter((r) => Expo.isExpoPushToken(r.toExpoToken));
    const invalid = reqs.filter((r) => !Expo.isExpoPushToken(r.toExpoToken));

    if (process.env.NODE_ENV !== "production") {
      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "expo_push_send_begin",
          requestCount: reqs.length,
          validCount: valid.length,
          invalidCount: invalid.length,
        }) + "\n"
      );
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

    const messages: ExpoPushMessage[] = valid.map((v) => ({
      to: v.toExpoToken,
      sound: "default",
      title: v.title,
      body: v.body,
      data: v.data,
    }));

    const chunks = this.expo.chunkPushNotifications(messages);
    const ticketsByIndex: ExpoTicket[] = [];
    try {
      for (const chunk of chunks) {
        const tickets = (await this.expo.sendPushNotificationsAsync(chunk)) as ExpoTicket[];
        ticketsByIndex.push(...tickets);
      }
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          level: "error",
          msg: "expo_push_send_error",
          error: err instanceof Error ? err.message : String(err),
        }) + "\n"
      );
      throw err;
    }

    if (process.env.NODE_ENV !== "production") {
      const okCount = ticketsByIndex.filter((t) => t?.status === "ok").length;
      const errorCount = ticketsByIndex.filter((t) => t?.status === "error").length;
      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "expo_push_send_result",
          ticketCount: ticketsByIndex.length,
          okCount,
          errorCount,
        }) + "\n"
      );
    }

    await this.prisma.notification.createMany({
      data: valid.map((v, i) => ({
        userId: v.toUserId,
        type: "marketplace",
        title: v.title,
        message: v.body,
        data: { ...(v.data ?? {}), expo: { ticket: ticketsByIndex[i] ?? null } } as unknown as InputJsonValue,
      })),
    });

    const ticketIdToToken = new Map<string, string>();
    const receiptIds = ticketsByIndex.flatMap((t, i) => {
      if (t?.status !== "ok" || !t.id) return [];
      ticketIdToToken.set(t.id, valid[i].toExpoToken);
      return [t.id];
    });
    await this.handleReceipts(receiptIds, ticketIdToToken);
  }

  private async handleReceipts(receiptIds: string[], ticketIdToToken: Map<string, string>) {
    if (receiptIds.length === 0) return;

    const chunks = this.expo.chunkPushNotificationReceiptIds(receiptIds);
    for (const chunk of chunks) {
      const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
      for (const receiptId of chunk) {
        const receipt = receipts[receiptId];
        if (!receipt || receipt.status !== "error") continue;

        const token = ticketIdToToken.get(receiptId);
        const error = (receipt as { details?: { error?: string } }).details?.error;
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
