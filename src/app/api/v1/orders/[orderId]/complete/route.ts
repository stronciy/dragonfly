import { fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";

/**
 * Застарілий шлях «завершити заказ» (сумісність). Вимкнено: він завершував заказ
 * без підтвердження заказчика і нараховував кошти в окремий гаманець, який
 * більше не є джерелом виплат. Завершення — PATCH /orders/:id/status
 * (completed), підтвердження — POST /orders/:id/confirm-completion.
 */
export async function POST(req: Request, _ctx: { params: Promise<{ orderId: string }> }) {
  return fail(
    req,
    new ApiError(410, "GONE", "Цей спосіб завершення вимкнено. Завершіть роботу в застосунку, заказчик підтверджує результат окремо.")
  );
}
