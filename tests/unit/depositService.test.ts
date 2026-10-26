import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  createLiqPayCheckout,
  liqpayEncodeData,
  liqpaySign,
  liqpayVerifySignature,
} from "../../src/shared";
import { transitionForConfirm, buildDepositPaidEvents } from "../../src/shared";
import { createDepositIntent, confirmDeposit } from "../../src/shared";
import { ApiError } from "../../src/shared";

test("liqpay sign/verify roundtrip", () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const data = liqpayEncodeData({
    public_key: "test_public",
    version: 3,
    action: "pay",
    amount: "100.00",
    currency: "UAH",
    description: "test",
    order_id: "order1",
  });
  const signature = liqpaySign(data);
  assert.equal(liqpayVerifySignature(data, signature), true);
  assert.equal(liqpayVerifySignature(data, `${signature}x`), false);
  assert.equal(liqpayVerifySignature(data, ""), false);
});

test("transitionForConfirm maps roles to next status", () => {
  assert.equal(transitionForConfirm("performer", "accepted"), "requires_confirmation");
  assert.equal(transitionForConfirm("customer", "requires_confirmation"), "confirmed");
  assert.equal(transitionForConfirm("performer", "published"), null);
  assert.equal(transitionForConfirm("customer", "accepted"), null);
  assert.equal(transitionForConfirm("customer", "confirmed"), null);
});

test("deposit checkout freezes funds (hold), not charges", () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const checkout = createLiqPayCheckout({
    orderId: "order1:customer:123",
    amount: 1000,
    currency: "UAH",
    description: "test",
  });
  const decoded = JSON.parse(Buffer.from(checkout.data, "base64").toString("utf8")) as { action?: string };
  assert.equal(decoded.action, "hold");
  assert.equal(liqpayVerifySignature(checkout.data, checkout.signature), true);
});

test("buildDepositPaidEvents performer branch notifies both + customer next step", () => {
  const events = buildDepositPaidEvents({
    orderId: "o1",
    toStatus: "requires_confirmation",
    role: "performer",
    customerUserId: "c1",
    performerUserId: "p1",
    providerStatus: "hold_wait",
  });
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "deposit.performer_paid",
    "escrow.changed",
    "order.status_changed",
    "deposit.customer_required",
    "payment:required",
  ]);
  for (const e of events.slice(0, 3)) {
    assert.deepEqual(e.targets, { userIds: ["c1", "p1"] });
  }
  assert.deepEqual(events[3].targets, { userIds: ["c1"] });
});

test("buildDepositPaidEvents customer branch confirms to both", () => {
  const events = buildDepositPaidEvents({
    orderId: "o1",
    toStatus: "confirmed",
    role: "customer",
    customerUserId: "c1",
    performerUserId: "p1",
    providerStatus: "success",
  });
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "deposit.customer_paid",
    "escrow.changed",
    "order.status_changed",
    "order.confirmed",
    "order:confirmed",
  ]);
});

test("buildDepositPaidEvents tolerates missing performer", () => {
  const events = buildDepositPaidEvents({
    orderId: "o1",
    toStatus: "confirmed",
    role: "customer",
    customerUserId: "c1",
    performerUserId: null,
    providerStatus: null,
  });
  for (const e of events.slice(0, 3)) {
    assert.deepEqual(e.targets, { userIds: ["c1"] });
  }
});

type FakeOrder = {
  id: string;
  budget: Prisma.Decimal;
  currency: string;
  status: string;
  customerUserId: string;
  performerUserId: string | null;
  depositDeadline: Date | null;
  orderNumber: string | null;
};

type FakeIntent = {
  id: string;
  orderId: string;
  role: string;
  part: number;
  amount: Prisma.Decimal;
  currency: string;
  provider: string;
  status: string;
  data: string;
  signature: string;
};

type FakeLock = {
  orderId: string;
  role: string;
  userId: string;
  amount: Prisma.Decimal;
  status: string;
  releasedAt: Date | null;
};

function makeFakeTx(order: FakeOrder) {
  const intents = new Map<string, FakeIntent>();
  const locks: FakeLock[] = [];
  const statusEvents: { status: string }[] = [];
  const tx = {
    order: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === order.id ? { ...order } : null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Partial<FakeOrder>;
      }) => {
        if (where.id !== order.id || where.status !== order.status) return { count: 0 };
        Object.assign(order, data);
        return { count: 1 };
      },
    },
    paymentIntent: {
      create: async ({ data }: { data: FakeIntent }) => {
        const row: FakeIntent = { ...data, id: data.id ?? "intent-x" };
        intents.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        intents.get(where.id) ?? null,
      findFirst: async () => null,
      findMany: async ({
        where,
      }: {
        where: { orderId: string; role: string; status: string };
      }) =>
        [...intents.values()].filter(
          (i) =>
            i.orderId === where.orderId &&
            i.role === where.role &&
            i.status === where.status
        ),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeIntent>;
      }) => {
        const row = intents.get(where.id);
        if (!row) return null;
        Object.assign(row, data);
        return row;
      },
    },
    escrowLock: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { uniq_order_role_lock: { orderId: string; role: string } };
        create: FakeLock;
        update: Partial<FakeLock>;
      }) => {
        const key = where.uniq_order_role_lock;
        let lock = locks.find((l) => l.orderId === key.orderId && l.role === key.role);
        if (!lock) {
          lock = { ...create };
          locks.push(lock);
        } else {
          Object.assign(lock, update);
        }
        return lock;
      },
    },
    orderStatusEvent: {
      create: async ({ data }: { data: { orderId: string; status: string } }) => {
        statusEvents.push(data);
        return data;
      },
    },
  };
  return { tx, locks, statusEvents };
}

