import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { notifyUser } from "@/services/notify";

const requestSchema = z.object({
  amount: z.number().positive(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    
    if (user.role !== "performer") {
      throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    }

    const body = requestSchema.parse(await req.json());

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, name: true, expoPushToken: true } },
        progressUpdates: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    if (!order) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    if (order.performerUserId !== user.id) {
      throw new ApiError(403, "FORBIDDEN", "Ви не є виконавцем цього замовлення");
    }

    // Check if already has a pending payment request
    const existingRequest = await prisma.paymentRequest.findFirst({
      where: { orderId, requestedBy: user.id, status: "pending" },
    });

    if (existingRequest) {
      throw new ApiError(409, "CONFLICT", "Запит на оплату вже існує");
    }

    // Check if customer already paid part 2
    if (order.customerPart2Deadline) {
      throw new ApiError(400, "BAD_REQUEST", "Замовник вже має відкритий запит на доплату");
    }

    // Create payment request
    const paymentRequest = await prisma.paymentRequest.create({
      data: {
        orderId,
        requestedBy: user.id,
        requestedAmount: body.amount,
        status: "pending",
      },
    });

    // Update order to set customerPart2Deadline
    const deadline = new Date();
    deadline.setHours(deadline.getHours() + 24); // 24 hours to pay

    await prisma.order.update({
      where: { id: orderId },
      data: { customerPart2Deadline: deadline },
    });

    // Notify customer
    notifyUser({
      userId: order.customerUserId,
      type: "payment.part2_requested",
      title: "Запит на доплату",
      message: `Виконавець досяг 30% готовності та запросив внесення оставшейся суми ${body.amount}₴. У вас є 24 години для оплати.`,
      data: { 
        orderId, 
        orderNumber: order.orderNumber,
        amount: body.amount,
        deadline: deadline.toISOString(),
        screen: "order-payment",
      },
    }).catch(() => {});

    // Notify performer
    notifyUser({
      userId: user.id,
      type: "payment.request_sent",
      title: "Запит надіслано",
      message: `Замовнику надіслано запит на оплату ${body.amount}₴. Чекаємо на оплату протягом 24 годин.`,
      data: { orderId, amount: body.amount },
    }).catch(() => {});

    return ok(req, { 
      paymentRequest: {
        id: paymentRequest.id,
        amount: body.amount,
        deadline: deadline.toISOString(),
        status: "pending",
      },
      message: "Запит на оплату надіслано замовнику" 
    });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірні дані", err.flatten()));
    }
    return fail(req, err);
  }
}
