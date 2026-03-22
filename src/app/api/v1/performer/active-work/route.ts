import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const now = new Date();

    // Повертати ВСІ замовлення виконавця з відповідними статусами
    // Для requires_confirmation/accepted — тільки якщо depositDeadline ще не минув
    const orders = await prisma.order.findMany({
      where: {
        performerUserId: user.id,
        OR: [
          { status: { in: ["confirmed", "started", "completed", "arbitration"] } },
          {
            status: { in: ["requires_confirmation", "accepted"] },
            depositDeadline: { gte: now }, // ще не просрочено
          },
        ],
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        locationLabel: true,
        areaHa: true,
        budget: true,
        currency: true,
        customerUserId: true,
        acceptedAt: true,
        depositDeadline: true,
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

    // Отримуємо інформацію про заказчиків
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
      budget: Number(order.budget),
      currency: order.currency,
      acceptedAt: order.acceptedAt,
      depositDeadline: order.depositDeadline,
      customer: customerMap.get(order.customerUserId) 
        ? { 
            id: customerMap.get(order.customerUserId)!.id, 
            name: customerMap.get(order.customerUserId)!.name, 
            phone: customerMap.get(order.customerUserId)!.phone 
          } 
        : null,
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
