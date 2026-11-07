import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { requestPayout } from "@/services/finance.service";

const withdrawSchema = z.object({
  amount: z.number().positive(),
  iban: z.string().regex(/^UA\d{27}$/, "Невірний формат IBAN"),
  accountName: z.string().min(2).max(100).optional(),
});

/**
 * Застарілий шлях виведення (сумісність зі старими клієнтами). Виконує той самий
 * сервіс, що й /finance/payouts: баланс беремо з журналу, а не з окремого
 * гаманця, який ніхто не поповнює.
 */
export async function POST(req: Request) {
  try {
    getRequestId(req);
    const user = await requireUser(req);
    const body = withdrawSchema.parse(await req.json());

    const legalProfile = await prisma.legalProfile.findUnique({
      where: { userId: user.id },
      select: { iban: true },
    });
    if (!legalProfile) {
      throw new ApiError(400, "VALIDATION_ERROR", "Необхідно заповнити юридичний профіль з платіжними реквізитами");
    }
    const normalizedIban = body.iban.replace(/\s/g, "").toUpperCase();
    const normalizedLegalIban = (legalProfile.iban ?? "").replace(/\s/g, "").toUpperCase();
    if (normalizedIban !== normalizedLegalIban) {
      throw new ApiError(400, "VALIDATION_ERROR", "IBAN не відповідає юридичному профілю");
    }

    const payout = await requestPayout({ userId: user.id, amount: body.amount });

    return ok(req, {
      transaction: {
        id: payout.id,
        amount: Number(payout.amount),
        status: "pending",
        iban: `${normalizedIban.slice(0, 8)}****`,
      },
      message: "Запит на виведення створено та очікує обробки",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірні дані", err.flatten()));
    }
    return fail(req, err);
  }
}
