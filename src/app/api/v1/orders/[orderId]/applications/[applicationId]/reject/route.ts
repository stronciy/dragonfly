import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, publishDomainEvent, notifyUser, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { rejectApplication, serializeApplication } from "@/services/application.service";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ orderId: string; applicationId: string }> }
) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId, applicationId } = await ctx.params;

    const application = await rejectApplication({
      orderId,
      customerUserId: user.id,
      applicationId,
    });

    await publishDomainEvent({
      type: "order.application_rejected",
      requestId,
      targets: { userIds: [application.performerUserId] },
      data: { orderId, applicationId, performerId: application.performerUserId },
    });
    await notifyUser({
      userId: application.performerUserId,
      type: "application",
      title: "Заявку відхилено",
      message: `Замовлення ${await orderRef(orderId)}. Замовник відхилив вашу заявку на виконання.`,
      data: {
        orderId,
        applicationId,
        type: "order_application_rejected",
        role: "performer",
        action: "view_order",
      },
    });

    return ok(req, { application: serializeApplication(application) });
  } catch (err) {
    return fail(req, err);
  }
}
