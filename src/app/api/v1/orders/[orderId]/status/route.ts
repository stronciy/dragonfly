import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { publishDomainEvent } from "@/realtime/publishDomainEvent";
import { ExpoPushService } from "@/services/expoPush.service";
import { Prisma } from "@/generated/prisma";

const schema = z.object({
  status: z.enum(["active", "completed"]),
});

const allowedTransitions: Record<string, Array<string>> = {
  accepted: ["active"],
  active: ["completed"],
};

export async function PATCH(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Order not found");

    const allowed = allowedTransitions[order.status] ?? [];
    if (!allowed.includes(body.status)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid status transition");

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.order.update({ where: { id: orderId }, data: { status: body.status } });
      await tx.orderStatusEvent.create({
        data: { orderId, status: body.status, note: null },
      });
      if (body.status === "completed") {
        await tx.orderMatch.deleteMany({ where: { orderId } });
      }
      return u;
    });

    // Відправляємо Push сповіщення заказчику
    const expo = new ExpoPushService(prisma);
    
    if (body.status === "active") {
      // Створюємо запис в notifications
      await prisma.notification.create({
        data: {
          userId: order.customerUserId,
          type: "order",
          title: "Виконавець почав роботу",
          message: `Замовлення #${orderId.slice(-6)}. Виконавець розпочав виконання робіт.`,
          data: {
            orderId,
            type: "order_started",
            role: "customer",
            newStatus: "started",
          } as unknown as Prisma.InputJsonValue,
        },
      });
      
      // Відправляємо Push
      const customerDevices = await prisma.device.findMany({
        where: { userId: order.customerUserId, revokedAt: null },
        select: { expoPushToken: true },
      });
      
      for (const device of customerDevices) {
        await expo.sendPush({
          toUserId: order.customerUserId,
          toExpoToken: device.expoPushToken,
          title: "Виконавець почав роботу",
          body: `Замовлення #${orderId.slice(-6)}. Виконавець розпочав виконання робіт.`,
          data: {
            orderId,
            type: "order_started",
            role: "customer",
            newStatus: "started",
          },
        });
      }
      
      console.log(
        "\n🔔 [Status] Відправка Push order.started:",
        `\n   OrderId: ${orderId}`,
        `\n   CustomerUserId: ${order.customerUserId}\n`
      );
    } else if (body.status === "completed") {
      // Створюємо запис в notifications
      await prisma.notification.create({
        data: {
          userId: order.customerUserId,
          type: "order",
          title: "Виконавець завершив роботу",
          message: `Замовлення #${orderId.slice(-6)}. Виконавець завершив виконання робіт. Перевірте та підтвердіть.`,
          data: {
            orderId,
            type: "order_completed",
            role: "customer",
            newStatus: "completed",
          } as unknown as Prisma.InputJsonValue,
        },
      });
      
      // Відправляємо Push
      const customerDevices = await prisma.device.findMany({
        where: { userId: order.customerUserId, revokedAt: null },
        select: { expoPushToken: true },
      });
      
      for (const device of customerDevices) {
        await expo.sendPush({
          toUserId: order.customerUserId,
          toExpoToken: device.expoPushToken,
          title: "Виконавець завершив роботу",
          body: `Замовлення #${orderId.slice(-6)}. Виконавець завершив виконання робіт. Перевірте та підтвердіть.`,
          data: {
            orderId,
            type: "order_completed",
            role: "customer",
            newStatus: "completed",
          },
        });
      }
      
      console.log(
        "\n🔔 [Status] Відправка Push order.completed:",
        `\n   OrderId: ${orderId}`,
        `\n   CustomerUserId: ${order.customerUserId}\n`
      );
    }

    // WebSocket для оновлення екрану
    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [updated.customerUserId, updated.performerUserId!].filter(Boolean) as string[] },
      data: { orderId: updated.id, fromStatus: order.status, toStatus: updated.status },
    });
    
    // Додаткове специфічне сповіщення
    await publishDomainEvent({
      type: body.status === "active" ? "order.started" : "order.completed",
      requestId,
      targets: { userIds: [updated.customerUserId] },
      data: { 
        orderId: updated.id, 
        status: updated.status,
        performerId: updated.performerUserId,
      },
    });

    return ok(req, { order: { id: updated.id, status: updated.status } }, { message: "Status updated" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
