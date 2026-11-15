import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { isKnownEventType } from "@/lib/adminNotifications/catalog";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

const schema = z.object({
  eventType: z.string().min(1),
  enabled: z.boolean(),
});

/** Увімкнути або вимкнути один тип події для адміна. */
export async function PATCH(req: Request) {
  try {
    const admin = await requirePanelAdmin(req);
    const body = schema.parse(await req.json());
    if (!isKnownEventType(body.eventType)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Невідомий тип події");
    }
    await prisma.adminNotificationSetting.upsert({
      where: { adminId_eventType: { adminId: admin.id, eventType: body.eventType } },
      create: { adminId: admin.id, eventType: body.eventType, enabled: body.enabled },
      update: { enabled: body.enabled },
    });
    return ok(req, { eventType: body.eventType, enabled: body.enabled });
  } catch (err) {
    return fail(req, err);
  }
}
