import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  ApiError,
  canSubmitProgress,
  createDepositIntent,
  isStagedDepositOrder,
  openPart2DepositStage,
} from "../../src/shared";

type FakeOrder = {
  id: string;
  budget: Prisma.Decimal;
  currency: string;
  status: string;
  customerUserId: string;
  performerUserId: string | null;
  depositDeadline: Date | null;
  customerPart2Deadline: Date | null;
  paymentPaused: boolean;
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
  serverUrl: string | null;
  resultUrl: string | null;
};

function makeFakeTx(order: FakeOrder, intents: FakeIntent[]) {
  const tx = {
    order: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === order.id ? { ...order } : null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; customerPart2Deadline: Date | null };
        data: Partial<FakeOrder>;
      }) => {
        if (where.id !== order.id) return { count: 0 };
        if (order.customerPart2Deadline !== where.customerPart2Deadline) return { count: 0 };
        Object.assign(order, data);
        return { count: 1 };
      },
    },
    paymentIntent: {
      create: async ({ data }: { data: FakeIntent }) => {
        const row: FakeIntent = { ...data, id: data.id ?? "intent-x" };
        intents.push(row);
        return row;
      },
      findFirst: async ({
        where,
      }: {
        where: {
          orderId: string;
          role: string;
          part: number;
          status?: string;
          amount?: Prisma.Decimal;
        };
      }) =>
        intents.find(
          (i) =>
            i.orderId === where.orderId &&
            i.role === where.role &&
            i.part === where.part &&
            (where.status === undefined || i.status === where.status) &&
            (where.amount === undefined || i.amount.eq(where.amount))
        ) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        intents.find((i) => i.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeIntent>;
      }) => {
        const row = intents.find((i) => i.id === where.id);
        if (!row) return null;
        Object.assign(row, data);
        return row;
      },
    },
    escrowLock: {
      upsert: async () => ({}),
    },
    orderStatusEvent: {
      create: async ({ data }: { data: { orderId: string; status: string } }) => data,
    },
  };
  return { tx, order, intents };
}

function seedOrder(overrides: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id: "o1",
    budget: new Prisma.Decimal("100000"),
    currency: "UAH",
    status: "started",
    customerUserId: "c1",
    performerUserId: "p1",
    depositDeadline: null,
    customerPart2Deadline: null,
    paymentPaused: false,
    orderNumber: null,
    ...overrides,
  };
}

function seedPart1Paid(intents: FakeIntent[], orderId: string) {
  intents.push({
    id: "ci1",
    orderId,
    role: "customer",
    part: 1,
    amount: new Prisma.Decimal("9000"),
    currency: "UAH",
    provider: "liqpay",
    status: "paid",
    data: "d",
    signature: "s",
    serverUrl: "https://cb.example",
    resultUrl: null,
  });
}

test("createDepositIntent: customer part 2 → amount 21000, part labeled 2", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order = seedOrder();
  const intents: FakeIntent[] = [];
  const { tx } = makeFakeTx(order, intents);
  const client = tx as unknown as Prisma.TransactionClient;

  const created = await createDepositIntent(client, {
    orderId: "o1",
    role: "customer",
    part: 2,
    intentId: "ci2",
  });
  assert.equal(created.intent.part, 2);
  assert.equal(created.intent.amount.toString(), "21000");
  assert.equal(created.amount.toString(), "21000");
  assert.equal(created.intent.status, "pending");
});

test("createDepositIntent: part 2 rejected for performer; defaults unchanged", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order = seedOrder();
  const intents: FakeIntent[] = [];
  const { tx } = makeFakeTx(order, intents);
  const client = tx as unknown as Prisma.TransactionClient;

  await assert.rejects(
    createDepositIntent(client, { orderId: "o1", role: "performer", part: 2 }),
    (err: unknown) => err instanceof ApiError && err.status === 400
  );

  const performer = await createDepositIntent(client, { orderId: "o1", role: "performer" });
  assert.equal(performer.intent.part, 1);
  assert.equal(performer.intent.amount.toString(), "30000");

  const customerPart1 = await createDepositIntent(client, { orderId: "o1", role: "customer" });
  assert.equal(customerPart1.intent.part, 1);
  assert.equal(customerPart1.intent.amount.toString(), "9000");
});

