import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { publishDomainEvent } from "@/realtime/publishDomainEvent";

const createSchema = z.object({
  reason: z.string().min(1),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ orderId: string }> }
) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer" && user.role !== "performer") {
      throw new ApiError(403, "FORBIDDEN", "Customer or performer role required");
    }

    const params = await ctx.params;
    const orderId = params.orderId;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        customerUserId: true,
        performerUserId: true,
      },
    });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    // Only allow opening arbitration for active orders
    if (!["confirmed", "started", "en_route", "completed"].includes(order.status)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Арбітраж можна відкрити тільки для активних замовлень");
    }

    const body = createSchema.parse(await req.json());

    // Check if there's already an open arbitration case
    const existingCase = await prisma.arbitrationCase.findFirst({
      where: {
        orderId,
        status: { in: ["open", "admin_assigned"] },
      },
    });
    if (existingCase) {
      throw new ApiError(409, "CONFLICT", "Відкритий арбітражний кейс вже існує");
    }

    const [caseRecord, firstMessage] = await prisma.$transaction([
      prisma.arbitrationCase.create({
        data: {
          orderId,
          openedByUserId: user.id,
          status: "open",
        },
        select: {
          id: true,
          createdAt: true,
          status: true,
          order: {
            select: {
              orderNumber: true,
            },
          },
        },
      }),
      prisma.arbitrationMessage.create({
        data: {
          arbitrationCaseId: "", // placeholder - will be updated
          userId: user.id,
          text: body.reason,
        },
        select: {
          id: true,
          createdAt: true,
          text: true,
          user: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
    ]);

    // Update the message with proper caseId
    await prisma.arbitrationMessage.update({
      where: { id: firstMessage.id },
      data: { arbitrationCaseId: caseRecord.id },
    });

    // Publish domain event for real-time updates
    await publishDomainEvent({
      type: "arbitration.created",
      requestId: getRequestId(req),
      targets: { userIds: [order.customerUserId, order.performerUserId!] },
      data: {
        arbitrationCaseId: caseRecord.id,
        orderId,
        openedByUserId: user.id,
      },
    });

    return ok(req, { case: caseRecord, firstMessage }, { status: 201, message: "Арбітраж відкрито" });
  } catch (err) {
    if (err instanceof z.ZodError)
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "...", err.flatten()));
    return fail(req, err);
  }
}

// GET /api/v1/orders/:orderId/arbitration - Get case details and messages
export async function GET(
  req: Request,
  ctx: { params: Promise<{ orderId: string }> }
) {
  try {
    const user = await requireUser(req);
    const params = await ctx.params;
    const orderId = params.orderId;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        customerUserId: true,
        performerUserId: true,
      },
    });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    // Check if user is involved
    if (
      user.id !== order.customerUserId &&
      user.id !== order.performerUserId
    ) {
      throw new ApiError(403, "FORBIDDEN", "У вас немає доступу до цього арбітражу");
    }

    const [caseRecord, messages] = await Promise.all([
      prisma.arbitrationCase.findFirst({
        where: { orderId },
        select: {
          id: true,
          status: true,
          createdAt: true,
          resolvedAt: true,
          closedAt: true,
          assigneeAdmin: {
            select: {
              id: true,
              email: true,
            },
          },
          ruling: {
            select: {
              id: true,
              decision: true,
              reason: true,
              rating: true,
              comment: true,
              createdAt: true,
              admin: {
                select: {
                  id: true,
                  email: true,
                },
              },
            },
          },
        },
      }),
      prisma.arbitrationMessage.findMany({
        where: { arbitrationCase: { orderId } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          text: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
          admin: {
            select: {
              id: true,
              email: true,
            },
          },
          media: {
            select: {
              id: true,
              url: true,
              mimeType: true,
              name: true,
            },
          },
        },
      }),
    ]);

    if (!caseRecord) {
      throw new ApiError(404, "NOT_FOUND", "Арбітражний кейс не знайдено");
    }

    return ok(req, {
      case: caseRecord,
      messages,
    });
  } catch (err) {
    return fail(req, err);
  }
}

// PATCH /api/v1/orders/:orderId/arbitration - Add message to existing case
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ orderId: string }> }
) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer" && user.role !== "performer") {
      throw new ApiError(403, "FORBIDDEN", "Customer or performer role required");
    }

    const params = await ctx.params;
    const orderId = params.orderId;

    const [caseRecord, order] = await Promise.all([
      prisma.arbitrationCase.findFirst({
        where: {
          orderId,
          status: { in: ["open", "admin_assigned"] },
        },
        select: { id: true },
      }),
      prisma.order.findUnique({
        where: { id: orderId },
        select: { customerUserId: true, performerUserId: true },
      }),
    ]);

    if (!caseRecord || !order) {
      throw new ApiError(404, "NOT_FOUND", "Арбітражний кейс не знайдено або завершено");
    }

    const body = createSchema.parse(await req.json());

    const message = await prisma.arbitrationMessage.create({
      data: {
        arbitrationCaseId: caseRecord.id,
        userId: user.id,
        text: body.reason,
      },
      select: {
        id: true,
        text: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
    });

    // Publish domain event for real-time updates
    await publishDomainEvent({
      type: "arbitration.message.created",
      requestId: getRequestId(req),
      targets: {
        userIds: [
          order.customerUserId,
          order.performerUserId!,
        ],
      },
      data: {
        arbitrationCaseId: caseRecord.id,
        message: {
          id: message.id,
          text: message.text,
          createdAt: message.createdAt,
          user: message.user,
        },
      },
    });

    return ok(req, { message }, { status: 201, message: "Повідомлення надіслано" });
  } catch (err) {
    if (err instanceof z.ZodError)
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "...", err.flatten()));
    return fail(req, err);
  }
}
