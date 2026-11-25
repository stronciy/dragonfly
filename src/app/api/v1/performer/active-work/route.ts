import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { COMPLETION_CONFIRMED_NOTE } from "@/lib/completionConfirmation";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль Виконавця");

    const now = new Date();

    // Повертати ВСІ замовлення виконавця з відповідними статусами:
    // requires_confirmation (очікують оплату), accepted, confirmed, en_route, started, completed, arbitration
    const orders = await prisma.order.findMany({
      where: {
        performerUserId: user.id,
        status: {
          in: [
            "requires_confirmation",
            "accepted",
            "confirmed",
            "en_route",
            "started",
            "completed",
            "arbitration",
          ],
        },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        locationLabel: true,
        orderNumber: true,
        areaHa: true,
        budget: true,
        currency: true,
        customerUserId: true,
        acceptedAt: true,
        depositDeadline: true,
        customerPart2Deadline: true,
        reportSubmittedAt: true,
        statusEvents: {
          where: { note: COMPLETION_CONFIRMED_NOTE },
          select: { createdAt: true },
          take: 1,
        },
        paymentRequests: {
          where: { requestedBy: user.id, status: "pending" },
          select: { id: true, requestedAmount: true, createdAt: true, status: true },
          take: 1,
        },
        paymentIntents: {
          where: { part: 2, status: "paid" },
          select: { id: true },
          take: 1,
        },
        progressUpdates: {
          orderBy: { createdAt: "desc" },
          take: 5,
          select: {
            id: true,
            percent: true,
            comment: true,
            createdAt: true,
            media: {
              select: { id: true, url: true },
            },
          },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (orders.length === 0) {
      return ok(req, { 
        items: [], 
        active_work: [],
        totalCount: 0,
      });
    }

    // Отримуємо інформацію про замовників
    const customerIds = Array.from(new Set(orders.map(o => o.customerUserId)));
    const customers = await prisma.user.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, name: true, phone: true },
    });
    const customerMap = new Map(customers.map(c => [c.id, c]));

    const items = orders.map(order => ({
      orderId: order.id,
      id: order.id,
      status: order.status,
      title: order.locationLabel,
      areaHa: Number(order.areaHa),
      locationLabel: order.locationLabel,
      orderNumber: order.orderNumber,
      budget: Number(order.budget),
      currency: order.currency,
      acceptedAt: order.acceptedAt,
      depositDeadline: order.depositDeadline,
      customerPart2Deadline: order.customerPart2Deadline,
      reportSubmittedAt: order.reportSubmittedAt ? order.reportSubmittedAt.toISOString() : null,
      completionConfirmedAt: order.statusEvents?.[0]?.createdAt ? order.statusEvents[0].createdAt.toISOString() : null,
      hasPaymentRequest: (order.paymentRequests?.length ?? 0) > 0 || !!order.customerPart2Deadline,
      part2Paid: (order.paymentIntents?.length ?? 0) > 0,
      customer: customerMap.get(order.customerUserId) 
        ? { 
            id: customerMap.get(order.customerUserId)!.id, 
            name: customerMap.get(order.customerUserId)!.name, 
            phone: customerMap.get(order.customerUserId)!.phone 
          } 
        : null,
      progressUpdates: order.progressUpdates?.map((p) => ({
        id: p.id,
        percent: p.percent,
        comment: p.comment,
        createdAt: p.createdAt.toISOString(),
        media: p.media?.map((m) => ({ id: m.id, url: m.url })) ?? [],
      })) ?? [],
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    }));

    return ok(req, { 
      items,
      active_work: items,
      totalCount: items.length,
    });
  } catch (err) {
    return fail(req, err);
  }
}
