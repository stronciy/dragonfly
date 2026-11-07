import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { notifyUser } from "@/services/notify";

/**
 * Виконавець надсилає фотозвіт замовнику. Звіт складається з фото, завантажених
 * через /report/media. Надіслати можна один раз і лише під час або після робіт.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, customerUserId: true, performerUserId: true, reportSubmittedAt: true },
    });
    if (!order || order.performerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    if (order.status !== "started" && order.status !== "completed") {
      throw new ApiError(409, "CONFLICT", "Звіт можна надіслати лише під час або після виконання робіт");
    }
    if (order.reportSubmittedAt) throw new ApiError(409, "CONFLICT", "Звіт вже надіслано замовнику");

    const photoCount = await prisma.orderMedia.count({ where: { orderId, kind: "report" } });
    if (photoCount === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "Додайте хоча б одне фото до звіту");
    }

    const now = new Date();
    // Атомарне «захоплення» відправки: паралельний запит отримає 409, а не
    // подвійне сповіщення.
    const claimed = await prisma.order.updateMany({
      where: { id: orderId, reportSubmittedAt: null },
      data: { reportSubmittedAt: now },
    });
    if (claimed.count !== 1) throw new ApiError(409, "CONFLICT", "Звіт вже надіслано замовнику");

    await prisma.orderStatusEvent.create({
      data: { orderId, status: order.status, note: `Звіт виконавця надіслано (${photoCount} фото)` },
    });

    await notifyUser({
      userId: order.customerUserId,
      type: "order",
      title: "Звіт виконавця",
      message: `Виконавець надіслав фотозвіт (${photoCount} фото). Перегляньте результати робіт.`,
      data: { orderId, type: "report_submitted", role: "customer", action: "view_order", photoCount, requestId },
    }).catch(() => {});

    return ok(
      req,
      { report: { orderId, status: "submitted", submittedAt: now.toISOString(), photoCount } },
      { message: "Звіт надіслано замовнику" }
    );
  } catch (err) {
    return fail(req, err);
  }
}