test("first ≥30% milestone opens part-2 stage: exactly one intent + deadline ≈ now+12h", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order = seedOrder();
  const intents: FakeIntent[] = [];
  seedPart1Paid(intents, "o1");
  const { tx } = makeFakeTx(order, intents);
  const client = tx as unknown as Prisma.TransactionClient;

  const before = Date.now();
  const intent = await openPart2DepositStage(client, { orderId: "o1", intentId: "pi2" });
  assert.ok(intent);
  assert.equal(intent.part, 2);
  assert.equal(intent.role, "customer");
  assert.equal(intent.amount.toString(), "21000");
  assert.equal(intent.status, "pending");

  const part2Intents = intents.filter((i) => i.role === "customer" && i.part === 2);
  assert.equal(part2Intents.length, 1);

  assert.ok(order.customerPart2Deadline);
  const deltaHours = (order.customerPart2Deadline.getTime() - before) / 3_600_000;
  assert.ok(deltaHours > 11.9 && deltaHours < 12.1, `deadline delta ${deltaHours}h`);
});

test("second ≥30% milestone is a no-op: no new intent, deadline unchanged", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order = seedOrder();
  const intents: FakeIntent[] = [];
  seedPart1Paid(intents, "o1");
  const { tx } = makeFakeTx(order, intents);
  const client = tx as unknown as Prisma.TransactionClient;

  const first = await openPart2DepositStage(client, { orderId: "o1", intentId: "pi2" });
  assert.ok(first);
  const deadlineAfterFirst = order.customerPart2Deadline;

  const second = await openPart2DepositStage(client, { orderId: "o1", intentId: "pi2b" });
  assert.equal(second, null);

  const part2Intents = intents.filter((i) => i.role === "customer" && i.part === 2);
  assert.equal(part2Intents.length, 1);
  assert.equal(order.customerPart2Deadline, deadlineAfterFirst);
});

test("latch guard: deadline already claimed → no intent even without an existing part-2 intent", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order = seedOrder({ customerPart2Deadline: new Date() });
  const intents: FakeIntent[] = [];
  seedPart1Paid(intents, "o1");
  const { tx } = makeFakeTx(order, intents);
  const client = tx as unknown as Prisma.TransactionClient;

  const intent = await openPart2DepositStage(client, { orderId: "o1", intentId: "pi2c" });
  assert.equal(intent, null);
  assert.equal(intents.filter((i) => i.part === 2).length, 0);
});

test("part-1 unpaid → part-2 stage not opened", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order = seedOrder();
  const intents: FakeIntent[] = [];
  const { tx } = makeFakeTx(order, intents);
  const client = tx as unknown as Prisma.TransactionClient;

  const intent = await openPart2DepositStage(client, { orderId: "o1", intentId: "pi2d" });
  assert.equal(intent, null);
  assert.equal(order.customerPart2Deadline, null);
  assert.equal(intents.filter((i) => i.part === 2).length, 0);
});

test("paymentPaused blocks progress submission (canSubmitProgress)", () => {
  assert.equal(canSubmitProgress({ paymentPaused: true }), false);
  assert.equal(canSubmitProgress({ paymentPaused: false }), true);
  assert.equal(canSubmitProgress({}), true);
});

test("isStagedDepositOrder: staged part-1 amount matches; legacy 10% and unpaid do not", async () => {
  const order = seedOrder();
  const intents: FakeIntent[] = [];
  seedPart1Paid(intents, "o1");
  const { tx } = makeFakeTx(order, intents);
  const client = tx as unknown as Prisma.TransactionClient;

  assert.equal(await isStagedDepositOrder(client, order), true);

  intents[0].amount = new Prisma.Decimal("10000");
  assert.equal(await isStagedDepositOrder(client, order), false);

  intents[0].amount = new Prisma.Decimal("9000");
  intents[0].status = "pending";
  assert.equal(await isStagedDepositOrder(client, order), false);
});

test("legacy order (old single-rate deposit paid as part 1) never opens a part-2 stage", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const order = seedOrder();
  const intents: FakeIntent[] = [];
  intents.push({
    id: "ci-legacy",
    orderId: "o1",
    role: "customer",
    part: 1,
    amount: new Prisma.Decimal("10000"),
    currency: "UAH",
    provider: "liqpay",
    status: "paid",
    data: "d",
    signature: "s",
    serverUrl: "https://cb.example",
    resultUrl: null,
  });
  const { tx } = makeFakeTx(order, intents);
  const client = tx as unknown as Prisma.TransactionClient;

  const intent = await openPart2DepositStage(client, { orderId: "o1", intentId: "pi2-legacy" });
  assert.equal(intent, null);
  assert.equal(order.customerPart2Deadline, null);
  assert.equal(intents.filter((i) => i.part === 2).length, 0);
});
