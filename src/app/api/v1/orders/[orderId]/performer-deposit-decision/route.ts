import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { decidePerformerDeposit } from "@/services/performerDepositDecision";

export const runtime = "nodejs";

const schema = z.object({
  decision: z.enum(["return", "fine"]),
});

/** Заказчик повертає заставу виконавцю (`return`) або утримує її як штраф (`fine`). */
export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль заказчика");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const result = await decidePerformerDeposit({
      orderId,
      customerUserId: user.id,
      decision: body.decision,
      requestId,
    });
    return ok(req, { performerDeposit: result }, { message: "Рішення збережено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
