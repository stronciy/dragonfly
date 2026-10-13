import { Prisma, type PaymentIntent } from "@prisma/client";
import { ApiError } from "../lib/errors";
import { DEPOSIT_DEADLINE_HOURS, customerPartAmounts, performerDepositAmount, nextDepositDeadline, nextPart2Deadline } from "../lib/deposit";
import { canTransition, type OrderStatus } from "../lib/orderStatus";
import { createLiqPayCheckout, getLiqPayCheckoutUrl, liqpayDecodeData, liqpayVerifySignature, captureHold, refundCaptured, reverseHold } from "./liqpay.service";
import { publishDomainEvent } from "../realtime/publishDomainEvent";
import type { DomainEventType } from "../realtime/domainEvents";
import { notifyUser } from "./notify";
import { formatOrderNumber, orderRef } from "../lib/orderNumber";

type Tx = Prisma.TransactionClient;

export type IntentRole = "performer" | "customer";

export function assertIntentRole(role: string): asserts role is IntentRole {
  if (role !== "performer" && role !== "customer") {
    throw new ApiError(400, "VALIDATION_ERROR", "Невірна роль платежу");
  }
}

export function transitionForConfirm(
  role: IntentRole,
  status: string
): OrderStatus | null {
  if (role === "performer" && status === "accepted")
    return "requires_confirmation";
  if (role === "customer" && status === "requires_confirmation")
    return "confirmed";
  return null;
}

// Escrow amount for a role = the sum of that role's PAID deposit intents, so
// the staged customer deposit (part1 + part2) lands on the full 30% without an
// independent recomputation (no rounding drift). Reads inside the caller's
// transaction, so an intent marked paid earlier in the same tx is included.
async function sumPaidIntentAmounts(
  tx: Tx,
  args: { orderId: string; role: IntentRole }
): Promise<Prisma.Decimal> {
  const rows = await tx.paymentIntent.findMany({
    where: { orderId: args.orderId, role: args.role, status: "paid" },
    select: { amount: true },
  });
  return rows.reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
}

// Без BACKEND_PUBLIC_URL (забули налаштувати на сервері) бераємо публічний
// origin із самого запиту — інакше server_url не формується і LiqPay взагалі
// не надсилає серверний колбек.
function requestOrigin(req?: Request): string {
  if (!req) return "";
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "")
    .split(",")[0]
    .trim();
  if (!host) return "";
  const forwardedProto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
  const proto = forwardedProto || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

export function buildDepositCallbackUrl(intentId: string, req?: Request): string | undefined {
  const base =
    (process.env.BACKEND_PUBLIC_URL || "").trim().replace(/\/+$/, "") || requestOrigin(req);
  if (!base) {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        msg: "liqpay_server_url_missing",
        intentId,
        hint: "BACKEND_PUBLIC_URL is not set and request origin is unknown",
      }) + "\n"
    );
    return undefined;
  }
  return `${base}/api/v1/payments/${intentId}/liqpay/callback`;
}

