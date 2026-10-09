import { Prisma, type PaymentIntent } from "@prisma/client";
import { ApiError } from "../lib/errors";
import { depositAmountFor, nextDepositDeadline } from "../lib/deposit";
import { canTransition, type OrderStatus } from "../lib/orderStatus";
import { createLiqPayCheckout, getLiqPayCheckoutUrl, liqpayDecodeData, liqpayVerifySignature, captureHold, refundCaptured, reverseHold } from "./liqpay.service";
import { publishDomainEvent } from "../realtime/publishDomainEvent";
import type { DomainEventType } from "../realtime/domainEvents";
import { notifyUser } from "./notify";

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
    method?: "card" | "apple-pay" | "google-pay" | "bank-transfer";
    wallet?: string;
    resultUrl?: string;
    serverUrl?: string;
    intentId?: string;
  }
) {
  const order = await tx.order.findUnique({ where: { id: args.orderId } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  const amount = depositAmountFor(order.budget);
  const checkout = createLiqPayCheckout({
    orderId: `${order.id}:${args.role}:${Date.now()}`,
    amount: amount.toNumber(),
    currency: order.currency,
    description: `Гарантійна сума за замовлення #${order.id.slice(-6)}`,
    method: args.method,
    serverUrl: args.serverUrl,
    resultUrl: args.resultUrl,
  });
  const intent = await tx.paymentIntent.create({
    data: {
      id: args.intentId ?? undefined,
      orderId: order.id,
      role: args.role,
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

export async function findPendingIntent(
  tx: Tx,
  args: { orderId: string; role: IntentRole }
) {
  return tx.paymentIntent.findFirst({
    where: { orderId: args.orderId, role: args.role, status: "pending" },
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
    resultUrl: intent.resultUrl ?? undefined,
    serverUrl: fresh,
    intentId: intent.id,
  });
  return created.intent;
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
  const toStatus = transitionForConfirm(intent.role, order.status);
  if (!toStatus || !canTransition(order.status as OrderStatus, toStatus)) {
    throw new ApiError(409, "CONFLICT", "Статус замовлення не дозволяє внесення застави");
  }
  const now = new Date();
  const deadlineReset =
    intent.role === "performer" ? nextDepositDeadline(now) : null;
  const moved = await tx.order.updateMany({
    where: { id: order.id, status: order.status },
    data: {
      status: toStatus,
      depositDeadline: deadlineReset,
    },
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
      amount: paidIntent.amount,
      status: "held",
    },
    update: { status: "held", releasedAt: null, amount: paidIntent.amount },
  });
  await tx.orderStatusEvent.create({
    data: { orderId: order.id, status: toStatus, note: null },
  });
  const updated = await tx.order.findUnique({ where: { id: order.id } });
  return { order: updated!, intent: paidIntent, duplicate: false as const };
}

export async function releaseEscrowForOrder(
  tx: Tx,
  args: { orderId: string; role?: IntentRole; to: "released" | "refunded" | "forfeited" }
) {
  await tx.escrowLock.updateMany({
    where: {
      orderId: args.orderId,
      status: "held",
      ...(args.role ? { role: args.role } : {}),
    },
    data: { status: args.to, releasedAt: new Date() },
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
export async function settleProviderHolds(args: {
  orderId: string;
  role?: IntentRole;
  to: "released" | "refunded" | "forfeited";
}) {
  // prisma імпортується динамічно: статичний імпорт тягне generated client
  // у тестовий бандл dist-tests, де його немає (unit-тести викликають лише чисті функції цього модуля).
  const { prisma } = await import("../lib/prisma");
  const intents = await prisma.paymentIntent.findMany({
    where: {
      orderId: args.orderId,
      status: "paid",
      ...(args.role ? { role: args.role } : {}),
    },
    select: { id: true, role: true, providerOrderId: true, providerRaw: true },
  });
  for (const intent of intents) {
    const raw =
      intent.providerRaw && typeof intent.providerRaw === "object"
        ? (intent.providerRaw as Record<string, unknown>)
        : null;
    const isHold = raw?.action === "hold";
    const liqpayOrderId = intent.providerOrderId;
    const liqpayPaymentId = raw?.payment_id;
    const logCtx = { orderId: args.orderId, intentId: intent.id, to: args.to };
    if (!liqpayOrderId || liqpayPaymentId == null) {
      process.stdout.write(JSON.stringify({ level: "info", msg: "settle_skipped_no_provider_payment", ...logCtx }) + "\n");
      continue;
    }
    try {
      if (args.to === "forfeited") {
        if (!isHold) {
          process.stdout.write(JSON.stringify({ level: "info", msg: "settle_skipped_already_captured", ...logCtx }) + "\n");
          continue;
        }
        await captureHold(liqpayOrderId);
      } else if (isHold) {
        await reverseHold(liqpayOrderId);
      } else {
        await refundCaptured(liqpayOrderId);
      }
      process.stdout.write(JSON.stringify({ level: "info", msg: "settle_ok", ...logCtx, liqpayOrderId }) + "\n");
    } catch (e) {
      process.stdout.write(
        JSON.stringify({
          level: "error",
          msg: "settle_failed",
          ...logCtx,
          liqpayOrderId,
          error: e instanceof Error ? e.message : String(e),
        }) + "\n"
      );
    }
  }
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
  customerUserId: string;
  performerUserId: string | null;
  providerStatus: string | null;
}): DepositPaidEvent[] {
  const both = [args.customerUserId, args.performerUserId].filter((v): v is string => !!v);
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

// Notify BOTH parties (push + inbox) about a successful deposit payment,
// including the payer about their own payment. Throws on publish/notify
// failure so callers can retry; never call with duplicate=true.
export async function emitDepositPaidNotifications(args: {
  requestId?: string;
  order: { id: string; status: string; customerUserId: string; performerUserId: string | null };
  role: IntentRole;
  amount: unknown;
  currency: string;
  providerStatus: string | null;
}) {
  const shortId = args.order.id.slice(-6);
  const sum = `${Number(args.amount)} ${args.currency}`;
  for (const e of buildDepositPaidEvents({
    orderId: args.order.id,
    toStatus: args.order.status,
    role: args.role,
    customerUserId: args.order.customerUserId,
    performerUserId: args.order.performerUserId,
    providerStatus: args.providerStatus,
  })) {
    await publishDomainEvent({ ...e, requestId: args.requestId });
  }
  if (args.role === "performer") {
    await notifyUser({
      userId: args.order.customerUserId,
      type: "deposit",
      title: "Виконавець вніс гарантійну суму",
      message: `Замовлення #${shortId}. Внесіть свою гарантійну суму протягом 12 годин.`,
      data: { orderId: args.order.id, type: "deposit_customer_required", role: "customer" },
    });
    if (args.order.performerUserId) {
      await notifyUser({
        userId: args.order.performerUserId,
        type: "deposit",
        title: "Гарантійну суму утримано",
        message: `Замовлення #${shortId}. Ваша гарантійна сума ${sum} утримана. Очікуйте внесення заказчиком.`,
        data: {
          orderId: args.order.id,
          type: "deposit_performer_paid_self",
          role: "performer",
          amount: Number(args.amount),
          currency: args.currency,
        },
      });
    }
  } else {
    if (args.order.performerUserId) {
      await notifyUser({
        userId: args.order.performerUserId,
        type: "deposit",
        title: "Замовник вніс гарантійну суму",
        message: `Замовлення #${shortId} підтверджено. Можна починати роботу.`,
        data: { orderId: args.order.id, type: "order_confirmed", role: "performer" },
      });
    }
    await notifyUser({
      userId: args.order.customerUserId,
      type: "deposit",
      title: "Гарантійну суму внесено",
      message: `Замовлення #${shortId}. Ваша гарантійна сума ${sum} внесена.`,
      data: {
        orderId: args.order.id,
        type: "deposit_customer_paid_self",
        role: "customer",
        amount: Number(args.amount),
        currency: args.currency,
      },
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
