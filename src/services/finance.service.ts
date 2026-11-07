import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/errors";
import {
  buildLedger,
  summarizeLedger,
  type LedgerInput,
  type LedgerRole,
} from "../lib/finance/ledger";
import { normalizeUAIban, validateUAIban } from "../lib/validators";

type Client = Prisma.TransactionClient | typeof prisma;

export const PAYOUT_MIN_AMOUNT_UAH = 100;

/** Збирає вхідні дані журналу для користувача в його поточній ролі. */
export async function loadLedgerInput(
  client: Client,
  userId: string,
  role: LedgerRole
): Promise<LedgerInput> {
  const orderWhere: Prisma.OrderWhereInput =
    role === "performer"
      ? {
          OR: [
            { performerUserId: userId },
            { escrowLocks: { some: { userId, role: "performer" } } },
          ],
        }
      : { customerUserId: userId };
  const orders = await client.order.findMany({
    where: orderWhere,
    select: {
      id: true,
      orderNumber: true,
      customerUserId: true,
      performerUserId: true,
      budget: true,
      dateFrom: true,
      dateTo: true,
    },
  });
  const orderIds = orders.map((o) => o.id);

  const [intents, locks, payouts] = await Promise.all([
    orderIds.length
      ? client.paymentIntent.findMany({
          where: { orderId: { in: orderIds }, status: "paid" },
          select: {
            id: true,
            orderId: true,
            role: true,
            part: true,
            amount: true,
            depositAmount: true,
            feeAmount: true,
            currency: true,
            paidAt: true,
          },
        })
      : Promise.resolve([]),
    orderIds.length
      ? client.escrowLock.findMany({
          where: { orderId: { in: orderIds } },
          select: { id: true, orderId: true, role: true, userId: true, amount: true, status: true, releasedAt: true },
        })
      : Promise.resolve([]),
    role === "performer"
      ? client.payout.findMany({
          where: { userId },
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
          orderBy: { requestedAt: "desc" },
        })
      : Promise.resolve([]),
  ]);

  return {
    role,
    userId,
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerUserId: o.customerUserId,
      performerUserId: o.performerUserId,
      budget: Number(o.budget),
      dateFrom: o.dateFrom,
      dateTo: o.dateTo,
    })),
    intents: intents.map((i) => ({
      id: i.id,
      orderId: i.orderId,
      role: i.role,
      part: i.part,
      amount: Number(i.amount),
      depositAmount: i.depositAmount === null ? null : Number(i.depositAmount),
      feeAmount: Number(i.feeAmount),
      currency: i.currency,
      paidAt: i.paidAt,
    })),
    locks: locks.map((l) => ({
      id: l.id,
      orderId: l.orderId,
      role: l.role,
      userId: l.userId,
      amount: Number(l.amount),
      status: l.status,
      releasedAt: l.releasedAt,
    })),
    payouts: payouts.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      currency: p.currency,
      iban: p.iban,
      status: p.status,
      requestedAt: p.requestedAt,
      processedAt: p.processedAt,
      rejectReason: p.rejectReason,
    })),
  };
}

export async function getFinanceSnapshot(client: Client, userId: string, role: LedgerRole) {
  const input = await loadLedgerInput(client, userId, role);
  const entries = buildLedger(input);
  return { entries, summary: summarizeLedger(role, entries) };
}

/**
 * Створює заявку на виведення. Баланс перевіряється і резервується в одній
 * транзакції, тож дві паралельні заявки не можуть разом перевищити доступне.
 */
export async function requestPayout(args: { userId: string; amount: number }) {
  const legal = await prisma.legalProfile.findUnique({
    where: { userId: args.userId },
    select: { companyName: true, iban: true },
  });
  if (!legal?.iban) {
    throw new ApiError(400, "VALIDATION_ERROR", "Заповніть юридичний профіль з IBAN, щоб вивести кошти");
  }
  const iban = normalizeUAIban(legal.iban);
  if (!validateUAIban(iban)) {
    throw new ApiError(400, "VALIDATION_ERROR", "IBAN у юридичному профілі некоректний");
  }
  if (args.amount < PAYOUT_MIN_AMOUNT_UAH) {
    throw new ApiError(400, "VALIDATION_ERROR", `Мінімальна сума для виведення — ${PAYOUT_MIN_AMOUNT_UAH} ₴`);
  }

  return prisma.$transaction(async (tx) => {
    // Серіалізуємо заявки одного користувача: без блокування два паралельні
    // запити могли б разом перевищити доступний баланс.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.userId}))`;
    const { summary } = await getFinanceSnapshot(tx, args.userId, "performer");
    if (args.amount > summary.availableUah) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `Недостатньо коштів: доступно ${summary.availableUah.toFixed(2)} ₴`
      );
    }
    const user = await tx.user.findUnique({ where: { id: args.userId }, select: { name: true } });
    return tx.payout.create({
      data: {
        userId: args.userId,
        amount: args.amount,
        currency: "UAH",
        iban,
        accountName: legal.companyName ?? user?.name ?? "Виконавець",
        status: "requested",
      },
    });
  });
}
