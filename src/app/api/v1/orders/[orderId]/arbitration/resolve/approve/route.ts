import { fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";

/**
 * approve: сторони більше не вирішують спір самі — рішення ухвалює лише адміністратор
 * (POST /admin/arbitration/:caseId/ruling). Маршрут лишається, щоб старі збірки отримали
 * зрозуміла відповідь, а не 404.
 */
export async function POST(req: Request, _ctx?: unknown) {
  return fail(req, new ApiError(403, "FORBIDDEN", "Рішення в арбітражі ухвалює адміністратор. Сторони передають пояснення в чат арбітражу."));
}
