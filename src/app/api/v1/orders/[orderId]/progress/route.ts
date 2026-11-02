import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { notifyUser } from "@/services/notify";
import { publishDomainEvent } from "@/shared";
import { readFormFilesAsDataUrl } from "@/lib/uploads";

export const runtime = "nodejs";

const progressSchema = z.object({
  percent: z.number().min(0).max(100),
  note: z.string().max(500).optional(),
  images: z
    .array(
      z.object({
        dataUrl: z.string(),
        name: z.string().optional(),
        mimeType: z.string().optional(),
        size: z.number().optional(),
      })
    )
    .max(5)
    .optional(),
});

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerUserId: true, performerUserId: true },
    });

    if (!order) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    if (order.customerUserId !== user.id && order.performerUserId !== user.id && user.role !== "admin") {
      throw new ApiError(403, "FORBIDDEN", "Немає доступу до цього замовлення");
    }

    const progress = await prisma.workProgressUpdate.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      include: {
        media: {
          select: { id: true, url: true },
        },
      },
    });

    const unlinkedMedia = await prisma.orderMedia.findMany({
      where: { orderId, kind: { in: ["progress", "report"] }, progressId: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, url: true },
    });

    if (unlinkedMedia.length > 0 && progress.length > 0) {
      const last = progress[progress.length - 1];
      const existingIds = new Set(last.media.map((m) => m.id));
      for (const m of unlinkedMedia) {
        if (!existingIds.has(m.id)) {
          last.media.push(m);
        }
      }
    }

    return ok(req, { progress });
  } catch (err) {
    return fail(req, err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    
    if (user.role !== "performer") {
      throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    }

    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    let percent = 0;
    let note: string | undefined = undefined;
    let uploadedFiles: { dataUrl: string; mimeType: string; size: number; name: string }[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const percentVal = form.get("percent");
      if (percentVal != null && String(percentVal).trim() !== "") {
        percent = Number(percentVal);
      }
      const rawNote = form.get("comment") || form.get("note");
      if (typeof rawNote === "string" && rawNote.trim()) {
        note = rawNote.trim();
      }
      uploadedFiles = await readFormFilesAsDataUrl(form, "files", 5);
    } else {
      const rawJson = await req.json();
      const body = progressSchema.parse(rawJson);
      percent = body.percent;
      note = body.note;
      if (body.images && body.images.length > 0) {
        uploadedFiles = body.images.map((img, idx) => ({
          dataUrl: img.dataUrl,
          name: img.name || `photo-${Date.now()}-${idx}.jpg`,
          mimeType: img.mimeType || "image/jpeg",
          size: img.size || 0,
        }));
      }
    }

    if (isNaN(percent) || percent < 0 || percent > 100) {
      throw new ApiError(400, "VALIDATION_ERROR", "Відсоток виконання має бути числом від 0 до 100");
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!order) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    if (order.performerUserId !== user.id) {
      throw new ApiError(403, "FORBIDDEN", "Ви не є виконавцем цього замовлення");
    }

    if (!["started", "en_route"].includes(order.status)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Роботу ще не розпочато");
    }

    // Create progress update with media
    const createdProgress = await prisma.workProgressUpdate.create({
      data: {
        orderId,
        authorId: user.id,
        percent,
        comment: note || null,
        ...(uploadedFiles.length > 0
          ? {
              media: {
                create: uploadedFiles.map((f) => ({
                  orderId,
                  userId: user.id,
                  kind: "progress",
                  name: f.name,
                  mimeType: f.mimeType,
                  size: f.size,
                  url: f.dataUrl,
                })),
              },
            }
          : {}),
      },
      include: {
        media: {
          select: { id: true, url: true },
        },
      },
    });

    // Check if this is the first time reaching 30%
    const previousUpdates = await prisma.workProgressUpdate.count({
      where: { orderId, percent: { lt: 30 } },
    });

    const hasReached30 = percent >= 30;
    const wasBelow30 = previousUpdates > 0 || percent === 30;
    
    // Get previous max progress
    const previousMax = await prisma.workProgressUpdate.findFirst({
      where: { orderId },
      orderBy: { percent: "desc" },
      select: { percent: true },
    });

    const firstTime30 = hasReached30 && (!previousMax || previousMax.percent === null || previousMax.percent < 30);

    // Notify performer that they can request payment if first time 30%
    if (firstTime30) {
      notifyUser({
        userId: user.id,
        type: "progress.30_percent_reached",
        title: "Досягнуто 30% виконання",
        message: `Робота досягла 30% готовності. Ви можете запросити у замовника внесення оставшейся суми (70%).`,
        data: { orderId, orderNumber: order.orderNumber, percent },
      }).catch(() => {});
    }

    // Notify customer about progress
    if (percent > 0) {
      notifyUser({
        userId: order.customerUserId,
        type: "order.progress_updated",
        title: "Оновлення прогресу",
        message: `Виконавець повідомив про ${percent}% готовності роботи за замовленням #${order.orderNumber || orderId.substring(0,8)}`,
        data: { orderId, orderNumber: order.orderNumber, percent, role: "customer", action: "view_order" },
      }).catch(() => {});
    }

    // Publish domain event
    await publishDomainEvent({
      type: "order.progress_updated",
      requestId,
      targets: { userIds: [order.customerUserId, user.id] },
      data: {
        orderId,
        percent,
        note,
        actorId: user.id,
        title: "Оновлення прогресу",
        message: `Виконавець повідомив про ${percent}% готовності роботи`,
      },
    });

    return ok(req, { 
      progress: percent,
      canRequestPayment: hasReached30 && !order.customerPart2Deadline,
      message: hasReached30 ? "Досягнуто 30%! Ви можете запросити оплату оставшейся суми" : "Прогрес оновлено" 
    });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірні дані", err.flatten()));
    }
    return fail(req, err);
  }
}
