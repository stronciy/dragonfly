import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { notifyUser } from "@/services/notify";

const withdrawSchema = z.object({
  amount: z.number().positive(),
  iban: z.string().regex(/^UA\d{27}$/, "Невірний формат IBAN"),
  accountName: z.string().min(2).max(100),
});

export async function POST(req: Request) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const body = withdrawSchema.parse(await req.json());

    // Get user's legal profile for IBAN verification
    const legalProfile = await prisma.legalProfile.findUnique({
      where: { userId: user.id },
    });

    if (!legalProfile) {
      throw new ApiError(400, "BAD_REQUEST", "Необхідно заповнити юридичний профіль з платіжними реквізитами");
    }

    // Verify IBAN matches legal profile
    const normalizedIban = body.iban.replace(/\s/g, '').toUpperCase();
    const normalizedLegalIban = (legalProfile.iban || '').replace(/\s/g, '').toUpperCase();
    
    if (normalizedIban !== normalizedLegalIban) {
      throw new ApiError(400, "BAD_REQUEST", "IBAN не відповідає юридичному профілю");
    }

    // Get wallet
    const wallet = await prisma.wallet.findUnique({
      where: { userId: user.id },
    });

    if (!wallet || wallet.balance < body.amount) {
      throw new ApiError(400, "BAD_REQUEST", "Недостатньо коштів на балансі");
    }

    // Check if amount is above minimum (e.g., 100 UAH)
    if (body.amount < 100) {
      throw new ApiError(400, "BAD_REQUEST", "Мінімальна сума для виведення - 100₴");
    }

    // Process withdrawal
    const result = await prisma.$transaction(async (tx) => {
      // Deduct from wallet
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { decrement: body.amount } },
      });

      // Create withdrawal transaction (as pending)
      const transaction = await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: "withdrawal",
          amount: -body.amount,
          currency: "UAH",
          description: `Виведення коштів на IBAN: ${body.iban.substring(0, 8)}****`,
          status: "pending", // Admin will approve/process
          metadata: {
            iban: body.iban,
            accountName: body.accountName,
            requestId,
          },
        },
      });

      return { wallet: updatedWallet, transaction };
    });

    // Notify user
    notifyUser({
      userId: user.id,
      type: "wallet.withdrawal_started",
      title: "Запит на виведення створено",
      message: `Запит на виведення ${body.amount.toFixed(2)}₴ створено та очікує обробки адміністратором.`,
      data: { 
        transactionId: result.transaction.id,
        amount: body.amount,
        status: "pending",
      },
    }).catch(() => {});

    // Notify admin
    notifyUser({
      userId: "admin", // System will route to admins
      type: "admin.withdrawal_request",
      title: "Новий запит на виведення",
      message: `Користувач ${user.name || user.email} запросив виведення ${body.amount.toFixed(2)}₴`,
      data: {
        userId: user.id,
        transactionId: result.transaction.id,
        amount: body.amount,
        iban: body.iban,
      },
    }).catch(() => {});

    return ok(req, {
      transaction: {
        id: result.transaction.id,
        amount: body.amount,
        status: "pending",
        iban: body.iban.substring(0, 8) + "****",
      },
      wallet: {
        balance: result.wallet.balance,
      },
      message: "Запит на виведення створено та очікує обробки"
    });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Невірні дані", err.flatten()));
    }
    return fail(req, err);
  }
}
