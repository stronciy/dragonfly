import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, customerPaymentPlan, part2DeadlineFor, orderRef } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { notifyUser } from "@/services/notify";
import { publishWalletChanged } from "@/services/payoutEvents";
import { publishDomainEvent } from "@/shared";
import { readFormFilesAsDataUrl } from "@/lib/uploads";

export const runtime = "nodejs";

const progressSchema = z.object({
  percent: z.number().refine((val) => val === 30 || val === 100, {
    message: "Дозволені тільки етапи 30% або 100%",
  }),
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
  const startedAt = Date.now();
  const requestId = getRequestId(req);
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

    // Run both queries in parallel: the order page needs the full history and
    // every attached photo in a single round trip.
    const [progress, allOrderMedia] = await Promise.all([
      prisma.workProgressUpdate.findMany({
        where: { orderId },
        orderBy: { createdAt: "asc" },
        include: {
          media: {
            select: { id: true, url: true },
          },
        },
      }),
      prisma.orderMedia.findMany({
        where: { orderId, kind: { in: ["progress", "report"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, url: true, progressId: true },
      }),
    ]);

    // Legacy clients uploaded the same photo twice (once as progress media and
    // once as report media). Deduplicate by URL so the timeline and payload stay
    // small and the customer doesn't see duplicated thumbnails.
    const progressList = progress.map((p) => {
      const seen = new Set<string>();
      return {
        ...p,
        media: p.media.filter((m) => {
          const key = m.url || m.id;
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    });

    const existingIds = new Set<string>();
    const existingUrls = new Set<string>();
    for (const p of progressList) {
      for (const m of p.media) {
        existingIds.add(m.id);
        if (m.url) existingUrls.add(m.url);
      }
    }

    const missingMedia: { id: string; url: string; progressId: string | null }[] = [];
    const seenMissing = new Set<string>();
    for (const m of allOrderMedia) {
      if (existingIds.has(m.id)) continue;
      const key = m.url || m.id;
      if (!key || existingUrls.has(key) || seenMissing.has(key)) continue;
      seenMissing.add(key);
      missingMedia.push(m);
    }

    if (missingMedia.length > 0) {
      if (progressList.length > 0) {
        const last = progressList[progressList.length - 1];
        for (const m of missingMedia) {
          const target = m.progressId ? progressList.find((p) => p.id === m.progressId) || last : last;
          target.media.push({ id: m.id, url: m.url });
        }
      } else {
        progressList.push({
          id: "unlinked-media",
          orderId,
          authorId: order.performerUserId || order.customerUserId,
          percent: 0,
          comment: "Фотозвіт робіт",
          createdAt: new Date(),
          media: missingMedia.map((m) => ({ id: m.id, url: m.url })),
        });
      }
    }

    const photoCount = progressList.reduce((sum, p) => sum + p.media.length, 0);
    console.info(
      `[api] GET /api/v1/orders/${orderId}/progress requestId=${requestId} userId=${user.id} role=${user.role} updates=${progressList.length} photos=${photoCount} durationMs=${Date.now() - startedAt}`
    );

    return ok(req, {
      progress: progressList,
      /** New clients can skip the /report fallback when this is true. */
      supportsLinkedPhotos: true,
    });
  } catch (err) {
    return fail(req, err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  const startedAt = Date.now();
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    console.info(
      `[api] POST /api/v1/orders/${orderId}/progress received requestId=${requestId} userId=${user.id} role=${user.role} contentType=${req.headers.get("content-type") || ""}`
    );
    
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

    if (isNaN(percent) || (percent !== 30 && percent !== 100)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Дозволені тільки етапи 30% або 100%");
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

    const plan = customerPaymentPlan(order.budget, order.dateFrom, order.dateTo);
    const isSplit = plan.mode === "split";
    const part2PaidIntent = isSplit
      ? await prisma.paymentIntent.findFirst({
          where: { orderId, role: "customer", part: 2, status: "paid" },
          select: { id: true },
        })
      : null;
    const isPart2Paid = !isSplit || !!part2PaidIntent;

    // Якщо замовлення триває > 2 діб, фіксувати 100% дозволено ТІЛЬКИ після внесення замовником 70%
    if (percent === 100 && isSplit && !isPart2Paid) {
      throw new ApiError(
        409,
        "CONFLICT",
        "Неможливо зафіксувати 100% виконання: замовник ще не вніс залишок 70% в ескроу-гарантію. Ви маєте право завершити замовлення через арбітраж."
      );
    }

    // Check previous maximum progress: progress cannot decrease
    const previousMax = await prisma.workProgressUpdate.findFirst({
      where: { orderId, percent: { not: null } },
      orderBy: { percent: "desc" },
      select: { percent: true },
    });

    if (previousMax?.percent != null && percent < previousMax.percent) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `Відсоток виконання не може бути меншим за раніше зафіксований (${previousMax.percent}%)`
      );
    }

    const firstTime30 = percent === 30 && (!previousMax || previousMax.percent === null || previousMax.percent < 30);

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

    const hasReached30 = percent >= 30;
    const needsPart2Request = isSplit;

    console.info(
      `[api] POST /api/v1/orders/${orderId}/progress created requestId=${requestId} progressId=${createdProgress.id} userId=${user.id} percent=${percent} photos=${createdProgress.media.length} first30=${firstTime30} durationMs=${Date.now() - startedAt}`
    );

    let part2Deadline: Date | null = null;
    if (hasReached30 && needsPart2Request && !order.customerPart2Deadline && !isPart2Paid) {
      part2Deadline = part2DeadlineFor(new Date());
      await prisma.order.update({
        where: { id: orderId },
        data: { customerPart2Deadline: part2Deadline },
      });

      const ref = await orderRef(orderId);
      const deadlineLabel = part2Deadline.toLocaleString("uk-UA", {
        timeZone: "Europe/Kyiv",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      // Повідомляємо замовника про 24-годинний строк на внесення залишку 70%
      notifyUser({
        userId: order.customerUserId,
        type: "payment",
        title: "Внесення залишку 70%",
        message: `Замовлення ${ref}. Виконавець розпочав роботу. Внесіть залишок 70% (${Number(plan.part2Amount)} ₴) в ескроу протягом 24 годин (до ${deadlineLabel}). Якщо кошти не надійдуть у строк, виконавець має право припинити роботи та покинути об'єкт.`,
        data: {
          orderId,
          amount: Number(plan.part2Amount),
          deadline: part2Deadline.toISOString(),
          role: "customer",
          action: "pay_part2",
        },
      }).catch(() => {});

      await publishDomainEvent({
        type: "deposit.customer_part2_required",
        requestId,
        targets: { userIds: [order.customerUserId, user.id] },
        data: {
          orderId,
          amount: Number(plan.part2Amount),
          deadline: part2Deadline.toISOString(),
        },
      });
    }

    if (firstTime30 && needsPart2Request) {
      await publishWalletChanged({ userId: user.id, orderId });
      const deadline = order.customerPart2Deadline || part2Deadline;
      const isOverdue = deadline ? new Date(deadline).getTime() < Date.now() : false;
      notifyUser({
        userId: user.id,
        type: "progress.30_percent_reached",
        title: "Досягнуто 30% виконання",
        message: isPart2Paid
          ? "Робота досягла 30% готовності. Після підтвердження Замовником 30% вартості замовлення буде зараховано на баланс гаманця. Залишок 70% уже внесено в ескроу — ви можете виконувати роботи до 100%."
          : isOverdue
            ? "Робота досягла 30% готовності. Після підтвердження Замовником 30% вартості замовлення буде зараховано на баланс гаманця. Замовник не вніс залишок 70% у встановлений строк — ви маєте право покинути об'єкт та завершити замовлення через арбітраж."
            : "Робота досягла 30% готовності. Після підтвердження Замовником 30% вартості замовлення буде зараховано на баланс гаманця. Очікується внесення замовником залишку 70%.",
        data: { orderId, orderNumber: order.orderNumber, percent, canArbitrate: !isPart2Paid },
      }).catch(() => {});
    }

    // Перші 30% замовник підтверджує окремо — після цього вони списуються на
    // рахунок компанії і стають доступні виконавцю.
    if (firstTime30 && needsPart2Request) {
      notifyUser({
        userId: order.customerUserId,
        type: "order",
        title: "Підтвердіть виконання 30% робіт",
        message: `Замовлення ${await orderRef(orderId)}. Виконавець зафіксував 30% готовності. Перевірте фотозвіт і підтвердіть 30% робіт — 30% оплати буде перераховано Виконавцю. Якщо роботу виконано неналежно, відкрийте арбітраж.`,
        data: { orderId, orderNumber: order.orderNumber, percent, role: "customer", action: "confirm_part1" },
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
      canRequestPayment: needsPart2Request && hasReached30 && !(order.customerPart2Deadline || part2Deadline),
      part2Paid: isPart2Paid,
      canArbitrate: needsPart2Request && !isPart2Paid,
      customerPart2Deadline: (part2Deadline || order.customerPart2Deadline)?.toISOString() ?? null,
      /** How many photos were actually linked to this progress update. */
      savedPhotos: createdProgress.media.length,
      photoCount: createdProgress.media.length,
      update: {
        id: createdProgress.id,
        percent: createdProgress.percent,
        comment: createdProgress.comment,
        createdAt: createdProgress.createdAt,
      },
      message: hasReached30 && needsPart2Request
        ? (isPart2Paid ? "Досягнуто 30%! Гарантію 70% внесено" : "Досягнуто 30%! Очікується сплата залишку 70%")
        : "Прогрес оновлено",
    });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірні дані", err.flatten()));
    }
    return fail(req, err);
  }
}
