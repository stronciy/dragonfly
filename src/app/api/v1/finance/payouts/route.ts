import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";
import { ApiError, prisma } from "@/shared";
import { requestPayout } from "@/services/finance.service";
import { notifyUser } from "@/services/notify";

const createSchema = z.object({
  amount: z.number().positive().max(1_000_000),
});

/** Список заявок виконавця на виведення. */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Виведення доступне лише виконавцю");
    const payouts = await prisma.payout.findMany({
      where: { userId: user.id },
      orderBy: { requestedAt: "desc" },
      take: 50,
      select: {
        id: true,
        amount: true,
        currency: true,
        iban: true,
        status: true,
        requestedAt: true,
        processedAt: true,
        rejectReason: true,
      },
    });
    return ok(req, {
      payouts: payouts.map((p) => ({
        ...p,
        amount: Number(p.amount),
        iban: `${p.iban.slice(0, 4)}…${p.iban.slice(-4)}`,
      })),
    });
  } catch (err) {
    return fail(req, err);
  }
}

/** Створити заявку на виведення коштів на IBAN з юридичного профілю. */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Виведення доступне лише виконавцю");
    const body = createSchema.parse(await req.json());

    const payout = await requestPayout({ userId: user.id, amount: body.amount });

    notifyUser({
      userId: user.id,
      type: "wallet.withdrawal_requested",
      title: "Заявку на виведення прийнято",
      message: `Заявку на виведення ${Number(payout.amount).toFixed(2)} ₴ прийнято. Очікуйте переказу на ваш рахунок.`,
      data: { payoutId: payout.id, amount: Number(payout.amount), status: "requested", action: "view_finance" },
    }).catch(() => {});

    return ok(
      req,
      { payout: { id: payout.id, amount: Number(payout.amount), status: payout.status, requestedAt: payout.requestedAt } },
      { status: 201, message: "Заявку на виведення створено" }
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірна сума", err.flatten()));
    }
    return fail(req, err);
  }
}