test("customer confirm: full deposit intent, deadline cleared, escrow held", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order: FakeOrder = {
    id: "o1",
    budget: new Prisma.Decimal("100000"),
    currency: "UAH",
    status: "requires_confirmation",
    customerUserId: "c1",
    performerUserId: "p1",
    depositDeadline: new Date("2026-10-13T22:00:00.000Z"),
    orderNumber: null,
  };
  const { tx, locks } = makeFakeTx(order);
  const client = tx as unknown as Prisma.TransactionClient;

  const created = await createDepositIntent(client, {
    orderId: "o1",
    role: "customer",
    intentId: "ci1",
  });
  assert.equal(created.amount.toString(), "38500"); // deposit 30000 + fee 8500
  assert.equal(created.intent.amount.toString(), "38500");
  assert.equal((created.intent as any).depositAmount?.toString(), "30000"); // escrow lock amount
  assert.equal(created.intent.feeAmount.toString(), "8500");
  assert.equal(created.intent.part, 1);
  assert.ok(created.intent.data);
  assert.ok(created.intent.signature);

  const result = await confirmDeposit(client, {
    paymentIntentId: created.intent.id,
    data: created.intent.data,
    signature: created.intent.signature,
  });

  assert.equal(result.order.status, "confirmed");
  assert.equal(result.order.depositDeadline, null);
  assert.equal(locks.length, 1);
  assert.equal(locks[0].role, "customer");
  assert.equal(locks[0].status, "held");
  assert.equal(locks[0].amount.toString(), "30000"); // escrow is deposit only
});

test("customer confirm is idempotent when intent already paid", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order: FakeOrder = {
    id: "o2",
    budget: new Prisma.Decimal("100000"),
    currency: "UAH",
    status: "requires_confirmation",
    customerUserId: "c1",
    performerUserId: "p1",
    depositDeadline: new Date("2026-10-13T22:00:00.000Z"),
    orderNumber: null,
  };
  const { tx } = makeFakeTx(order);
  const client = tx as unknown as Prisma.TransactionClient;

  const created = await createDepositIntent(client, { orderId: "o2", role: "customer", intentId: "ci2" });
  assert.ok(created.intent.data);
  assert.ok(created.intent.signature);
  await confirmDeposit(client, {
    paymentIntentId: created.intent.id,
    data: created.intent.data,
    signature: created.intent.signature,
  });
  const replay = await confirmDeposit(client, {
    paymentIntentId: created.intent.id,
    data: created.intent.data,
    signature: created.intent.signature,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.order.status, "confirmed");
});

test("performer confirm: requires_confirmation + 24h counter-deposit deadline", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order: FakeOrder = {
    id: "o3",
    budget: new Prisma.Decimal("100000"),
    currency: "UAH",
    status: "accepted",
    customerUserId: "c1",
    performerUserId: "p1",
    depositDeadline: null,
    orderNumber: null,
  };
  const { tx, locks } = makeFakeTx(order);
  const client = tx as unknown as Prisma.TransactionClient;

  const created = await createDepositIntent(client, {
    orderId: "o3",
    role: "performer",
    intentId: "pi1",
  });
  assert.equal(created.amount.toString(), "30000");
  assert.ok(created.intent.data);
  assert.ok(created.intent.signature);

  const before = Date.now();
  const result = await confirmDeposit(client, {
    paymentIntentId: created.intent.id,
    data: created.intent.data,
    signature: created.intent.signature,
  });

  assert.equal(result.order.status, "requires_confirmation");
  assert.ok(result.order.depositDeadline);
  const hours = (result.order.depositDeadline.getTime() - before) / 3_600_000;
  assert.ok(hours > 23.9 && hours < 24.1, `deadline delta ${hours}h`);
  assert.equal(locks.length, 1);
  assert.equal(locks[0].role, "performer");
  assert.equal(locks[0].amount.toString(), "30000");
});

test("confirm rejects an intent whose order status forbids the transition", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order: FakeOrder = {
    id: "o4",
    budget: new Prisma.Decimal("100000"),
    currency: "UAH",
    status: "completed",
    customerUserId: "c1",
    performerUserId: "p1",
    depositDeadline: null,
    orderNumber: null,
  };
  const { tx, locks } = makeFakeTx(order);
  const client = tx as unknown as Prisma.TransactionClient;

  const created = await createDepositIntent(client, { orderId: "o4", role: "customer", intentId: "ci4" });
  assert.ok(created.intent.data);
  assert.ok(created.intent.signature);
  await assert.rejects(
    confirmDeposit(client, {
      paymentIntentId: created.intent.id,
      data: created.intent.data,
      signature: created.intent.signature,
    }),
    (err: unknown) => err instanceof ApiError && err.status === 409
  );
  assert.equal(locks.length, 0);
  assert.equal(order.status, "completed");
});