export async function createDepositIntent(
  tx: Tx,
  args: {
    orderId: string;
    role: IntentRole;
    /** Deposit stage: 1 = performer full / customer part1 (default), 2 = customer part2. */
    part?: 1 | 2;
    method?: "card" | "apple-pay" | "google-pay" | "bank-transfer";
    wallet?: string;
    resultUrl?: string;
    serverUrl?: string;
    intentId?: string;
  }
) {
  const order = await tx.order.findUnique({ where: { id: args.orderId } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  const part = args.part ?? 1;
  if (part === 2 && args.role !== "customer") {
    throw new ApiError(400, "VALIDATION_ERROR", "Другу частину гарантійної суми вносить лише замовник");
  }
  // Performer locks the full per-side deposit (30% of budget, part 1, no
  // staging). The customer side is staged: part1 (30% of the per-side deposit)
  // confirms the order; part2 (the remainder) is created later, once work
  // reaches 30% progress (openPart2DepositStage).
  const amount =
    args.role === "performer"
      ? performerDepositAmount(order.budget)
      : part === 2
        ? customerPartAmounts(order.budget).part2
        : customerPartAmounts(order.budget).part1;
  const checkout = createLiqPayCheckout({
    orderId: `${order.id}:${args.role}:${Date.now()}`,
    amount: amount.toNumber(),
    currency: order.currency,
    description:
      part === 2
        ? `Друга частина гарантійної суми за замовлення ${formatOrderNumber(order.orderNumber) ?? ""}`.trim()
        : `Гарантійна сума за замовлення ${formatOrderNumber(order.orderNumber) ?? ""}`.trim(),
    method: args.method,
    serverUrl: args.serverUrl,
    resultUrl: args.resultUrl,
  });
  const intent = await tx.paymentIntent.create({
    data: {
      id: args.intentId ?? undefined,
      orderId: order.id,
      role: args.role,
      part,
      amount,
      currency: order.currency,
      provider: "liqpay",
      status: "pending",
      data: checkout.data,
      signature: checkout.signature,
      serverUrl: args.serverUrl,
      resultUrl: args.resultUrl,
    },
  });
  // Як serverUrl порожній — у логах одразу видно, що LiqPay колбеку не отримає.
  process.stdout.write(
    JSON.stringify({
      level: args.serverUrl ? "info" : "warn",
      msg: "liqpay_intent_created",
      intentId: intent.id,
      orderId: order.id,
      role: args.role,
      serverUrl: args.serverUrl ?? null,
      resultUrl: args.resultUrl ?? null,
    }) + "\n"
  );
  return { intent, checkout, amount };
}

const LIVE_CHECKOUT_MS = 15 * 60 * 1000;

export async function findPendingIntent(
  tx: Tx,
  args: { orderId: string; role: IntentRole }
) {
  return tx.paymentIntent.findFirst({
    where: {
      orderId: args.orderId,
      role: args.role,
      status: "pending",
      createdAt: { gt: new Date(Date.now() - LIVE_CHECKOUT_MS) },
    },
    orderBy: { createdAt: "desc" },
  });
}

// Старі pending-інтенти могли створитись без serverUrl (BACKEND_PUBLIC_URL
// з'явився пізніше) — LiqPay-колбек за ними ніколи не прийде. В такому разі
// перестворюємо інтент з тим самим id, щоб новий checkout містив server_url.
export async function ensureIntentServerUrl(tx: Tx, intent: PaymentIntent, req?: Request) {
  if (intent.serverUrl) return intent;
  assertIntentRole(intent.role);
  const fresh = buildDepositCallbackUrl(intent.id, req);
  if (!fresh) return intent;
  await tx.paymentIntent.delete({ where: { id: intent.id } });
  const created = await createDepositIntent(tx, {
    orderId: intent.orderId,
    role: intent.role,
    part: intent.part === 2 ? 2 : 1,
    resultUrl: intent.resultUrl ?? undefined,
    serverUrl: fresh,
    intentId: intent.id,
  });
  return created.intent;
}

// A "staged" order is one whose customer deposit follows the 30/70 split:
// there is a paid customer part-1 intent AND its amount equals the staged
// part-1 for the order's budget. Legacy in-flight orders paid a single deposit
// (backfilled as part 1), which does not match the staged split — so they are
// NOT staged and must never be asked for a part-2 payment.
export async function isStagedDepositOrder(
  tx: Tx,
  order: { id: string; budget: Prisma.Decimal.Value }
): Promise<boolean> {
  const part1 = customerPartAmounts(order.budget).part1;
  const staged = await tx.paymentIntent.findFirst({
    where: {
      orderId: order.id,
      role: "customer",
      part: 1,
      status: "paid",
      amount: part1,
    },
    select: { id: true },
  });
  return staged != null;
}

// ≥30% progress milestone: idempotently open the customer's part-2 deposit
// stage. The guarded `customerPart2Deadline` update is the latch — under
// concurrency exactly one caller claims it — and the deadline write and the
// part-2 intent are written in the caller's transaction, so they commit or
// roll back together. Returns the fresh part-2 intent, or null when the stage
// is already open (a part-2 intent exists), the order is not a staged deposit
// order (part-1 unpaid, or a legacy single-deposit order), or the latch was
// lost to a concurrent post.
export async function openPart2DepositStage(
  tx: Tx,
  args: { orderId: string; intentId: string; serverUrl?: string }
): Promise<PaymentIntent | null> {
  const existingPart2 = await tx.paymentIntent.findFirst({
    where: { orderId: args.orderId, role: "customer", part: 2 },
    select: { id: true },
  });
  if (existingPart2) return null;
  const order = await tx.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, budget: true },
  });
  if (!order) return null;
  if (!(await isStagedDepositOrder(tx, order))) return null;
  const now = new Date();
  const claimed = await tx.order.updateMany({
    where: { id: args.orderId, customerPart2Deadline: null },
    data: { customerPart2Deadline: nextPart2Deadline(now) },
  });
  if (claimed.count !== 1) return null;
  const { intent } = await createDepositIntent(tx, {
    orderId: args.orderId,
    role: "customer",
    part: 2,
    serverUrl: args.serverUrl,
    intentId: args.intentId,
  });
  return intent;
}

