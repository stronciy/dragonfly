import { fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";

// Залишок 70% (для замовлень понад 2 днів) тепер вимагається автоматично з
// моменту старту робіт і має бути сплачений до кінця третього дня. Ручний запит
// виконавця більше не потрібен, тому роут лишається лише для сумісності зі
// старими клієнтами.
export async function POST(req: Request, _ctx: { params: Promise<{ orderId: string }> }) {
  try {
    await requireUser(req);
    throw new ApiError(
      409,
      "CONFLICT",
      "Залишок оплачується автоматично після старту робіт. Запит на оплату не потрібен"
    );
  } catch (err) {
    return fail(req, err);
  }
}
