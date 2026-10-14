import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import { readFormFilesAsDataUrl } from "@/lib/uploads";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || (order.customerUserId !== user.id && order.performerUserId !== user.id)) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    const items = await prisma.workProgressUpdate.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      include: {
        media: { select: { id: true, url: true, mimeType: true, name: true, createdAt: true } },
      },
    });
    return ok(req, {
      progress: items.map((p) => ({
        id: p.id,
        percent: p.percent,
        comment: p.comment,
        createdAt: p.createdAt,
        media: p.media,
      })),
    });
  } catch (err) {
    return fail(req, err);
  }
}

const MAX_FILES = 5;

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    if (order.status !== "started") {
      throw new ApiError(409, "CONFLICT", "Про прогрес можна звітувати лише після старту робіт");
    }

    const form = await req.formData();
    const percentRaw = form.get("percent");
    const commentRaw = form.get("comment");
    const percent =
      percentRaw == null || percentRaw === ""
        ? null
        : (() => {
            const n = Number(percentRaw);
            if (!Number.isInteger(n) || n < 0 || n > 100) {
              throw new ApiError(400, "VALIDATION_ERROR", "Відсоток має бути цілим числом 0–100");
            }
            return n;
          })();
    const comment = typeof commentRaw === "string" && commentRaw.trim() ? commentRaw.trim().slice(0, 2000) : null;
    const files = await readFormFilesAsDataUrl(form, "files", MAX_FILES);
    if (!comment && files.length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "Додайте коментар або хоча б одне фото");
    }

    const created = await prisma.workProgressUpdate.create({
      data: { orderId, authorId: user.id, percent, comment },
    });
    if (files.length > 0) {
      await prisma.orderMedia.createMany({
        data: files.map((f) => ({
          orderId,
          userId: user.id,
          kind: "progress" as const,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          url: f.dataUrl,
          progressId: created.id,
        })),
      });
    }

    await notifyUser({
      userId: order.customerUserId,
      type: "order",
      title: `Прогрес робіт${percent != null ? ` ${percent}%` : ""}`.trim(),
      message: `Замовлення ${await orderRef(orderId)}. ${comment ?? "Виконавець додав фото прогресу."}`.slice(0, 500),
      data: { orderId, type: "order_progress_updated", role: "customer", progressId: created.id },
    });
    await publishDomainEvent({
      type: "order.progress_updated",
      requestId,
      targets: { userIds: [order.customerUserId] },
      data: { orderId, progressId: created.id },
    });

    return ok(req, { progress: { id: created.id } }, { status: 201, message: "Про прогрес повідомлено" });
  } catch (err) {
    return fail(req, err);
  }
}
