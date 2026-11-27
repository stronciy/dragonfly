import type { Prisma } from "@prisma/client";
import { formatUahAmount } from "../lib/money";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/errors";
import {
  buildLedger,
  summarizeLedger,
  type LedgerInput,
  type LedgerRole,
} from "../lib/finance/ledger";
import { normalizeUAIban, validateUAIban } from "../lib/validators";
import { publishPayoutUpdated } from "./payoutEvents";
import { PART1_CAPTURED_NOTE, PART1_CONFIRMED_NOTE } from "../lib/completionConfirmation";

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
            // Попередні заставы того самого заказу (після відмови заказ взяв інший).
            { paymentIntents: { some: { role: "performer", payerUserId: userId } } },
          ],
        }
      : { customerUserId: userId };
  const orders = await client.order.findMany({
    where: orderWhere,
    select: {
      id: true,
      status: true,
      orderNumber: true,
      customerUserId: true,
      performerUserId: true,
      budget: true,
      dateFrom: true,
      dateTo: true,
      statusEvents: {
        where: { note: { in: [PART1_CONFIRMED_NOTE, PART1_CAPTURED_NOTE] } },
        select: { note: true, createdAt: true },
      },
      progressUpdates: {
        select: { percent: true, createdAt: true },
      },
    },
  });
  const orderIds = orders.map((o) => o.id);

  const [intents, locks, payouts] = await Promise.all([
    orderIds.length
      ? client.paymentIntent.findMany({
          // Після розрахунку платіж отримує статус released/refunded/forfeited —
          // він лишається в журналі, а його підсумок визначає статус ескроу.
          where: { orderId: { in: orderIds }, status: { in: ["paid", "released", "refunded", "forfeited"] } },
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
            status: true,
            payerUserId: true,
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
    orders: orders.map((o) => {
      const updates = (o as unknown as { progressUpdates?: Array<{ percent: number | null; createdAt: Date }> }).progressUpdates ?? [];
      const maxPercent = updates.length > 0 ? Math.max(0, ...updates.map((u) => u.percent ?? 0)) : (o.status === "completed" ? 100 : 0);
      const updateAt = updates.find((u) => u.percent === maxPercent)?.createdAt ?? null;
      const part1ConfirmedAt =
        o.statusEvents.find((e) => e.note === PART1_CONFIRMED_NOTE)?.createdAt ?? null;
      const part1CapturedAt =
        o.statusEvents.find((e) => e.note === PART1_CAPTURED_NOTE)?.createdAt ?? null;
      return {
        id: o.id,
        status: o.status,
        orderNumber: o.orderNumber,
        customerUserId: o.customerUserId,
        performerUserId: o.performerUserId,
        budget: Number(o.budget),
        dateFrom: o.dateFrom,
        dateTo: o.dateTo,
        progressPercent: maxPercent,
        progressCreatedAt: updateAt,
        part1ConfirmedAt,
        part1CapturedAt,
      };
    }),
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
      status: i.status,
      payerUserId: i.payerUserId,
    })),
    locks: locks.map((l) => {
      return {
        id: l.id,
        orderId: l.orderId,
        role: l.role,
        userId: l.userId,
        amount: Number(l.amount),
        status: l.status,
        releasedAt: l.releasedAt,
      };
    }),
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
    throw new ApiError(400, "VALIDATION_ERROR", `Мінімальна сума для виведення — ${formatUahAmount(PAYOUT_MIN_AMOUNT_UAH)}`);
  }

  const payout = await prisma.$transaction(async (tx) => {
    // Серіалізуємо заявки одного користувача: без блокування два паралельні
    // запити могли б разом перевищити доступний баланс.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.userId}))`;
    const { summary } = await getFinanceSnapshot(tx, args.userId, "performer");
    if (args.amount > summary.availableUah) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `Недостатньо коштів: доступно ${formatUahAmount(summary.availableUah)}`
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
  await publishPayoutUpdated({
    userId: args.userId,
    payoutId: payout.id,
    status: "requested",
    amount: Number(payout.amount),
  });
  return payout;
}
