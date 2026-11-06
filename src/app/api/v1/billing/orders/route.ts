import type { Prisma } from "@prisma/client";
import { ok, fail } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { parsePagination, makePage } from "@/lib/pagination";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const roleParam = url.searchParams.get("role");
    const role = roleParam === "customer" || roleParam === "performer" ? roleParam : user.role;
    const type = url.searchParams.get("type") || "all"; // "all" | "in_progress" | "completed"
    const { limit, offset } = parsePagination(url);

    const userFilter =
      role === "performer"
        ? { performerUserId: user.id }
        : { customerUserId: user.id };

    let statusFilter: Prisma.OrderWhereInput["status"];
    if (type === "in_progress") {
      statusFilter = {
        in: ["accepted", "requires_confirmation", "confirmed", "started", "arbitration"],
      };
    } else if (type === "completed") {
      statusFilter = "completed";
    } else {
      statusFilter = {
        in: ["accepted", "requires_confirmation", "confirmed", "started", "arbitration", "completed"],
      };
    }

    const where = {
      ...userFilter,
      status: statusFilter,
    };

    const activeStatuses = ["accepted", "requires_confirmation", "confirmed", "started", "arbitration"];

    const [orders, totalCount, completedAgg, inProgressAgg, completedCount, inProgressCount, heldLocks] =
      await Promise.all([
        prisma.order.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          take: limit,
          skip: offset,
          include: {
            paymentIntents: {
              where: { status: "paid" },
              select: {
                id: true,
                role: true,
                part: true,
                amount: true,
                depositAmount: true,
                status: true,
                paidAt: true,
              },
            },
            escrowLocks: {
              select: { id: true, role: true, amount: true, status: true, releasedAt: true },
            },
            progressUpdates: {
              orderBy: { percent: "desc" },
              take: 1,
              select: { percent: true },
            },
            paymentRequests: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { id: true, requestedAmount: true, status: true },
            },
          },
        }),
        prisma.order.count({ where }),
        prisma.order.aggregate({
          where: { ...userFilter, status: "completed" },
          _sum: { budget: true },
        }),
        prisma.order.aggregate({
          where: { ...userFilter, status: { in: activeStatuses } },
          _sum: { budget: true },
        }),
        prisma.order.count({
          where: { ...userFilter, status: "completed" },
        }),
        prisma.order.count({
          where: { ...userFilter, status: { in: activeStatuses } },
        }),
        prisma.escrowLock.aggregate({
          where: {
            userId: user.id,
            role,
            status: { in: ["held", "release_pending", "refund_pending", "forfeit_pending"] },
          },
          _sum: { amount: true },
        }),
      ]);

    const items = orders.map((o) => {
      const budget = Number(o.budget);
      const isCompleted = o.status === "completed";
      const progressPercent = o.progressUpdates[0]?.percent ?? (isCompleted ? 100 : 0);

      // Customer payments
      const customerPart1 = o.paymentIntents.find((i) => i.role === "customer" && i.part === 1);
      const customerPart2 = o.paymentIntents.find((i) => i.role === "customer" && i.part === 2);
      const part1Paid = !!customerPart1;
      const part2Paid = !!customerPart2;
      const part1Amount = customerPart1
        ? Number(customerPart1.depositAmount ?? customerPart1.amount)
        : Math.round(budget * 0.3);
      const part2Amount = customerPart2
        ? Number(customerPart2.amount)
        : Math.max(0, budget - part1Amount);

      const customerTotalPaid = isCompleted
        ? budget
        : (part1Paid ? part1Amount : 0) + (part2Paid ? part2Amount : 0);
      const customerRemaining = Math.max(0, budget - customerTotalPaid);

      // Performer payments
      const performerLock = o.escrowLocks.find((l) => l.role === "performer");
      const performerIntent = o.paymentIntents.find((i) => i.role === "performer");
      const performerDepositPaid =
        performerLock?.status === "held" ||
        performerLock?.status === "released" ||
        !!performerIntent;
      const performerDepositAmount = performerLock
        ? Number(performerLock.amount)
        : Math.round(budget * 0.1);
      const performerDepositStatus =
        performerLock?.status === "released"
          ? "released"
          : performerLock?.status === "held"
          ? "held"
          : performerDepositPaid
          ? "held"
          : "pending";

      let performerReceivedAmount = 0;
      let performerPayoutStatus = "pending";
      if (isCompleted) {
        performerReceivedAmount = budget;
        performerPayoutStatus = "paid";
      } else if (part2Paid) {
        performerReceivedAmount = budget;
        performerPayoutStatus = "ready_for_payout";
      } else if (part1Paid) {
        performerReceivedAmount = part1Amount;
        performerPayoutStatus = "part1_in_escrow";
      } else {
        performerReceivedAmount = 0;
        performerPayoutStatus = performerDepositPaid ? "deposit_held" : "awaiting_deposit";
      }

      return {
        orderId: o.id,
        orderNumber: o.orderNumber,
        title: o.locationLabel,
        locationLabel: o.locationLabel,
        status: o.status,
        currency: o.currency,
        budget,
        progressPercent,
        createdAt: o.createdAt.toISOString(),
        completedAt: (o.completedAt ?? (isCompleted ? o.updatedAt : null))?.toISOString() ?? null,

        // Customer details
        part1Paid,
        part1Amount,
        part2Paid,
        part2Amount,
        customerTotalPaid,
        customerRemaining,

        // Performer details
        performerDepositPaid,
        performerDepositAmount,
        performerDepositStatus,
        performerReceivedAmount,
        performerPayoutStatus,

        // Payment request
        hasPaymentRequest: (o.paymentRequests?.length ?? 0) > 0,
        paymentRequestStatus: o.paymentRequests?.[0]?.status ?? null,
      };
    });

    const completedTotal = Number(completedAgg._sum.budget ?? 0);
    const inProgressTotal = Number(inProgressAgg._sum.budget ?? 0);
    const reservedTotal = Number(heldLocks._sum.amount ?? 0);

    return ok(req, {
      summary: {
        completedCount,
        completedTotal,
        inProgressCount,
        inProgressTotal,
        reservedTotal,
        currency: "UAH",
      },
      items,
      page: makePage(limit, offset, totalCount),
    });
  } catch (err) {
    return fail(req, err);
  }
}
