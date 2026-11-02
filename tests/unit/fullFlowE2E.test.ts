import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  claimOrderForPerformer,
  createDepositIntent,
  confirmDeposit,
  releaseEscrowForOrder,
  settleProviderHolds,
  transitionForConfirm,
} from "../../src/services/deposit.service";
import {
  liqpayEncodeData,
  liqpaySign,
  liqpayVerifySignature,
} from "../../src/services/liqpay.service";
import { canTransition, type OrderStatus } from "../../src/lib/orderStatus";
import { depositAmountFor } from "../../src/lib/deposit";
import { SERVICE_FEE_RATE, serviceFeeAmount } from "../../src/lib/fees";
import { isWithinUkraine } from "../../src/lib/validators";

process.env.LIQPAY_PUBLIC_KEY = "sandbox_i46164491187";
process.env.LIQPAY_PRIVATE_KEY = "sandbox_L1clfbfAkMSWLCFxOtuNPj7DdFEgrHDKbIboDWUw";

// LiqPay test card details specified by user
const TEST_CARD = {
  cardNumber: "4242 4242 4242 4242",
  expiry: "10/29",
  cvv: "123",
};

type InMemoryOrder = {
  id: string;
  orderNumber: string;
  customerUserId: string;
  performerUserId: string | null;
  status: OrderStatus;
  budget: Prisma.Decimal;
  currency: string;
  areaHa: Prisma.Decimal;
  lat: number;
  lng: number;
  addressLabel: string;
  acceptedAt: Date | null;
  depositDeadline: Date | null;
  completedAt: Date | null;
};

type InMemoryIntent = {
  id: string;
  orderId: string;
  role: string;
  part: number;
  amount: Prisma.Decimal;
  depositAmount: Prisma.Decimal | null;
  feeAmount: Prisma.Decimal;
  feeRate: number | null;
  currency: string;
  provider: string;
  status: string;
  data: string | null;
  signature: string | null;
  providerOrderId: string | null;
  providerRaw: any;
  paidAt: Date | null;
};

type InMemoryLock = {
  id: string;
  orderId: string;
  role: string;
  userId: string;
  amount: Prisma.Decimal;
  status: string;
  releasedAt: Date | null;
};

type InMemoryProgress = {
  id: string;
  orderId: string;
  percent: number;
  note: string | null;
  images: any[];
  createdAt: Date;
};

type InMemoryReview = {
  id: string;
  orderId: string;
  authorUserId: string;
  performerUserId: string | null;
  rating: number;
  text: string | null;
};

type InMemoryArbitration = {
  id: string;
  orderId: string;
  proposedById: string;
  decision: "close_plain" | "close_fine";
  status: "pending" | "approved" | "rejected" | "withdrawn";
  reason: string | null;
  rating: number | null;
  comment: string | null;
  decidedAt: Date | null;
};

