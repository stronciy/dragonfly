import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, publishDomainEvent, notifyUser, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { acceptApplication, serializeApplication } from "@/services/application.service";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ orderId: string; applicationId: string }> }
) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId, applicationId } = await ctx.params;

    const { order, application } = await acceptApplication({
      orderId,
      customerUserId: user.id,
      applicationId,
    });

    const targets = { userIds: [order.customerUserId, application.performerUserId] };
    await publishDomainEvent({
      type: "order.application_accepted",
      requestId,
      targets,
      data: { orderId, applicationId, performerId: application.performerUserId },
    });
    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets,
      data: { orderId, fromStatus: "published", toStatus: "accepted" },
    });
    await publishDomainEvent({
      type: "order.accepted",
      requestId,
      targets,
      data: { orderId, performerId: application.performerUserId },
    });
    await publishDomainEvent({
      type: "order:accepted",
      requestId,
      targets,
      data: { orderId, performerId: application.performerUserId },
    });

    await notifyUser({
      userId: application.performerUserId,
      type: "application",
      title: "Заявку прийнято",
      message: `Замовлення ${await orderRef(orderId)}. Замовник обрав вас виконавцем — внесіть гарантійну суму.`,
      data: {
        orderId,
        applicationId,
        type: "order_application_accepted",
        role: "performer",
        action: "pay_deposit",
      },
    });

    const orderSummary = {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      performerUserId: order.performerUserId,
      acceptedAt: order.acceptedAt,
      depositDeadline: order.depositDeadline,
    };

    return ok(
      req,
      { order: orderSummary, application: serializeApplication(application) },
      { message: "Заявку прийнято" }
    );
  } catch (err) {
    return fail(req, err);
  }
}
