import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);

    // Get or create wallet
    const wallet = await prisma.wallet.upsert({
      where: { userId: user.id },
      create: { 
        userId: user.id, 
        balance: 0,
        currency: "UAH",
      },
      update: {},
      include: {
        transactions: {
          orderBy: { createdAt: "desc" },
          take: 50,
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                status: true,
              },
            },
          },
        },
      },
    });

    // Calculate statistics
    const totalReceived = wallet.transactions
      .filter(t => ["payment_received", "refund"].includes(t.type) && t.status === "completed")
      .reduce((sum, t) => sum + t.amount, 0);

    const totalSent = wallet.transactions
      .filter(t => ["payment_sent", "fee"].includes(t.type) && t.status === "completed")
      .reduce((sum, t) => sum + t.amount, 0);

    return ok(req, {
      wallet: {
        id: wallet.id,
        balance: wallet.balance,
        holdAmount: wallet.holdAmount,
        currency: wallet.currency,
      },
      stats: {
        totalReceived,
        totalSent,
        netBalance: totalReceived - totalSent,
      },
      transactions: wallet.transactions.map(t => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        currency: t.currency,
        description: t.description,
        status: t.status,
        orderId: t.orderId,
        orderNumber: t.order?.orderNumber,
        createdAt: t.createdAt,
      })),
    });

  } catch (err) {
    return fail(req, err);
  }
}