export async function claimOrderForPerformer(
  tx: Tx,
  args: { orderId: string; performerUserId: string }
) {
  const now = new Date();
  const claimed = await tx.order.updateMany({
    where: { id: args.orderId, status: "published" },
    data: {
      status: "accepted",
      performerUserId: args.performerUserId,
      acceptedAt: now,
      depositDeadline: nextDepositDeadline(now),
    },
  });
  if (claimed.count === 1) {
    const order = await tx.order.findUnique({ where: { id: args.orderId } });
    await tx.orderStatusEvent.create({
      data: { orderId: args.orderId, status: "accepted", note: null },
    });
    return { order: order!, freshClaim: true as const };
  }
  const existing = await tx.order.findUnique({ where: { id: args.orderId } });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  if (
    existing.status === "accepted" &&
    existing.performerUserId === args.performerUserId
  ) {
    return { order: existing, freshClaim: false as const };
  }
  throw new ApiError(409, "CONFLICT", "Замовлення більше недоступне");
}

export async function confirmDeposit(
  tx: Tx,
  args: { paymentIntentId: string; data: string; signature: string }
) {
  const intent = await tx.paymentIntent.findUnique({
    where: { id: args.paymentIntentId },
  });
  if (!intent) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");
  assertIntentRole(intent.role);
  if (intent.status === "paid") {
    const order = await tx.order.findUnique({ where: { id: intent.orderId } });
    return { order: order!, intent, duplicate: true as const };
  }
  if (intent.status !== "pending") {
    throw new ApiError(409, "CONFLICT", "Платіж не підлягає оплаті");
  }
  if (!liqpayVerifySignature(args.data, args.signature)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Недійсний підпис оплати");
  }
  const decoded = liqpayDecodeData(args.data) as {
    status?: unknown;
    order_id?: unknown;
    payment_id?: unknown;
    amount?: unknown;
    action?: unknown;
  };
  const providerStatus = typeof decoded.status === "string" ? decoded.status : null;
  const isCheckoutReplay = !providerStatus && args.data === intent.data;
  if (!isCheckoutReplay && providerStatus !== "success" && providerStatus !== "hold_wait" && providerStatus !== "sandbox") {
    throw new ApiError(400, "VALIDATION_ERROR", `Оплату не завершено (статус: ${providerStatus ?? "unknown"})`);
  }
  if (typeof decoded.amount !== "undefined") {
    const paidAmount = Number(decoded.amount);
    if (!Number.isFinite(paidAmount) || paidAmount < Number(intent.amount)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Сума оплати менша за необхідну заставу");
    }
  }
  const order = await tx.order.findUnique({ where: { id: intent.orderId } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  // Part-2 (the customer deposit remainder) does NOT transition the order: the
  // order is already confirmed/started. Paying it tops the customer escrow up
  // to the full 30% and resumes a paused order (deadline cleared, pause off).
  const isPart2 = intent.role === "customer" && intent.part === 2;
  const toStatus = isPart2 ? null : transitionForConfirm(intent.role, order.status);
  if (!isPart2 && (!toStatus || !canTransition(order.status as OrderStatus, toStatus))) {
    throw new ApiError(409, "CONFLICT", "Статус замовлення не дозволяє внесення застави");
  }
  // The part-2 stage only exists while the work is in progress (`started`);
  // paying a stale checkout after the order moved on would strand money in
  // escrow with no release path ever returning it.
  if (isPart2 && order.status !== "started") {
    throw new ApiError(409, "CONFLICT", "Другу частину гарантійної суми можна внести лише під час виконання робіт");
  }
  const now = new Date();
  const deadlineReset =
    intent.role === "performer" ? nextDepositDeadline(now) : null;
  const moved = await tx.order.updateMany({
    where: { id: order.id, status: order.status },
    data: isPart2
      ? { customerPart2Deadline: null, paymentPaused: false }
      : { status: toStatus!, depositDeadline: deadlineReset },
  });
  if (moved.count !== 1) {
    throw new ApiError(409, "CONFLICT", "Статус замовлення паралельно змінено");
  }
  const paidIntent = await tx.paymentIntent.update({
    where: { id: intent.id },
    data: {
      status: "paid",
      paidAt: now,
      data: args.data,
      signature: args.signature,
      providerOrderId:
        typeof decoded.order_id === "string" || typeof decoded.order_id === "number"
          ? String(decoded.order_id)
          : intent.providerOrderId,
      providerRaw: {
        action: decoded.action ?? null,
        status: providerStatus,
        payment_id: decoded.payment_id ?? null,
        amount: decoded.amount ?? null,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  const lockAmount = isPart2
    ? await sumPaidIntentAmounts(tx, { orderId: order.id, role: intent.role })
    : paidIntent.amount;
  const lockUserId =
    intent.role === "performer" ? order.performerUserId! : order.customerUserId;
  await tx.escrowLock.upsert({
    where: {
      uniq_order_role_lock: { orderId: order.id, role: intent.role },
    },
    create: {
      orderId: order.id,
      userId: lockUserId,
      role: intent.role,
      amount: lockAmount,
      status: "held",
    },
    update: { status: "held", releasedAt: null, amount: lockAmount },
  });
  if (!isPart2) {
    await tx.orderStatusEvent.create({
      data: { orderId: order.id, status: toStatus!, note: null },
    });
  }
  const updated = await tx.order.findUnique({ where: { id: order.id } });
  return { order: updated!, intent: paidIntent, duplicate: false as const };
}

export const ESCROW_OPEN_STATUSES = ["held", "release_pending", "refund_pending", "forfeit_pending"] as const;

type SettleTarget = "released" | "refunded" | "forfeited";

const PENDING_BY_TARGET: Record<SettleTarget, string> = {
  released: "release_pending",
  refunded: "refund_pending",
  forfeited: "forfeit_pending",
};

const TARGET_BY_PENDING: Record<string, SettleTarget> = {
  release_pending: "released",
  refund_pending: "refunded",
  forfeit_pending: "forfeited",
};

export async function releaseEscrowForOrder(
  tx: Tx,
  args: { orderId: string; role?: IntentRole; to: SettleTarget }
) {
  await tx.escrowLock.updateMany({
    where: {
      orderId: args.orderId,
      status: "held",
      ...(args.role ? { role: args.role } : {}),
    },
    data: { status: PENDING_BY_TARGET[args.to] },
  });
}
export async function heldEscrowTotal(tx: Tx, orderId: string) {
  const locks = await tx.escrowLock.findMany({
    where: { orderId, status: "held" },
    select: { amount: true },
  });
  return locks.reduce((sum, l) => sum + Number(l.amount), 0);
}

// Рух реальних грошей в LiqPay після зміни escrow-статусу.
// Викликається ПІСЛЯ коміту транзакції: помилки провайдера логуються
// і НЕ ламають стан замовлення (повтор — вручну через кабінет LiqPay).
// Пропускає симульовані оплати (e2e/тести без payment_id) та legacy pay-інтенти
// без providerRaw — їхнє повернення тільки вручну.
type PendingLock = { id: string; orderId: string; role: string; status: string };

// Final PaymentIntent status once its money has been moved for a settlement
// target. Marking intents settled makes retries idempotent per intent: a
// retry after a partial failure re-reads only the still-"paid" intents, so
// money that already moved is never moved twice.
const INTENT_STATUS_BY_TARGET: Record<SettleTarget, string> = {
  released: "released",
  refunded: "refunded",
  forfeited: "forfeited",
};

async function settlePendingLock(
  lock: PendingLock,
  client: Prisma.TransactionClient
): Promise<boolean> {
  const to = TARGET_BY_PENDING[lock.status];
  if (!to) return false;
  const intents = await client.paymentIntent.findMany({
    where: { orderId: lock.orderId, status: "paid", role: lock.role },
    select: { id: true, role: true, providerOrderId: true, providerRaw: true },
  });
  const logCtx = { orderId: lock.orderId, lockId: lock.id, role: lock.role, to };

  for (const intent of intents) {
    const raw =
      intent.providerRaw && typeof intent.providerRaw === "object"
        ? (intent.providerRaw as Record<string, unknown>)
        : null;
    const isHold = raw?.action === "hold";
    const liqpayOrderId = intent.providerOrderId;
    const liqpayPaymentId = raw?.payment_id;
    if (!liqpayOrderId || liqpayPaymentId == null) {
      process.stdout.write(JSON.stringify({ level: "info", msg: "settle_skipped_no_provider_payment", ...logCtx, intentId: intent.id }) + "\n");
      continue;
    }
    if (to === "forfeited" && !isHold) {
      process.stdout.write(JSON.stringify({ level: "info", msg: "settle_skipped_already_captured", ...logCtx, intentId: intent.id }) + "\n");
      continue;
    }
    try {
      if (to === "forfeited") {
        await captureHold(liqpayOrderId);
      } else if (isHold) {
        await reverseHold(liqpayOrderId);
      } else {
        await refundCaptured(liqpayOrderId);
      }
      const marked = await client.paymentIntent.updateMany({
        where: { id: intent.id, status: "paid" },
        data: { status: INTENT_STATUS_BY_TARGET[to] },
      });
      if (marked.count !== 1) {
        process.stdout.write(JSON.stringify({ level: "info", msg: "settle_mark_raced", ...logCtx, intentId: intent.id }) + "\n");
      }
      process.stdout.write(JSON.stringify({ level: "info", msg: "settle_ok", ...logCtx, intentId: intent.id, liqpayOrderId }) + "\n");
    } catch (e) {
      process.stdout.write(
        JSON.stringify({
          level: "error",
          msg: "settle_failed_will_retry",
          ...logCtx,
          intentId: intent.id,
          liqpayOrderId,
          error: e instanceof Error ? e.message : String(e),
        }) + "\n"
      );
      return false;
    }
  }

  const updated = await client.escrowLock.updateMany({
    where: { id: lock.id, status: lock.status },
    data: { status: to, releasedAt: new Date() },
  });
  return updated.count === 1;
}

export async function settleProviderHolds(args: {
  orderId: string;
  role?: IntentRole;
  to: SettleTarget;
  client?: Prisma.TransactionClient;
}) {
  const client = args.client ?? (await import("../lib/prisma")).prisma;
  const locks = await client.escrowLock.findMany({
    where: {
      orderId: args.orderId,
      status: PENDING_BY_TARGET[args.to],
      ...(args.role ? { role: args.role } : {}),
    },
    select: { id: true, orderId: true, role: true, status: true },
  });
  for (const lock of locks) {
    await settlePendingLock(lock, client);
  }
}

export async function retryPendingEscrowSettlements(args: {
  olderThanMs: number;
  limit?: number;
  client?: Prisma.TransactionClient;
}) {
  const client = args.client ?? (await import("../lib/prisma")).prisma;
  const cutoff = new Date(Date.now() - args.olderThanMs);
  const locks = await client.escrowLock.findMany({
    where: { status: { in: Object.values(PENDING_BY_TARGET) }, updatedAt: { lt: cutoff } },
    select: { id: true, orderId: true, role: true, status: true },
    orderBy: { updatedAt: "asc" },
    take: args.limit ?? 200,
  });
  let settled = 0;
  for (const lock of locks) {
    if (await settlePendingLock(lock, client)) settled += 1;
  }
  return { checked: locks.length, settled, failed: locks.length - settled };
}

type SerializableIntent = {
  id: string;
  orderId: string;
  role: string;
  amount: unknown;
  currency: string;
  status: string;
  data: string | null;
  signature: string | null;
};

export function serializePaymentIntent(intent: SerializableIntent) {
  const checkoutUrl = getLiqPayCheckoutUrl();
  return {
    id: intent.id,
    orderId: intent.orderId,
    role: intent.role,
    amount: Number(intent.amount),
    currency: intent.currency,
    status: intent.status,
    data: intent.data,
    signature: intent.signature,
    checkoutUrl,
    liqpay: {
      data: intent.data,
      signature: intent.signature,
      checkoutUrl,
      checkout: { data: intent.data, signature: intent.signature },
    },
  };
}

export type DepositPaidEvent = {
  type: DomainEventType;
  targets: { userIds: string[] };
  data: Record<string, unknown>;
};

// Pure builder (unit-tested): the full WS event set for a successful deposit
// payment. Shared by the LiqPay callback and the manual confirm route so both
// paths notify identically.
export function buildDepositPaidEvents(args: {
  orderId: string;
  toStatus: string;
  role: IntentRole;
  part?: number;
  customerUserId: string;
  performerUserId: string | null;
  providerStatus: string | null;
}): DepositPaidEvent[] {
  const both = [args.customerUserId, args.performerUserId].filter((v): v is string => !!v);
  // Customer part-2 tops the escrow up to the full 30% and lifts a pause — it
  // does not change the order status, so it emits its own event set.
  if (args.role === "customer" && args.part === 2) {
    return [
      {
        type: "deposit.customer_part2_paid",
        targets: { userIds: both },
        data: { orderId: args.orderId, role: "customer", part: 2, providerStatus: args.providerStatus },
      },
      {
        type: "escrow.changed",
        targets: { userIds: both },
        data: { orderId: args.orderId, role: "customer", status: args.toStatus },
      },
      {
        type: "order.payment_resumed",
        targets: { userIds: both },
        data: { orderId: args.orderId },
      },
    ];
  }
  const fromStatus = args.role === "performer" ? "accepted" : "requires_confirmation";
  const events: DepositPaidEvent[] = [
    {
      type: args.role === "performer" ? "deposit.performer_paid" : "deposit.customer_paid",
      targets: { userIds: both },
      data: { orderId: args.orderId, status: args.toStatus, providerStatus: args.providerStatus },
    },
    {
      type: "escrow.changed",
      targets: { userIds: both },
      data: { orderId: args.orderId, role: args.role, status: args.toStatus },
    },
    {
      type: "order.status_changed",
      targets: { userIds: both },
      data: { orderId: args.orderId, fromStatus, toStatus: args.toStatus },
    },
  ];
  if (args.role === "performer") {
    events.push(
      {
        type: "deposit.customer_required",
        targets: { userIds: [args.customerUserId] },
        data: { orderId: args.orderId, status: args.toStatus },
      },
      {
        type: "payment:required",
        targets: { userIds: [args.customerUserId] },
        data: { orderId: args.orderId, status: args.toStatus },
      }
    );
  } else {
    events.push(
      {
        type: "order.confirmed",
        targets: { userIds: both },
        data: { orderId: args.orderId },
      },
      {
        type: "order:confirmed",
        targets: { userIds: both },
        data: { orderId: args.orderId },
      }
    );
  }
  return events;
}

// Notify BOTH sides (push + inbox) about a deposit payment: the counterparty
// is told what the other side did, and the payer gets a confirmation of their
// own payment. Every payload carries orderId + role + action so the app can
// deep-link to the specific order. WebSocket events still go to both parties
// so both apps refresh. Throws on publish/notify failure so callers can retry.
export async function emitDepositPaidNotifications(args: {
  requestId?: string;
  order: { id: string; status: string; customerUserId: string; performerUserId: string | null };
  role: IntentRole;
  part?: number;
  amount: unknown;
  currency: string;
  providerStatus: string | null;
}) {
  const shortRef = await orderRef(args.order.id);
  const sum = `${Number(args.amount)} ${args.currency}`;
  for (const e of buildDepositPaidEvents({
    orderId: args.order.id,
    toStatus: args.order.status,
    role: args.role,
    part: args.part,
    customerUserId: args.order.customerUserId,
    performerUserId: args.order.performerUserId,
    providerStatus: args.providerStatus,
  })) {
    await publishDomainEvent({ ...e, requestId: args.requestId });
  }
  if (args.role === "customer" && args.part === 2) {
    if (args.order.performerUserId) {
      await notifyUser({
        userId: args.order.performerUserId,
        type: "deposit",
        title: "Замовник вніс другу частину гарантійної суми",
        message: `Замовлення ${shortRef}. Гарантійна сума замовника внесена повністю (частини 30/70). Роботу розблоковано — можна продовжувати.`,
        data: { orderId: args.order.id, type: "order_payment_resumed", role: "performer", action: "view_order" },
      });
    }
    await notifyUser({
      userId: args.order.customerUserId,
      type: "deposit",
      title: "Другу частину гарантійної суми внесено",
      message: `Замовлення ${shortRef}. Ви внесли другу частину гарантійної суми (70% від неї) — ${sum}. Гарантійна сума внесена повністю, роботу розблоковано.`,
      data: { orderId: args.order.id, type: "order_payment_resumed", role: "customer", action: "view_order" },
    });
  } else if (args.role === "performer") {
    await notifyUser({
      userId: args.order.customerUserId,
      type: "deposit",
      title: "Виконавець вніс гарантійну суму",
      message: `Замовлення ${shortRef}. Внесіть першу частину своєї гарантійної суми (30% від неї) протягом ${DEPOSIT_DEADLINE_HOURS} годин.`,
      data: { orderId: args.order.id, type: "deposit_customer_required", role: "customer", action: "pay_deposit" },
    });
    if (args.order.performerUserId) {
      await notifyUser({
        userId: args.order.performerUserId,
        type: "deposit",
        title: "Гарантійну суму внесено",
        message: `Замовлення ${shortRef}. Ви внесли гарантійну суму — ${sum}. Очікуємо внесення замовником першої частини його гарантійної суми.`,
        data: { orderId: args.order.id, type: "deposit_performer_paid", role: "performer", action: "view_order" },
      });
    }
  } else {
    if (args.order.performerUserId) {
      await notifyUser({
        userId: args.order.performerUserId,
        type: "deposit",
        title: "Замовник вніс першу частину гарантійної суми",
        message: `Замовлення ${shortRef} підтверджено. Другу частину (70% від гарантійної суми) замовник внесе, коли роботи досягнуть 30% прогресу. Можна починати роботу.`,
        data: { orderId: args.order.id, type: "order_confirmed", role: "performer", action: "view_order" },
      });
    }
    await notifyUser({
      userId: args.order.customerUserId,
      type: "deposit",
      title: "Першу частину гарантійної суми внесено",
      message: `Замовлення ${shortRef} підтверджено. Ви внесли першу частину (30% від гарантійної суми) — ${sum}. Другу частину (70%) потрібно буде внести, коли роботи досягнуть 30% прогресу.`,
      data: { orderId: args.order.id, type: "order_confirmed", role: "customer", action: "view_order" },
    });
  }
  process.stdout.write(
    JSON.stringify({
      level: "info",
      msg: "deposit_paid_notified",
      orderId: args.order.id,
      role: args.role,
      amount: Number(args.amount),
      currency: args.currency,
      providerStatus: args.providerStatus,
      requestId: args.requestId ?? null,
    }) + "\n"
  );
}

// Emit one escrow.changed event per affected lock role (both parties targeted).
export async function emitEscrowChanged(args: {
  requestId?: string;
  orderId: string;
  customerUserId: string;
  performerUserId: string | null;
  roles: IntentRole[];
  orderStatus: string;
}) {
  const both = [args.customerUserId, args.performerUserId].filter((v): v is string => !!v);
  for (const role of args.roles) {
    await publishDomainEvent({
      type: "escrow.changed",
      requestId: args.requestId,
      targets: { userIds: both },
      data: { orderId: args.orderId, role, status: args.orderStatus },
    });
  }
}
