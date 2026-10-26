import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { notifyUser } from "@/services/notify";
import { publishDomainEvent } from "@/shared";
import { SERVICE_FEE_RATE } from "@/lib/fees";

const completeSchema = z.object({
  confirmed: z.boolean(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    
    const body = completeSchema.parse(await req.json());

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, name: true, expoPushToken: true } },
        performer: { select: { id: true, expoPushToken: true } },
        escrowLocks: true,
      },
    });

    if (!order) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    if (order.status !== "started" && order.status !== "en_route") {
      throw new ApiError(400, "BAD_REQUEST", "Замовлення не в статусі виконання");
    }

    // Check user permissions
    const isCustomer = order.customerUserId === user.id && user.role === "customer";
    const isPerformer = order.performerUserId === user.id && user.role === "performer";

    if (!isCustomer && !isPerformer) {
      throw new ApiError(403, "FORBIDDEN", "Немає доступу до цього замовлення");
    }

    // Get performer lock
    const performerLock = order.escrowLocks.find(l => l.role === "performer");
    const customerLock = order.escrowLocks.find(l => l.role === "customer");

    if (!performerLock || !customerLock) {
      throw new ApiError(400, "BAD_REQUEST", "Не знайдено escrow locks");
    }

    const budgetAmount = Number(order.budget);
    const depositAmount = Number(performerLock.amount);
    const feeAmount = budgetAmount * SERVICE_FEE_RATE;
    const totalPerformerPayout = budgetAmount - feeAmount;

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      // 1. Update order status
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: {
          status: "completed",
          completedAt: new Date(),
        },
      });

      // 2. Get or create wallets
      const [performerWallet, customerWallet] = await Promise.all([
        tx.wallet.upsert({
          where: { userId: order.performerUserId! },
          create: { userId: order.performerUserId!, balance: 0 },
          update: {},
        }),
        tx.wallet.upsert({
          where: { userId: order.customerUserId },
          create: { userId: order.customerUserId, balance: 0 },
          update: {},
        }),
      ]);

      // 3. Credit performer (100% order amount - fee)
      await tx.wallet.update({
        where: { id: performerWallet.id },
        data: { 
          balance: { increment: totalPerformerPayout },
        },
      });

      // Create transaction record for performer payout
      await tx.transaction.create({
        data: {
          walletId: performerWallet.id,
          orderId,
          type: "payment_received",
          amount: totalPerformerPayout,
          currency: "UAH",
          description: `Виплата за замовлення #${order.orderNumber || orderId.substring(0,8)}`,
          status: "completed",
          metadata: { feeAmount, total: budgetAmount },
        },
      });

      // 4. Credit performer (deposit refund)
      await tx.wallet.update({
        where: { id: performerWallet.id },
        data: { 
          balance: { increment: depositAmount },
        },
      });

      // Create transaction record for deposit refund
      await tx.transaction.create({
        data: {
          walletId: performerWallet.id,
          orderId,
          type: "refund",
          amount: depositAmount,
          currency: "UAH",
          description: `Повернення застави за замовлення #${order.orderNumber || orderId.substring(0,8)}`,
          status: "completed",
        },
      });

      // 5. Release customer deposit (refund)
      await tx.wallet.update({
        where: { id: customerWallet.id },
        data: { 
          balance: { increment: Number(customerLock.amount) },
        },
      });

      // Create transaction record for customer deposit refund
      await tx.transaction.create({
        data: {
          walletId: customerWallet.id,
          orderId,
          type: "refund",
          amount: Number(customerLock.amount),
          currency: "UAH",
          description: `Повернення застави за замовлення #${order.orderNumber || orderId.substring(0,8)}`,
          status: "completed",
        },
      });

      return {
        order: updatedOrder,
        performerPayout: totalPerformerPayout,
        performerDepositRefund: depositAmount,
        customerDepositRefund: Number(customerLock.amount),
        feeAmount,
      };
    });

    // Notify performer
    notifyUser({
      userId: order.performerUserId!,
      type: "order.completed.payout",
      title: "Замовлення завершено - виплата на баланс",
      message: `Замовлення #${order.orderNumber || orderId.substring(0,8)} завершено. На ваш баланс зараховано ${result.performerPayout.toFixed(2)}₴ (винагорода) та ${result.performerDepositRefund.toFixed(2)}₴ (повернення застави).`,
      data: { 
        orderId, 
        orderNumber: order.orderNumber,
        performerPayout: result.performerPayout,
        depositRefund: result.performerDepositRefund,
        screen: "wallet",
      },
    }).catch(() => {});

    // Notify customer
    notifyUser({
      userId: order.customerUserId,
      type: "order.completed.customer",
      title: "Замовлення завершено",
      message: `Замовлення #${order.orderNumber || orderId.substring(0,8)} виконано. На ваш баланс повернуто ${result.customerDepositRefund.toFixed(2)}₴ (гарантійна застава).`,
      data: { 
        orderId, 
        orderNumber: order.orderNumber,
        depositRefund: result.customerDepositRefund,
        screen: "wallet",
      },
    }).catch(() => {});

    // Publish domain event
    await publishDomainEvent({
      type: "order.completed",
      requestId,
      targets: { userIds: [order.customerUserId, order.performerUserId!] },
      data: { 
        orderId, 
        performerPayout: result.performerPayout,
        performerDepositRefund: result.performerDepositRefund,
      },
    });

    return ok(req, { 
      order: result.order,
      payouts: {
        performerTotal: result.performerPayout + result.performerDepositRefund,
        performerPayout: result.performerPayout,
        performerDeposit: result.performerDepositRefund,
        customerDepositRefund: result.customerDepositRefund,
        fee: result.feeAmount,
      },
      message: "Замовлення успішно завершено та проведено виплати" 
    });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірні дані", err.flatten()));
    }
    return fail(req, err);
  }
}
