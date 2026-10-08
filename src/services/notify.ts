import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ExpoPushService } from "./expoPush.service";

export async function notifyUser(args: {
  userId: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
}) {
  await prisma.notification.create({
    data: {
      userId: args.userId,
      type: args.type,
      title: args.title,
      message: args.message,
      data: args.data as unknown as Prisma.InputJsonValue,
    },
  });
  const expo = new ExpoPushService(prisma);
  const devices = await prisma.device.findMany({
    where: { userId: args.userId, revokedAt: null },
    select: { expoPushToken: true },
  });
  for (const device of devices) {
    await expo.sendPush({
      toUserId: args.userId,
      toExpoToken: device.expoPushToken,
      title: args.title,
      body: args.message,
      data: args.data,
    });
  }
}
