import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import type { PrismaClient } from "../generated/prisma/client";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace";

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

    await this.prisma.notification.createMany({
      data: valid.map((v) => ({
        userId: v.toUserId,
        type: "marketplace",
        title: v.title,
        message: v.body,
        data: (v.data ?? {}) as unknown as InputJsonValue,
      })),
    });

    const messages: ExpoPushMessage[] = valid.map((v) => ({
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

  private async handleReceipts(receiptIds: string[]) {
    if (receiptIds.length === 0) return;

    const chunks = this.expo.chunkPushNotificationReceiptIds(receiptIds);
    for (const chunk of chunks) {
      await this.expo.getPushNotificationReceiptsAsync(chunk);
    }
  }
}
