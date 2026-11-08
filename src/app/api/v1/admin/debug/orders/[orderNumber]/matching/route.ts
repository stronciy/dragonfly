import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { ApiError, prisma } from "@/shared";
import { PERFORMER_BLOCKING_ESCROW_STATUSES } from "@/lib/marketplaceEligibility";
import { evaluatePerformer } from "@/lib/matchingDiagnostics";

export const runtime = "nodejs";

/**
 * Лише читання: показує, чому заказ не матчиться з виконавцями.
 * Доступ — за ключем панелі адміністратора. Номер приймається як «012600007»
 * або «01-26-00007».
 */
export async function GET(req: Request, ctx: { params: Promise<{ orderNumber: string }> }) {
  try {
    await requirePanelAdmin(req);
    const { orderNumber: raw } = await ctx.params;
    const digits = decodeURIComponent(raw).replace(/\D/g, "");
    if (digits.length !== 9) {
      throw new ApiError(400, "VALIDATION_ERROR", "Номер заказу має 9 цифр, наприклад 012600007");
    }

    const order = await prisma.order.findUnique({
      where: { orderNumber: digits },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        customerUserId: true,
        performerUserId: true,
        serviceCategoryId: true,
        serviceSubCategoryId: true,
        serviceTypeId: true,
        lat: true,
        lng: true,
        regionName: true,
        settlementName: true,
        areaHa: true,
        budget: true,
        createdAt: true,
        customer: { select: { email: true } },
      },
    });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Заказ з таким номером не знайдено");

    const [profiles, services, refusedRows, blockingLocks, matches, customerNotifications] = await Promise.all([
      prisma.performerProfile.findMany({
        select: {
          userId: true,
          baseLatitude: true,
          baseLongitude: true,
          coverageMode: true,
          coverageRadiusKm: true,
          user: { select: { email: true, role: true } },
        },
      }),
      prisma.performerService.findMany({ select: { performerUserId: true, serviceId: true } }),
      prisma.orderMatch.findMany({
        where: { orderId: order.id, status: "refused" },
        select: { performerUserId: true },
      }),
      prisma.escrowLock.findMany({
        where: {
          orderId: order.id,
          role: "performer",
          status: { in: [...PERFORMER_BLOCKING_ESCROW_STATUSES] },
        },
        select: { userId: true, status: true, amount: true },
      }),
      prisma.orderMatch.findMany({
        where: { orderId: order.id },
        select: { performerUserId: true, status: true, createdAt: true },
      }),
      prisma.notification.findMany({
        where: { userId: order.customerUserId, createdAt: { gte: order.createdAt } },
        orderBy: { createdAt: "asc" },
        select: { type: true, title: true, message: true, createdAt: true },
      }),
    ]);

    const servicesByUser = new Map<string, string[]>();
    for (const s of services) {
      const list = servicesByUser.get(s.performerUserId) ?? [];
      list.push(s.serviceId);
      servicesByUser.set(s.performerUserId, list);
    }
    const refused = new Set(refusedRows.map((r) => r.performerUserId));
    const blocked = new Set(blockingLocks.map((l) => l.userId));

    const performers = profiles
      .filter((p) => p.user.role === "performer")
      .map((p) =>
        evaluatePerformer(
          {
            serviceCategoryId: order.serviceCategoryId,
            serviceSubCategoryId: order.serviceSubCategoryId,
            serviceTypeId: order.serviceTypeId,
            lat: Number(order.lat),
            lng: Number(order.lng),
            customerUserId: order.customerUserId,
          },
          {
            userId: p.userId,
            email: p.user.email,
            baseLatitude: p.baseLatitude,
            baseLongitude: p.baseLongitude,
            coverageMode: p.coverageMode,
            coverageRadiusKm: p.coverageRadiusKm,
            services: servicesByUser.get(p.userId) ?? [],
          },
          { refused: refused.has(p.userId), blockedByEscrow: blocked.has(p.userId) }
        )
      )
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.email.localeCompare(b.email));

    return ok(req, {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        performerUserId: order.performerUserId,
        customerEmail: order.customer.email,
        service: {
          categoryId: order.serviceCategoryId,
          subcategoryId: order.serviceSubCategoryId,
          typeId: order.serviceTypeId,
        },
        location: { lat: Number(order.lat), lng: Number(order.lng), regionName: order.regionName, settlementName: order.settlementName },
        areaHa: Number(order.areaHa),
        budget: Number(order.budget),
        createdAt: order.createdAt,
      },
      summary: {
        performersTotal: performers.length,
        eligibleTotal: performers.filter((p) => p.eligible).length,
        matchRows: matches.length,
        matchRowsByStatus: matches.reduce<Record<string, number>>((acc, m) => {
          acc[m.status] = (acc[m.status] ?? 0) + 1;
          return acc;
        }, {}),
      },
      performers,
      matches,
      customerNotifications,
    });
  } catch (err) {
    return fail(req, err);
  }
}