function createInMemoryStore() {
  const users = new Map<string, any>();
  const performerProfiles = new Map<string, any>();
  const customerProfiles = new Map<string, any>();
  const orders = new Map<string, InMemoryOrder>();
  const paymentIntents = new Map<string, InMemoryIntent>();
  const escrowLocks = new Map<string, InMemoryLock>();
  const progressUpdates: InMemoryProgress[] = [];
  const reviews: InMemoryReview[] = [];
  const arbitrationResolutions = new Map<string, InMemoryArbitration>();
  const orderStatusEvents: { orderId: string; status: string; note: string | null }[] = [];
  const wallets = new Map<string, { id: string; userId: string; balance: number }>();
  const transactions: any[] = [];
  const providerCalls: { action: string; orderId: string; flag?: string }[] = [];

  const tx = {
    order: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const o = orders.get(where.id);
        return o ? { ...o } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<InMemoryOrder> }) => {
        const o = orders.get(where.id);
        if (!o) throw new Error("Order not found");
        Object.assign(o, data);
        return { ...o };
      },
      updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Partial<InMemoryOrder> }) => {
        const o = orders.get(where.id);
        if (!o) return { count: 0 };
        if (where.status && o.status !== where.status) return { count: 0 };
        Object.assign(o, data);
        return { count: 1 };
      },
    },
    paymentIntent: {
      create: async ({ data }: { data: any }) => {
        const row: InMemoryIntent = {
          ...data,
          id: data.id ?? `intent-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          paidAt: null,
          providerOrderId: null,
          providerRaw: null,
        };
        paymentIntents.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const pi = paymentIntents.get(where.id);
        return pi ? { ...pi } : null;
      },
      findMany: async ({ where }: { where: { orderId: string; status: string; role: string } }) => {
        return [...paymentIntents.values()].filter(
          (pi) => pi.orderId === where.orderId && pi.status === where.status && pi.role === where.role
        );
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<InMemoryIntent> }) => {
        const pi = paymentIntents.get(where.id);
        if (!pi) throw new Error("Intent not found");
        Object.assign(pi, data);
        return { ...pi };
      },
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Partial<InMemoryIntent> }) => {
        let count = 0;
        for (const pi of paymentIntents.values()) {
          if (pi.id === where.id && pi.status === where.status) {
            Object.assign(pi, data);
            count++;
          }
        }
        return { count };
      },
    },
    escrowLock: {
      upsert: async ({ where, create, update }: any) => {
        const key = `${where.uniq_order_role_lock.orderId}:${where.uniq_order_role_lock.role}`;
        let lock = escrowLocks.get(key);
        if (lock) {
          Object.assign(lock, update);
          return { ...lock };
        }
        const newLock: InMemoryLock = {
          id: `lock-${Math.random().toString(36).substring(2, 8)}`,
          ...create,
        };
        escrowLocks.set(key, newLock);
        return { ...newLock };
      },
      findMany: async ({ where }: any) => {
        return [...escrowLocks.values()].filter(
          (l) =>
            (!where.orderId || l.orderId === where.orderId) &&
            (!where.status || l.status === where.status) &&
            (!where.role || l.role === where.role)
        );
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const l of escrowLocks.values()) {
          const matchId = !where.id || l.id === where.id;
          const matchOrder = !where.orderId || l.orderId === where.orderId;
          const matchStatus = !where.status || l.status === where.status;
          const matchRole = !where.role || l.role === where.role;
          if (matchId && matchOrder && matchStatus && matchRole) {
            l.status = data.status;
            if (data.releasedAt) l.releasedAt = data.releasedAt;
            count++;
          }
        }
        return { count };
      },
    },
    orderStatusEvent: {
      create: async ({ data }: { data: { orderId: string; status: string; note: string | null } }) => {
        orderStatusEvents.push(data);
        return data;
      },
    },
    review: {
      create: async ({ data }: any) => {
        const rev = { id: `rev-${Date.now()}`, ...data };
        reviews.push(rev);
        return rev;
      },
      findFirst: async ({ where }: any) => {
        return reviews.find((r) => r.orderId === where.orderId && r.authorUserId === where.authorUserId) ?? null;
      },
    },
    arbitrationResolution: {
      update: async ({ where, data }: any) => {
        const ar = arbitrationResolutions.get(where.id);
        if (!ar) throw new Error("Resolution not found");
        Object.assign(ar, data);
        return { ...ar };
      },
    },
    wallet: {
      upsert: async ({ where, create }: any) => {
        let w = wallets.get(where.userId);
        if (!w) {
          w = { id: `w-${where.userId}`, userId: where.userId, balance: create.balance ?? 0 };
          wallets.set(where.userId, w);
        }
        return { ...w };
      },
      update: async ({ where, data }: any) => {
        let w = [...wallets.values()].find((x) => x.id === where.id);
        if (!w) throw new Error("Wallet not found");
        if (data.balance?.increment) {
          w.balance += data.balance.increment;
        }
        return { ...w };
      },
    },
    transaction: {
      create: async ({ data }: any) => {
        transactions.push(data);
        return data;
      },
    },
  };

  // Provider call interceptor for settleProviderHolds
  const originalFetch = global.fetch;
  global.fetch = (async (url: any, opts: any) => {
    if (typeof url === "string" && url.includes("liqpay.ua")) {
      const body = typeof opts?.body === "string" ? opts.body : "";
      const params = new URLSearchParams(body);
      const data = params.get("data");
      const decoded = data ? JSON.parse(Buffer.from(data, "base64").toString("utf8")) : {};
      providerCalls.push({
        action: decoded.action,
        orderId: decoded.order_id,
        flag: decoded.flag,
      });
      return {
        ok: true,
        json: async () => ({ result: "ok", status: "success" }),
      } as any;
    }
    return originalFetch(url, opts);
  }) as typeof fetch;

  const restore = () => {
    global.fetch = originalFetch;
  };

  return {
    users,
    performerProfiles,
    customerProfiles,
    orders,
    paymentIntents,
    escrowLocks,
    progressUpdates,
    reviews,
    arbitrationResolutions,
    orderStatusEvents,
    wallets,
    transactions,
    providerCalls,
    tx: tx as unknown as Prisma.TransactionClient,
    restore,
  };
}

/**
 * Helper to build valid signed LiqPay test payment payload
 */
function buildLiqPayTestPayment(args: {
  intentId: string;
  amount: number | Prisma.Decimal;
  currency: string;
  status?: "success" | "hold_wait" | "sandbox";
}) {
  const data = liqpayEncodeData({
    public_key: process.env.LIQPAY_PUBLIC_KEY!,
    version: 3,
    action: "hold",
    amount: String(args.amount),
    currency: args.currency,
    description: `Test payment via card ${TEST_CARD.cardNumber}`,
    order_id: args.intentId,
    status: args.status ?? "sandbox",
    payment_id: 88812345,
  });
  const signature = liqpaySign(data);
  return { data, signature };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite 1: Full Happy Path Order Flow
// ─────────────────────────────────────────────────────────────────────────────
test("Full Happy Path Flow: Register → Profile → Order → Accept → Both Deposits (LiqPay 4242) → En Route → Start → Progress → Complete → Confirm → Release", async (t) => {
  const store = createInMemoryStore();
  t.after(() => store.restore());

  // 1. Account registration: Customer & Performer
  const customerUser = {
    id: "usr-customer-001",
    name: "Олексій Замовник",
    email: "customer@example.com",
    role: "customer",
  };
  const performerUser = {
    id: "usr-performer-002",
    name: "Тарас Виконавець",
    email: "performer@example.com",
    role: "performer",
  };
  store.users.set(customerUser.id, customerUser);
  store.users.set(performerUser.id, performerUser);

  // 2. Profile creation
  // Customer profile (Kyiv base)
  store.customerProfiles.set(customerUser.id, {
    userId: customerUser.id,
    companyName: "ТОВ Агро-Лан",
    companyEdrpou: "12345678",
    iban: "UA213223130000026007234567890",
  });

  // Performer profile (Zhytomyr base, country coverage mode)
  store.performerProfiles.set(performerUser.id, {
    userId: performerUser.id,
    baseLocationLabel: "м. Житомир",
    baseLatitude: 50.2547,
    baseLongitude: 28.6587,
    coverageMode: "country", // По всій Україні
    coverageRadiusKm: null,
    companyName: "ФОП Шевченко Т.Г.",
    edrpou: "2987654321",
    iban: "UA213223130000026007987654321",
  });

  // 3. Order creation (Customer creates order in Ukraine)
  const KYIV_LAT = 50.4501;
  const KYIV_LNG = 30.5234;
  assert.equal(isWithinUkraine(KYIV_LAT, KYIV_LNG), true, "Location must be within Ukraine borders");

  const orderId = "order-full-001";
  const budget = new Prisma.Decimal("100000.00");
  const areaHa = new Prisma.Decimal("50.0");
  const initialOrder: InMemoryOrder = {
    id: orderId,
    orderNumber: "ORD-2026-0001",
    customerUserId: customerUser.id,
    performerUserId: null,
    status: "published",
    budget,
    currency: "UAH",
    areaHa,
    lat: KYIV_LAT,
    lng: KYIV_LNG,
    addressLabel: "м. Київ, вул. Хрещатик, 1",
    acceptedAt: null,
    depositDeadline: null,
    completedAt: null,
  };
  store.orders.set(orderId, initialOrder);
  assert.equal(initialOrder.status, "published");

  // 4. Performer claims/accepts the order
  const claimResult = await claimOrderForPerformer(store.tx, {
    orderId,
    performerUserId: performerUser.id,
  });
  assert.equal(claimResult.freshClaim, true);
  assert.equal(claimResult.order.status, "accepted");
  assert.equal(claimResult.order.performerUserId, performerUser.id);
  assert.ok(claimResult.order.depositDeadline, "Performer has 12h deposit deadline");

  // 5. Performer creates deposit intent & pays guarantee deposit via LiqPay (test card 4242 4242 4242 4242)
  const performerExpectedDeposit = depositAmountFor(budget); // 30,000 UAH
  assert.equal(performerExpectedDeposit.toNumber(), 30000);

  const perfIntentRes = await createDepositIntent(store.tx, {
    orderId,
    role: "performer",
    method: "card",
    intentId: "intent-perf-001",
  });
  assert.equal(perfIntentRes.intent.role, "performer");
  assert.equal(perfIntentRes.intent.amount.toNumber(), 30000);

  // Performer enters test card: 4242 4242 4242 4242, 10/29, 123
  const perfPayment = buildLiqPayTestPayment({
    intentId: perfIntentRes.intent.id,
    amount: perfIntentRes.intent.amount,
    currency: "UAH",
    status: "sandbox",
  });
  assert.equal(liqpayVerifySignature(perfPayment.data, perfPayment.signature), true);

  const perfConfirm = await confirmDeposit(store.tx, {
    paymentIntentId: perfIntentRes.intent.id,
    data: perfPayment.data,
    signature: perfPayment.signature,
  });
  assert.equal(perfConfirm.order.status, "requires_confirmation");
  assert.equal(perfConfirm.intent.status, "paid");

  // Check performer escrow lock is held
  const perfLock = store.escrowLocks.get(`${orderId}:performer`);
  assert.ok(perfLock, "Performer escrow lock created");
  assert.equal(perfLock.status, "held");
  assert.equal(perfLock.amount.toNumber(), 30000);

  // 6. Customer creates deposit intent & pays (part 1 + service fee) via LiqPay
  const customerFee = serviceFeeAmount(budget.toNumber()); // 8.5% of 100000 = 8500 UAH
  assert.equal(customerFee, 8500);

  const custIntentRes = await createDepositIntent(store.tx, {
    orderId,
    role: "customer",
    method: "card",
    intentId: "intent-cust-001",
  });
  assert.equal(custIntentRes.intent.role, "customer");
  assert.equal(custIntentRes.intent.amount.toNumber(), 38500); // 30,000 deposit + 8,500 fee

  // Customer enters test card: 4242 4242 4242 4242, 10/29, 123
  const custPayment = buildLiqPayTestPayment({
    intentId: custIntentRes.intent.id,
    amount: custIntentRes.intent.amount,
    currency: "UAH",
    status: "sandbox",
  });
  assert.equal(liqpayVerifySignature(custPayment.data, custPayment.signature), true);

  const custConfirm = await confirmDeposit(store.tx, {
    paymentIntentId: custIntentRes.intent.id,
    data: custPayment.data,
    signature: custPayment.signature,
  });
  assert.equal(custConfirm.order.status, "confirmed");
  assert.equal(custConfirm.intent.status, "paid");

  // Check customer escrow lock is held (deposit portion: 30000)
  const custLock = store.escrowLocks.get(`${orderId}:customer`);
  assert.ok(custLock, "Customer escrow lock created");
  assert.equal(custLock.status, "held");
  assert.equal(custLock.amount.toNumber(), 30000);

  // 7. En Route: Performer departs to field
  assert.equal(canTransition("confirmed", "en_route"), true);
  await store.tx.order.update({
    where: { id: orderId },
    data: { status: "en_route" },
  });
  await store.tx.orderStatusEvent.create({
    data: { orderId, status: "en_route", note: "Виїхав на поле" },
  });
  assert.equal(store.orders.get(orderId)?.status, "en_route");

  // 8. Start: Performer arrives and starts work
  assert.equal(canTransition("en_route", "started"), true);
  await store.tx.order.update({
    where: { id: orderId },
    data: { status: "started" },
  });
  await store.tx.orderStatusEvent.create({
    data: { orderId, status: "started", note: "Почав виконання" },
  });
  assert.equal(store.orders.get(orderId)?.status, "started");

  // 9. Work progress updates (with note and camera photos)
  const progress1: InMemoryProgress = {
    id: "prog-1",
    orderId,
    percent: 15,
    note: "Оброблено перші 7.5 га",
    images: [],
    createdAt: new Date(),
  };
  store.progressUpdates.push(progress1);

  // Substantial progress update (>30%) with camera photo base64
  const progress2: InMemoryProgress = {
    id: "prog-2",
    orderId,
    percent: 45,
    note: "Оброблено 22.5 га. Фото поля з камери трактора.",
    images: [{ dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==", name: "camera-field.jpg" }],
    createdAt: new Date(),
  };
  store.progressUpdates.push(progress2);
  assert.ok(progress2.percent >= 30, "Milestone >= 30% reached");

  // Final 100% progress
  const progress3: InMemoryProgress = {
    id: "prog-3",
    orderId,
    percent: 100,
    note: "Роботи повністю виконано. 50 га оброблено.",
    images: [{ dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==", name: "final-field.jpg" }],
    createdAt: new Date(),
  };
  store.progressUpdates.push(progress3);

  // 10. Performer finishes work
  assert.equal(canTransition("started", "completed"), true);
  await store.tx.order.update({
    where: { id: orderId },
    data: { status: "completed", completedAt: new Date() },
  });
  await store.tx.orderStatusEvent.create({
    data: { orderId, status: "completed", note: "Виконавець завершив роботу" },
  });
  assert.equal(store.orders.get(orderId)?.status, "completed");

  // 11. Customer accepts and confirms completion with 5-star review
  await store.tx.review.create({
    data: {
      orderId,
      authorUserId: customerUser.id,
      performerUserId: performerUser.id,
      rating: 5,
      text: "Чудова робота! Все вчасно та якісно.",
    },
  });

  // 12. Escrow unfreeze and financial settlement
  // Release held escrow locks for both sides
  await releaseEscrowForOrder(store.tx, { orderId, to: "released" });
  assert.equal(perfLock.status, "release_pending");
  assert.equal(custLock.status, "release_pending");

  // Settle provider holds (reversal of holds back to cards / completion)
  await settleProviderHolds({ orderId, to: "released", client: store.tx });
  assert.equal(perfLock.status, "released");
  assert.equal(custLock.status, "released");

  // Provider calls: holds reversed
  assert.ok(store.providerCalls.length >= 2, "LiqPay hold completion/reversal executed for both parties");
  for (const call of store.providerCalls) {
    assert.equal(call.flag, "reversal", "Funds unheld/reversed back without penalty");
  }

  // Performer wallet receives payment (budget 100000 - fee 8500 = 91500)
  const performerPayout = budget.toNumber() - customerFee;
  await (store.tx.wallet.upsert as any)({
    where: { userId: performerUser.id },
    create: { balance: performerPayout },
  });
  const perfWallet = store.wallets.get(performerUser.id);
  assert.equal(perfWallet?.balance, 91500, "Performer received net payout of 91,500 UAH");

  // Final verification of order state
  const finalOrder = store.orders.get(orderId);
  assert.equal(finalOrder?.status, "completed");
  assert.ok(finalOrder?.completedAt);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite 2: Arbitration in Favor of Performer
// ─────────────────────────────────────────────────────────────────────────────
test("Arbitration Scenario 1: Started → Arbitration → Resolution in favor of PERFORMER (close_plain) → Deposits Released", async (t) => {
  const store = createInMemoryStore();
  t.after(() => store.restore());

  const orderId = "order-arbitration-perf-002";
  const budget = new Prisma.Decimal("60000.00");

  // Setup order in 'started' state with deposits held
  const order: InMemoryOrder = {
    id: orderId,
    orderNumber: "ORD-2026-0002",
    customerUserId: "cust-002",
    performerUserId: "perf-002",
    status: "started",
    budget,
    currency: "UAH",
    areaHa: new Prisma.Decimal("20.0"),
    lat: 50.4501,
    lng: 30.5234,
    addressLabel: "м. Київ",
    acceptedAt: new Date(),
    depositDeadline: null,
    completedAt: null,
  };
  store.orders.set(orderId, order);

  // Escrow locks held (18,000 UAH per side = 30% of 60,000)
  store.escrowLocks.set(`${orderId}:performer`, {
    id: "lk-p2",
    orderId,
    role: "performer",
    userId: "perf-002",
    amount: new Prisma.Decimal("18000.00"),
    status: "held",
    releasedAt: null,
  });
  store.escrowLocks.set(`${orderId}:customer`, {
    id: "lk-c2",
    orderId,
    role: "customer",
    userId: "cust-002",
    amount: new Prisma.Decimal("18000.00"),
    status: "held",
    releasedAt: null,
  });

  store.paymentIntents.set("intent-p2", {
    id: "intent-p2",
    orderId,
    role: "performer",
    part: 1,
    amount: new Prisma.Decimal("18000.00"),
    depositAmount: new Prisma.Decimal("18000.00"),
    feeAmount: new Prisma.Decimal("0"),
    feeRate: null,
    currency: "UAH",
    provider: "liqpay",
    status: "paid",
    data: "test",
    signature: "test",
    providerOrderId: "lp-p2",
    providerRaw: { action: "hold", payment_id: 11111 },
    paidAt: new Date(),
  });
  store.paymentIntents.set("intent-c2", {
    id: "intent-c2",
    orderId,
    role: "customer",
    part: 1,
    amount: new Prisma.Decimal("23100.00"),
    depositAmount: new Prisma.Decimal("18000.00"),
    feeAmount: new Prisma.Decimal("5100.00"),
    feeRate: SERVICE_FEE_RATE,
    currency: "UAH",
    provider: "liqpay",
    status: "paid",
    data: "test",
    signature: "test",
    providerOrderId: "lp-c2",
    providerRaw: { action: "hold", payment_id: 22222 },
    paidAt: new Date(),
  });

  // 1. Dispute arises → Order transferred to arbitration
  assert.equal(canTransition("started", "arbitration"), true);
  await store.tx.order.update({
    where: { id: orderId },
    data: { status: "arbitration" },
  });
  await store.tx.orderStatusEvent.create({
    data: { orderId, status: "arbitration", note: "Спір щодо умов виконання" },
  });
  assert.equal(store.orders.get(orderId)?.status, "arbitration");

  // 2. Customer proposes resolution without fine: close_plain (in favor of performer)
  const resolutionId = "res-plain-001";
  store.arbitrationResolutions.set(resolutionId, {
    id: resolutionId,
    orderId,
    proposedById: "cust-002",
    decision: "close_plain",
    status: "pending",
    reason: "Домовились закрити мирно без штрафу",
    rating: 5,
    comment: "Все врегульовано",
    decidedAt: null,
  });

  // 3. Performer approves resolution
  const resolution = store.arbitrationResolutions.get(resolutionId)!;
  assert.equal(resolution.status, "pending");
  assert.equal(resolution.decision, "close_plain");

  // Approve execution (matching approve/route.ts logic):
  assert.equal(canTransition("arbitration", "completed"), true);
  await store.tx.order.update({
    where: { id: orderId },
    data: { status: "completed", completedAt: new Date() },
  });
  await store.tx.arbitrationResolution.update({
    where: { id: resolutionId },
    data: { status: "approved", decidedAt: new Date() },
  });

  // Release escrows without penalty: both released
  await releaseEscrowForOrder(store.tx, { orderId, to: "released" });
  await settleProviderHolds({ orderId, to: "released", client: store.tx });

  // 4. Assertions
  const updatedOrder = store.orders.get(orderId);
  assert.equal(updatedOrder?.status, "completed");
  assert.equal(store.arbitrationResolutions.get(resolutionId)?.status, "approved");

  const pLock = store.escrowLocks.get(`${orderId}:performer`);
  const cLock = store.escrowLocks.get(`${orderId}:customer`);
  assert.equal(pLock?.status, "released", "Performer guarantee deposit is unheld and returned (no fine)");
  assert.equal(cLock?.status, "released", "Customer guarantee deposit is unheld and returned");

  // Holds reversed on LiqPay
  for (const call of store.providerCalls) {
    assert.equal(call.flag, "reversal");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite 3: Arbitration in Favor of Customer
// ─────────────────────────────────────────────────────────────────────────────
test("Arbitration Scenario 2: Started → Arbitration → Resolution in favor of CUSTOMER (close_fine) → Performer Forfeited & Customer Released", async (t) => {
  const store = createInMemoryStore();
  t.after(() => store.restore());

  const orderId = "order-arbitration-cust-003";
  const budget = new Prisma.Decimal("80000.00");

  // Setup order in 'started' state
  const order: InMemoryOrder = {
    id: orderId,
    orderNumber: "ORD-2026-0003",
    customerUserId: "cust-003",
    performerUserId: "perf-003",
    status: "started",
    budget,
    currency: "UAH",
    areaHa: new Prisma.Decimal("30.0"),
    lat: 50.4501,
    lng: 30.5234,
    addressLabel: "м. Київ",
    acceptedAt: new Date(),
    depositDeadline: null,
    completedAt: null,
  };
  store.orders.set(orderId, order);

  // Escrow locks held (24,000 UAH per side = 30% of 80,000)
  store.escrowLocks.set(`${orderId}:performer`, {
    id: "lk-p3",
    orderId,
    role: "performer",
    userId: "perf-003",
    amount: new Prisma.Decimal("24000.00"),
    status: "held",
    releasedAt: null,
  });
  store.escrowLocks.set(`${orderId}:customer`, {
    id: "lk-c3",
    orderId,
    role: "customer",
    userId: "cust-003",
    amount: new Prisma.Decimal("24000.00"),
    status: "held",
    releasedAt: null,
  });

  store.paymentIntents.set("intent-p3", {
    id: "intent-p3",
    orderId,
    role: "performer",
    part: 1,
    amount: new Prisma.Decimal("24000.00"),
    depositAmount: new Prisma.Decimal("24000.00"),
    feeAmount: new Prisma.Decimal("0"),
    feeRate: null,
    currency: "UAH",
    provider: "liqpay",
    status: "paid",
    data: "test",
    signature: "test",
    providerOrderId: "lp-p3",
    providerRaw: { action: "hold", payment_id: 33333 },
    paidAt: new Date(),
  });
  store.paymentIntents.set("intent-c3", {
    id: "intent-c3",
    orderId,
    role: "customer",
    part: 1,
    amount: new Prisma.Decimal("30800.00"),
    depositAmount: new Prisma.Decimal("24000.00"),
    feeAmount: new Prisma.Decimal("6800.00"),
    feeRate: SERVICE_FEE_RATE,
    currency: "UAH",
    provider: "liqpay",
    status: "paid",
    data: "test",
    signature: "test",
    providerOrderId: "lp-c3",
    providerRaw: { action: "hold", payment_id: 44444 },
    paidAt: new Date(),
  });

  // 1. Order transferred to arbitration due to performer fault
  assert.equal(canTransition("started", "arbitration"), true);
  await store.tx.order.update({
    where: { id: orderId },
    data: { status: "arbitration" },
  });
  await store.tx.orderStatusEvent.create({
    data: { orderId, status: "arbitration", note: "Неякісне виконання робіт, порушення агротехнічних норм" },
  });
  assert.equal(store.orders.get(orderId)?.status, "arbitration");

  // 2. Customer proposes resolution WITH FINE on performer: close_fine
  const resolutionId = "res-fine-002";
  store.arbitrationResolutions.set(resolutionId, {
    id: resolutionId,
    orderId,
    proposedById: "cust-003",
    decision: "close_fine", // Fine on performer
    status: "pending",
    reason: "Утримання застави виконавця через брак у роботі",
    rating: 1,
    comment: "Робота виконана неякісно",
    decidedAt: null,
  });

  // 3. Resolution approved
  const resolution = store.arbitrationResolutions.get(resolutionId)!;
  assert.equal(resolution.status, "pending");
  assert.equal(resolution.decision, "close_fine");

  // Approve execution (matching approve/route.ts withFine branch):
  assert.equal(canTransition("arbitration", "completed"), true);
  await store.tx.order.update({
    where: { id: orderId },
    data: { status: "completed", completedAt: new Date() },
  });
  await store.tx.arbitrationResolution.update({
    where: { id: resolutionId },
    data: { status: "approved", decidedAt: new Date() },
  });

  // Performer deposit forfeited, customer deposit released
  await releaseEscrowForOrder(store.tx, { orderId, role: "performer", to: "forfeited" });
  await releaseEscrowForOrder(store.tx, { orderId, role: "customer", to: "released" });

  await settleProviderHolds({ orderId, role: "performer", to: "forfeited", client: store.tx });
  await settleProviderHolds({ orderId, role: "customer", to: "released", client: store.tx });

  // 4. Assertions
  const updatedOrder = store.orders.get(orderId);
  assert.equal(updatedOrder?.status, "completed");
  assert.equal(store.arbitrationResolutions.get(resolutionId)?.status, "approved");

  const pLock = store.escrowLocks.get(`${orderId}:performer`);
  const cLock = store.escrowLocks.get(`${orderId}:customer`);
  assert.equal(pLock?.status, "forfeited", "Performer deposit is forfeited as penalty");
  assert.equal(cLock?.status, "released", "Customer deposit is released back to customer");

  // Check payment intents reflect settlement
  const pIntent = store.paymentIntents.get("intent-p3");
  const cIntent = store.paymentIntents.get("intent-c3");
  assert.equal(pIntent?.status, "forfeited");
  assert.equal(cIntent?.status, "released");

  // Provider calls check: performer hold captured (money kept), customer hold reversed (money returned)
  const perfCaptureCall = store.providerCalls.find((c) => c.orderId === "lp-p3");
  const custReversalCall = store.providerCalls.find((c) => c.orderId === "lp-c3");
  assert.ok(perfCaptureCall, "Performer hold was captured");
  assert.equal(perfCaptureCall.action, "hold_completion");
  assert.equal(perfCaptureCall.flag, undefined, "Hold captured without reversal flag");

  assert.ok(custReversalCall, "Customer hold was reversed");
  assert.equal(custReversalCall.flag, "reversal", "Customer hold reversed back to card");
});
