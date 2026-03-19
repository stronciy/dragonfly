import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { enqueueMatchNewOrder } from "@/queues/jobs";

const patchSchema = z
  .object({
    serviceCategoryId: z.string().min(1).optional(),
    serviceSubCategoryId: z.string().min(1).optional(),
    serviceTypeId: z.string().min(1).nullable().optional(),
    areaHa: z.number().positive().optional(),
    dateFrom: z.string().datetime().nullable().optional(),
    dateTo: z.string().datetime().nullable().optional(),
    location: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        addressLabel: z.string().min(1),
        regionName: z.string().min(1).optional(),
      })
      .optional(),
    comment: z.string().max(5000).nullable().optional(),
    budget: z.number().positive().optional(),
    status: z.enum(["draft", "published"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

async function getOrderOr404(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
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
    if (!canRead) throw new ApiError(404, "NOT_FOUND", "Order not found");

    const timeline = await prisma.orderStatusEvent.findMany({
      where: { orderId },
      orderBy: { at: "asc" },
      select: { toStatus: true, at: true, note: true },
    });

    return ok(req, {
      order: {
        id: order.id,
        status: order.status,
        serviceCategoryId: order.serviceCategoryId,
        serviceSubCategoryId: order.serviceSubCategoryId,
        serviceTypeId: order.serviceTypeId,
        areaHa: Number(order.areaHa),
        location: { lat: Number(order.lat), lng: Number(order.lng), locationLabel: order.locationLabel, regionName: order.regionName },
        dateFrom: order.dateFrom,
        dateTo: order.dateTo,
        budget: Number(order.budget),
        acceptedAt: order.acceptedAt,
        depositDeadline: order.depositDeadline,
        comment: order.comment,
        timeline: timeline.map((t) => ({ status: t.toStatus, at: t.at, note: t.note })),
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");
    const { orderId } = await ctx.params;
    const order = await getOrderOr404(orderId);
    if (order.customerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Order not found");
    if (!["draft", "published"].includes(order.status)) throw new ApiError(403, "FORBIDDEN", "Order cannot be edited");

    const body = patchSchema.parse(await req.json());
    const nextStatus = body.status ?? order.status;

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
          lat: body.location?.lat,
          lng: body.location?.lng,
          comment: body.comment ?? undefined,
          budget: body.budget,
          status: nextStatus,
        },
        select: { id: true, status: true, createdAt: true },
      });

      if (order.status !== nextStatus) {
        await tx.orderStatusEvent.create({
          data: { orderId, fromStatus: order.status, toStatus: nextStatus, note: null },
        });
      }

      return u;
    });

    if (order.status !== "published" && updated.status === "published") {
      await enqueueMatchNewOrder(orderId);
    }

    return ok(req, { order: updated }, { message: "Updated" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");
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
      throw new ApiError(404, "NOT_FOUND", "Order not found");
    }

    if (!["draft", "published"].includes(order.status)) {
      if (process.env.NODE_ENV !== "production") {
        console.info(`[api] DELETE /api/v1/orders/${orderId} bad_status userId=${user.id} status=${order.status}`);
      }
      throw new ApiError(403, "FORBIDDEN", "Order cannot be deleted");
    }

    await prisma.$transaction([
      prisma.orderMatch.deleteMany({ where: { orderId } }),
      prisma.order.delete({ where: { id: orderId } }),
    ]);

    return ok(req, { deleted: true, orderId }, { status: 200, message: "Deleted" });
  } catch (err) {
    return fail(req, err);
  }
}
