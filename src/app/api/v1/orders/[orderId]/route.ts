import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { enqueueMatchNewOrder } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/services/notify";
import {
  ESCROW_OPEN_STATUSES,
  buildOrderDetailPayload,
  resolveOrderDetailViewerRole,
} from "@/shared";

const patchSchema = z
  .object({
    serviceCategoryId: z.string().min(1).optional(),
    serviceSubCategoryId: z.string().min(1).optional(),
    serviceTypeId: z.string().min(1).nullable().optional(),
    areaHa: z.number().positive().optional(),
    dateFrom: z.string().datetime().nullable().optional(),
    dateTo: z.string().datetime().nullable().optional(),
    location: z
      .preprocess(
        (v) => {
          if (!v || typeof v !== "object") return v;
          const obj = v as Record<string, unknown>;
          const addressLabel = typeof obj.addressLabel === "string" ? obj.addressLabel : undefined;
          const locationLabel = typeof obj.locationLabel === "string" ? obj.locationLabel : undefined;
          if (!addressLabel && locationLabel) return { ...obj, addressLabel: locationLabel };
          return obj;
        },
        z.object({
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
          addressLabel: z.string().min(1),
          regionName: z.string().min(1).optional(),
          settlementName: z.string().trim().min(1).max(120).nullable().optional(),
        })
      )
      .optional(),
    comment: z.string().max(5000).nullable().optional(),
    budget: z.number().positive().optional(),
    status: z.enum(["draft", "published"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Немає полів для оновлення" });

async function getOrderOr404(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  return order;
}

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const order = await getOrderOr404(orderId);

    const canRead =
      order.customerUserId === user.id || order.performerUserId === user.id;
    if (!canRead) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    // Escrow is strictly role-scoped: fetch only the caller's own lock/intents
    // so the counterparty's frozen amount never reaches the payload.
    const viewerRole = resolveOrderDetailViewerRole(order, user.id);

    const timeline = await prisma.orderStatusEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      select: { status: true, createdAt: true, note: true },
    });

    // Fetch both escrow locks to check if contacts should be revealed
    const [customerLock, performerLock] = await Promise.all([
      prisma.escrowLock.findFirst({
        where: { orderId, role: "customer", status: { in: [...ESCROW_OPEN_STATUSES] } },
        select: { amount: true, status: true },
      }),
      prisma.escrowLock.findFirst({
        where: { orderId, role: "performer", status: { in: [...ESCROW_OPEN_STATUSES] } },
        select: { amount: true, status: true },
      }),
    ]);

    // Check if contacts should be revealed: order is confirmed AND both have "held" status
    const bothDepositsConfirmed =
      order.status === "confirmed" &&
      customerLock?.status === "held" &&
      performerLock?.status === "held";

    // Fetch counterparty contact info if deposits confirmed
    let counterpartyContact: {
      name: string;
      phone: string | null;
      companyName: string | null;
    } | null = null;

    if (bothDepositsConfirmed) {
      const counterpartyUserId = viewerRole === "customer" ? order.performerUserId : order.customerUserId;
      if (counterpartyUserId) {
        const counterpartyUser = await prisma.user.findUnique({
          where: { id: counterpartyUserId },
          select: { name: true, phone: true },
        });
        // Try to get company name from LegalProfile first, then CustomerProfile/PerformerProfile
        const legalProfile = await prisma.legalProfile.findUnique({
          where: { userId: counterpartyUserId },
          select: { companyName: true },
        });
        const companyName = legalProfile?.companyName ?? null;
        if (counterpartyUser) {
          counterpartyContact = {
            name: counterpartyUser.name,
            phone: counterpartyUser.phone,
            companyName,
          };
        }
      }
    }

    const ownLock = viewerRole === "customer" ? customerLock : performerLock;

    const ownIntents = await prisma.paymentIntent.findMany({
      where: { orderId, role: viewerRole },
      select: { part: true, status: true },
    });

    const confirmationReview = await prisma.review.findFirst({
      where: { orderId, authorUserId: order.customerUserId },
      orderBy: { createdAt: "asc" },
      select: { rating: true, text: true, createdAt: true },
    });

    return ok(req, {
      order: buildOrderDetailPayload({
        order,
        viewerRole,
        lock: ownLock,
        intents: ownIntents,
        timeline,
        confirmationReview,
        counterpartyContact,
      }),
    });
  } catch (err) {
    return fail(req, err);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId } = await ctx.params;
    const order = await getOrderOr404(orderId);
    if (order.customerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    if (!["draft", "published"].includes(order.status)) throw new ApiError(403, "FORBIDDEN", "Замовлення не можна редагувати");

    const body = patchSchema.parse(await req.json());
    const nextStatus = body.status ?? order.status;
    const changedFields = Object.keys(body);

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.order.update({
        where: { id: orderId },
        data: {
          serviceCategoryId: body.serviceCategoryId,
          serviceSubCategoryId: body.serviceSubCategoryId,
          serviceTypeId: body.serviceTypeId,
          areaHa: body.areaHa,
          dateFrom: body.dateFrom ? new Date(body.dateFrom) : body.dateFrom === null ? null : undefined,
          dateTo: body.dateTo ? new Date(body.dateTo) : body.dateTo === null ? null : undefined,
          locationLabel: body.location?.addressLabel,
          regionName: body.location?.regionName,
          settlementName: body.location?.settlementName,
          lat: body.location?.lat,
          lng: body.location?.lng,
          comment: body.comment ?? undefined,
          budget: body.budget,
          status: nextStatus,
        },
        select: { id: true, status: true, performerUserId: true, createdAt: true },
      });

      if (order.status !== nextStatus) {
        await tx.orderStatusEvent.create({
          data: { orderId, status: nextStatus, note: null },
        });
      }

      return u;
    });

    let removedIds: string[] = [];
    if (order.status === "published" && updated.status !== "published") {
      const removed = await prisma.orderMatch.findMany({ where: { orderId }, select: { performerUserId: true } });
      removedIds = removed.map((r) => r.performerUserId);
      await prisma.orderMatch.deleteMany({ where: { orderId } });
      if (removed.length) {
        await publishDomainEvent({
          type: "marketplace.match_removed",
          requestId,
          targets: { userIds: removed.map((r) => r.performerUserId) },
          data: { orderId },
        });
      }
    }

    if (order.status !== "published" && updated.status === "published") {
      await enqueueMatchNewOrder(orderId);
    }

    const watchers = await prisma.orderMatch.findMany({ where: { orderId }, select: { performerUserId: true } });
    const watcherIds = [...new Set([...watchers.map((w) => w.performerUserId), ...removedIds])];
    const targets = {
      userIds: [...new Set([user.id, ...(updated.performerUserId ? [updated.performerUserId] : []), ...watcherIds])],
    };

    await publishDomainEvent({
      type: "order.updated",
      requestId,
      targets,
      data: { orderId, changedFields, status: updated.status },
    });

    if (order.status !== updated.status) {
      await publishDomainEvent({
        type: "order.status_changed",
        requestId,
        targets,
        data: { orderId, fromStatus: order.status, toStatus: updated.status },
      });
    }

    // Send push notifications for order changes
    // Send push notifications for order changes
    const statusChanged = order.status !== updated.status;
    const fieldsChanged = changedFields.filter(f => f !== 'status').join(', ');
    
    const title = 'Замовлення оновлено';
    const message = statusChanged 
      ? `Статус змінено: ${order.status} → ${updated.status}`
      : `Деталі замовлення змінено${fieldsChanged ? `: ${fieldsChanged}` : ''}`;
    
    // Notify assigned performer about order updates (if they exist)
    if (order.performerUserId) {
      notifyUser({
        userId: order.performerUserId,
        type: 'order.updated',
        title,
        message,
        data: { orderId, changedFields, fromStatus: order.status, toStatus: updated.status },
      }).catch(() => {});
    }

    // Notify all matchers (watchers) about order updates for published orders
    for (const watcherId of watcherIds) {
      // Skip if this is the assigned performer (already notified above)
      if (watcherId === order.performerUserId) continue;
      
      notifyUser({
        userId: watcherId,
        type: 'order.updated',
        title: 'Замовлення оновлено',
        message: `Замовлення #${order.orderNumber || orderId.substring(0,8)} було змінене. Перевірте, чи вас досі цікавить ця робота.`,
        data: { orderId, changedFields, screen: 'marketplace' },
      }).catch(() => {});
    }

    // Notify performers who were removed from marketplace
    for (const removedId of removedIds) {
      notifyUser({
        userId: removedId,
        type: 'order.removed_from_marketplace',
        title: 'Замовлення видалено з біржі',
        message: `Замовлення #${order.orderNumber || orderId.substring(0,8)} більше не доступне на біржі`,
        data: { orderId },
      }).catch(() => {});
    }

    return ok(req, { order: updated }, { message: "Оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId } = await ctx.params;
    let order: Awaited<ReturnType<typeof getOrderOr404>>;
    try {
      order = await getOrderOr404(orderId);
    } catch (err) {
      if (process.env.NODE_ENV !== "production" && err instanceof ApiError && err.status === 404) {
        console.info(`[api] DELETE /api/v1/orders/${orderId} not_found userId=${user.id}`);
      }
      throw err;
    }

    if (order.customerUserId !== user.id) {
      if (process.env.NODE_ENV !== "production") {
        console.info(
          `[api] DELETE /api/v1/orders/${orderId} not_owned userId=${user.id} ownerUserId=${order.customerUserId}`
        );
      }
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    if (!["draft", "published", "cancelled"].includes(order.status)) {
      if (process.env.NODE_ENV !== "production") {
        console.info(`[api] DELETE /api/v1/orders/${orderId} bad_status userId=${user.id} status=${order.status}`);
      }
      throw new ApiError(403, "FORBIDDEN", "Замовлення не можна видалити");
    }

    const matchedPerformers = await prisma.orderMatch.findMany({ where: { orderId }, select: { performerUserId: true } });
    await prisma.$transaction([
      prisma.orderMatch.deleteMany({ where: { orderId } }),
      prisma.order.delete({ where: { id: orderId } }),
    ]);

    if (matchedPerformers.length) {
      await publishDomainEvent({
        type: "marketplace.match_removed",
        requestId,
        targets: { userIds: matchedPerformers.map((m) => m.performerUserId) },
        data: { orderId },
      });
    }

    await publishDomainEvent({
      type: "order.deleted",
      requestId,
      targets: {
        userIds: [
          ...new Set([
            user.id,
            ...(order.performerUserId ? [order.performerUserId] : []),
            ...matchedPerformers.map((m) => m.performerUserId),
          ]),
        ],
      },
      data: { orderId },
    });

    return ok(req, { deleted: true, orderId }, { status: 200, message: "Видалено" });
  } catch (err) {
    return fail(req, err);
  }
}
