import { z } from "zod";
import { fail, getRequestId, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { ApiError, notifyUser, orderRef, prisma, publishDomainEvent } from "@/shared";
import { responseDueAt } from "@/lib/arbitrationDeadlines";

export const runtime = "nodejs";

const schema = z.object({
  text: z.string().trim().min(1).max(5000),
  /** common — обом учасникам; customer/performer — лише цьому учаснику (приватна гілка). */
  channel: z.enum(["common", "customer", "performer"]).default("common"),
});

/** Повідомлення адміністратора в кейсі: бачать обидві сторони. */
export async function POST(req: Request, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const requestId = getRequestId(req);
    const { caseId } = await ctx.params;
    const { text, channel } = schema.parse(await req.json().catch(() => null));

    const arbitrationCase = await prisma.arbitrationCase.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        orderId: true,
        status: true,
        order: { select: { customerUserId: true, performerUserId: true } },
      },
    });
    if (!arbitrationCase) throw new ApiError(404, "NOT_FOUND", "Арбітражний кейс не знайдено");
    if (!["open", "admin_assigned"].includes(arbitrationCase.status)) {
      throw new ApiError(409, "CONFLICT", "Кейс уже закрито");
    }

    const message = await prisma.$transaction(async (tx) => {
      // Відповідь адміна ставить строк відповіді адресатам (24 год).
      const due = responseDueAt();
      await tx.arbitrationCase.update({
        where: { id: caseId },
        data: {
          status: "admin_assigned",
          assigneeAdminId: admin.id,
          ...(channel !== "performer" ? { customerResponseDueAt: due } : {}),
          ...(channel !== "customer" ? { performerResponseDueAt: due } : {}),
        },
      });
      return tx.arbitrationMessage.create({
        data: { arbitrationCaseId: caseId, adminId: admin.id, text, channel },
        select: { id: true, text: true, createdAt: true },
      });
    });

    const { customerUserId, performerUserId } = arbitrationCase.order;
    const allParties = [customerUserId, performerUserId].filter((id): id is string => Boolean(id));
    const recipients =
      channel === "common"
        ? allParties
        : allParties.filter((id) => (channel === "customer" ? id === customerUserId : id === performerUserId));
    const number = await orderRef(arbitrationCase.orderId);
    for (const userId of recipients) {
      await notifyUser({
        userId,
        type: "arbitration",
        title: "Арбітраж: відповідь адміністратора",
        message: `Замовлення ${number}. ${text.slice(0, 160)}`,
        data: { orderId: arbitrationCase.orderId, type: "arbitration_admin_message", caseId, channel, action: "view_order" },
      });
    }

    await publishDomainEvent({
      type: "arbitration.message.created",
      requestId,
      targets: { userIds: recipients },
      data: { orderId: arbitrationCase.orderId, caseId, messageId: message.id, adminId: admin.id },
    });

    return ok(req, { message }, { status: 201, message: "Надіслано" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Введіть текст повідомлення", err.flatten()));
    }
    return fail(req, err);
  }
}
