import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { enqueueMatchNewOrder } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { safeDepositAmount, ESCROW_OPEN_STATUSES } from "@/shared";

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
      (user.role === "customer" && order.customerUserId === user.id) ||
      (user.role === "performer" && order.performerUserId === user.id);
    if (!canRead) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    const timeline = await prisma.orderStatusEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      select: { status: true, createdAt: true, note: true },
    });

    const heldLocks = await prisma.escrowLock.findMany({
      where: { orderId, status: { in: [...ESCROW_OPEN_STATUSES] } },
      select: { amount: true },
    });

    const confirmationReview = await prisma.review.findFirst({
      where: { orderId, authorUserId: order.customerUserId },
      orderBy: { createdAt: "asc" },
      select: { rating: true, text: true, createdAt: true },
    });

    return ok(req, {
      order: {
        id: order.id,
        status: order.status,
        serviceCategoryId: order.serviceCategoryId,
        serviceSubCategoryId: order.serviceSubCategoryId,
        serviceTypeId: order.serviceTypeId,
        areaHa: Number(order.areaHa),
        location: {
          lat: Number(order.lat),
          lng: Number(order.lng),
          locationLabel: order.locationLabel,
          addressLabel: order.locationLabel,
          regionName: order.regionName,
        },
        dateFrom: order.dateFrom,
        dateTo: order.dateTo,
        budget: Number(order.budget),
        acceptedAt: order.acceptedAt,
        depositDeadline: order.depositDeadline,
        depositAmount: Number(safeDepositAmount(order.budget)),
        escrowAmount: heldLocks.reduce((sum, l) => sum + Number(l.amount), 0),
        performerUserId: order.performerUserId,
        comment: order.comment,
        completionConfirmedAt: confirmationReview?.createdAt ?? null,
        rating: confirmationReview?.rating ?? null,
        completionComment: confirmationReview?.text ?? null,
        timeline: timeline.map((t) => ({ status: t.status, at: t.createdAt, note: t.note })),
      },
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
