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
  private expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN || undefined });

  constructor(private prisma: PrismaClient) {}

  async sendPush(req: PushRequest) {
    await this.sendBatch([req]);
  }

  async sendBatch(reqs: PushRequest[]) {
    const valid = reqs.filter((r) => Expo.isExpoPushToken(r.toExpoToken));
    const invalid = reqs.filter((r) => !Expo.isExpoPushToken(r.toExpoToken));

    if (invalid.length) {
      await this.prisma.device.updateMany({
        where: { expoPushToken: { in: invalid.map((i) => i.toExpoToken) } },
        data: { revokedAt: new Date() },
      });
    }

    if (valid.length === 0) return;

    const messages: ExpoPushMessage[] = valid.map((v) => ({
      to: v.toExpoToken,
      sound: "default",
      title: v.title,
      body: v.body,
      data: v.data,
    }));

    const chunks = this.expo.chunkPushNotifications(messages);
    const ticketsByIndex: ExpoTicket[] = [];
    for (const chunk of chunks) {
      const tickets = (await this.expo.sendPushNotificationsAsync(chunk)) as ExpoTicket[];
      ticketsByIndex.push(...tickets);
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
