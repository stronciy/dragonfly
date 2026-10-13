import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { releaseEscrowForOrder, settleProviderHolds } from "../../src/shared";

// Refund/forfeit matrix: every partial deposit stage × every exit path
// (cancel / refuse / both timeout workers / arbitration+completion plain and
// fine). Each trigger runner performs the EXACT releaseEscrowForOrder +
// settleProviderHolds calls its production call site performs, so a green
// cell proves the per-role money outcome of that path for that stage.
// Budget 100000 → performer deposit 30000, customer part1 9000, part2 21000;
// legacy orders paid the old single 10% deposit (10000 per side).

process.env.LIQPAY_PUBLIC_KEY = "test_public";
process.env.LIQPAY_PRIVATE_KEY = "test_private";

type FakeIntent = {
  id: string;
  orderId: string;
  role: string;
  part: number;
  amount: Prisma.Decimal;
  status: string;
  providerOrderId: string | null;
  providerRaw: { action: string | null; payment_id: number | null } | null;
};

type FakeLock = {
  id: string;
  orderId: string;
  role: string;
  userId: string;
  amount: Prisma.Decimal;
  status: string;
  releasedAt: Date | null;
};

type ProviderCall = { action: string; orderId: string; flag?: string };

type Stage = { intents: FakeIntent[]; locks: FakeLock[]; orderId: string };

const dec = (value: string) => new Prisma.Decimal(value);

function paidIntent(args: {
  id: string;
  orderId: string;
  role: "performer" | "customer";
  part: 1 | 2;
  amount: string;
  action: "hold" | "pay";
}): FakeIntent {
  return {
    id: args.id,
    orderId: args.orderId,
    role: args.role,
    part: args.part,
    amount: dec(args.amount),
    status: "paid",
    providerOrderId: `lp-${args.id}`,
    providerRaw: { action: args.action, payment_id: 424242 },
  };
}

function pendingIntent(args: {
  id: string;
  orderId: string;
  role: "performer" | "customer";
  part: 1 | 2;
  amount: string;
}): FakeIntent {
  return {
    id: args.id,
    orderId: args.orderId,
    role: args.role,
    part: args.part,
    amount: dec(args.amount),
    status: "pending",
    providerOrderId: null,
    providerRaw: null,
  };
}

function heldLock(args: {
  orderId: string;
  role: "performer" | "customer";
  userId: string;
  amount: string;
}): FakeLock {
  return {
    id: `lk-${args.role}`,
    orderId: args.orderId,
    role: args.role,
    userId: args.userId,
    amount: dec(args.amount),
    status: "held",
    releasedAt: null,
  };
}

function stageNobodyPaid(orderId: string): Stage {
  return {
    orderId,
    intents: [pendingIntent({ id: "perf", orderId, role: "performer", part: 1, amount: "30000" })],
    locks: [],
  };
}

function stagePerformerPaidOnly(orderId: string): Stage {
  return {
    orderId,
    intents: [paidIntent({ id: "perf", orderId, role: "performer", part: 1, amount: "30000", action: "hold" })],
    locks: [heldLock({ orderId, role: "performer", userId: "p1", amount: "30000" })],
  };
}

function stageCustomerPart1Only(orderId: string): Stage {
  return {
    orderId,
    intents: [
      paidIntent({ id: "perf", orderId, role: "performer", part: 1, amount: "30000", action: "hold" }),
      paidIntent({ id: "c1", orderId, role: "customer", part: 1, amount: "9000", action: "hold" }),
    ],
    locks: [
      heldLock({ orderId, role: "performer", userId: "p1", amount: "30000" }),
      heldLock({ orderId, role: "customer", userId: "c1", amount: "9000" }),
    ],
  };
}

function stageFullEscrow(orderId: string): Stage {
  return {
    orderId,
    intents: [
      paidIntent({ id: "perf", orderId, role: "performer", part: 1, amount: "30000", action: "hold" }),
      paidIntent({ id: "c1", orderId, role: "customer", part: 1, amount: "9000", action: "hold" }),
      paidIntent({ id: "c2", orderId, role: "customer", part: 2, amount: "21000", action: "hold" }),
    ],
    locks: [
      heldLock({ orderId, role: "performer", userId: "p1", amount: "30000" }),
      heldLock({ orderId, role: "customer", userId: "c1", amount: "30000" }),
    ],
  };
}

function stagePart2PendingPaused(orderId: string): Stage {
  return {
    orderId,
    intents: [
      paidIntent({ id: "perf", orderId, role: "performer", part: 1, amount: "30000", action: "hold" }),
      paidIntent({ id: "c1", orderId, role: "customer", part: 1, amount: "9000", action: "hold" }),
      pendingIntent({ id: "c2", orderId, role: "customer", part: 2, amount: "21000" }),
    ],
    locks: [
      heldLock({ orderId, role: "performer", userId: "p1", amount: "30000" }),
      heldLock({ orderId, role: "customer", userId: "c1", amount: "9000" }),
    ],
  };
}

function stageLegacyConfirmed(orderId: string): Stage {
  return {
    orderId,
    intents: [
      paidIntent({ id: "perf", orderId, role: "performer", part: 1, amount: "10000", action: "hold" }),
      paidIntent({ id: "c1", orderId, role: "customer", part: 1, amount: "10000", action: "pay" }),
    ],
    locks: [
      heldLock({ orderId, role: "performer", userId: "p1", amount: "10000" }),
      heldLock({ orderId, role: "customer", userId: "c1", amount: "10000" }),
    ],
  };
}

function makeReleaseTx(locks: FakeLock[]) {
  return {
    escrowLock: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { orderId: string; status: string; role?: string };
        data: { status: string };
      }) => {
        let count = 0;
        for (const lock of locks) {
          if (
            lock.orderId === where.orderId &&
            lock.status === where.status &&
            (!where.role || lock.role === where.role)
          ) {
            lock.status = data.status;
            count += 1;
          }
        }
        return { count };
      },
    },
  } as unknown as Prisma.TransactionClient;
}

function makeSettleClient(intents: FakeIntent[], locks: FakeLock[]) {
  const client = {
    paymentIntent: {
      findMany: async ({
        where,
      }: {
        where: { orderId: string; status: string; role: string };
      }) =>
        intents
          .filter(
            (intent) =>
              intent.orderId === where.orderId &&
              intent.status === where.status &&
              intent.role === where.role
          )
          .map((intent) => ({ ...intent })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: { status: string };
      }) => {
        let count = 0;
        for (const intent of intents) {
          if (intent.id === where.id && intent.status === where.status) {
            intent.status = data.status;
            count += 1;
          }
        }
        return { count };
      },
    },
    escrowLock: {
      findMany: async ({
        where,
      }: {
        where: { orderId: string; status: string; role?: string };
      }) =>
        locks
          .filter(
            (lock) =>
              lock.orderId === where.orderId &&
              lock.status === where.status &&
              (!where.role || lock.role === where.role)
          )
          .map((lock) => ({ ...lock })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: { status: string; releasedAt?: Date };
      }) => {
        let count = 0;
        for (const lock of locks) {
          if (lock.id === where.id && lock.status === where.status) {
            lock.status = data.status;
            if (data.releasedAt) lock.releasedAt = data.releasedAt;
            count += 1;
          }
        }
        return { count };
      },
    },
  };
  return client as unknown as Prisma.TransactionClient;
}

function interceptProviderFetch(calls: ProviderCall[]) {
  const realFetch = globalThis.fetch;
  let failForOrderId: string | null = null;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    const payload = JSON.parse(
      Buffer.from(body.get("data") ?? "", "base64").toString("utf8")
    ) as { action?: unknown; order_id?: unknown; flag?: unknown };
    const call: ProviderCall = {
      action: String(payload.action),
      orderId: String(payload.order_id),
    };
    if (payload.flag !== undefined) call.flag = String(payload.flag);
    calls.push(call);
    if (failForOrderId !== null && failForOrderId === call.orderId) {
      return new Response(
        JSON.stringify({ result: "error", err_code: "injected", err_description: "injected failure" }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ result: "ok", status: "ok", payment_id: 424242 }), {
      status: 200,
    });
  };
  return {
    restore: () => {
      globalThis.fetch = realFetch;
    },
    failFor: (orderId: string | null) => {
      failForOrderId = orderId;
    },
  };
}

function callSummary(calls: ProviderCall[]) {
  return calls
    .map((call) => `${call.action}${call.flag ? `:${call.flag}` : ""}@${call.orderId}`)
    .sort();
}

type Trigger = (
  tx: Prisma.TransactionClient,
  client: Prisma.TransactionClient,
  orderId: string
) => Promise<void>;

// Mirrors orders/[orderId]/cancel/route.ts
const cancelByCustomer: Trigger = async (tx, client, orderId) => {
  await releaseEscrowForOrder(tx, { orderId, to: "refunded" });
  await settleProviderHolds({ orderId, to: "refunded", client });
};

// Mirrors orders/[orderId]/refuse/route.ts before the customer committed
const refuseBeforeCustomerCommit: Trigger = async (tx, client, orderId) => {
  await releaseEscrowForOrder(tx, { orderId, role: "performer", to: "released" });
  await settleProviderHolds({ orderId, role: "performer", to: "released", client });
};

// Mirrors refuse (after the customer committed), arbitration/resolve/approve
// with fine, and confirm-completion with fine
const forfeitPerformerReleaseCustomer: Trigger = async (tx, client, orderId) => {
  await releaseEscrowForOrder(tx, { orderId, role: "performer", to: "forfeited" });
  await releaseEscrowForOrder(tx, { orderId, role: "customer", to: "released" });
  await settleProviderHolds({ orderId, role: "performer", to: "forfeited", client });
  await settleProviderHolds({ orderId, role: "customer", to: "released", client });
};

// Mirrors depositDeadlineTimeout.worker.ts (requires_confirmation timeout)
const depositDeadlineTimeout: Trigger = async (tx, client, orderId) => {
  await releaseEscrowForOrder(tx, { orderId, to: "refunded" });
  await settleProviderHolds({ orderId, to: "refunded", client });
};

// Mirrors expiredOrders.worker.ts (accepted timeout) and arbitration /
// confirm-completion resolved plain
const releaseAll: Trigger = async (tx, client, orderId) => {
  await releaseEscrowForOrder(tx, { orderId, to: "released" });
  await settleProviderHolds({ orderId, to: "released", client });
};

type MatrixExpectation = {
  performerLock: string | null;
  customerLock: string | null;
  customerLockAmount?: string;
  calls: string[];
  intentStatuses: Record<string, string>;
};

type MatrixCell = {
  stage: string;
  trigger: string;
  seed: (orderId: string) => Stage;
  run: Trigger;
  expect: MatrixExpectation;
};

const REVERSAL_PERF = "hold_completion:reversal@lp-perf";
const REVERSAL_C1 = "hold_completion:reversal@lp-c1";
const REVERSAL_C2 = "hold_completion:reversal@lp-c2";
const CAPTURE_PERF = "hold_completion@lp-perf";
const REFUND_C1 = "refund@lp-c1";

const CELLS: MatrixCell[] = [
  {
    stage: "nobody paid (accepted)",
    trigger: "cancel (customer)",
    seed: stageNobodyPaid,
    run: cancelByCustomer,
    expect: { performerLock: null, customerLock: null, calls: [], intentStatuses: { perf: "pending" } },
  },
  {
    stage: "nobody paid (accepted)",
    trigger: "refuse (performer, customer not committed)",
    seed: stageNobodyPaid,
    run: refuseBeforeCustomerCommit,
    expect: { performerLock: null, customerLock: null, calls: [], intentStatuses: { perf: "pending" } },
  },
  {
    stage: "nobody paid (accepted)",
    trigger: "timeout: expired orders worker",
    seed: stageNobodyPaid,
    run: releaseAll,
    expect: { performerLock: null, customerLock: null, calls: [], intentStatuses: { perf: "pending" } },
  },
  {
    stage: "performer paid only (requires_confirmation)",
    trigger: "cancel (customer)",
    seed: stagePerformerPaidOnly,
    run: cancelByCustomer,
    expect: {
      performerLock: "refunded",
      customerLock: null,
      calls: [REVERSAL_PERF],
      intentStatuses: { perf: "refunded" },
    },
  },
  {
    stage: "performer paid only (requires_confirmation)",
    trigger: "refuse (performer, customer not committed)",
    seed: stagePerformerPaidOnly,
    run: refuseBeforeCustomerCommit,
    expect: {
      performerLock: "released",
      customerLock: null,
      calls: [REVERSAL_PERF],
      intentStatuses: { perf: "released" },
    },
  },
  {
    stage: "performer paid only (requires_confirmation)",
    trigger: "timeout: deposit deadline worker",
    seed: stagePerformerPaidOnly,
    run: depositDeadlineTimeout,
    expect: {
      performerLock: "refunded",
      customerLock: null,
      calls: [REVERSAL_PERF],
      intentStatuses: { perf: "refunded" },
    },
  },
  {
    stage: "customer part1 only (confirmed)",
    trigger: "refuse (performer, customer committed)",
    seed: stageCustomerPart1Only,
    run: forfeitPerformerReleaseCustomer,
    expect: {
      performerLock: "forfeited",
      customerLock: "released",
      customerLockAmount: "9000",
      calls: [REVERSAL_C1, CAPTURE_PERF],
      intentStatuses: { perf: "forfeited", c1: "released" },
    },
  },
  {
    stage: "customer part1 only (confirmed)",
    trigger: "arbitration/completion plain",
    seed: stageCustomerPart1Only,
    run: releaseAll,
    expect: {
      performerLock: "released",
      customerLock: "released",
      customerLockAmount: "9000",
      calls: [REVERSAL_C1, REVERSAL_PERF],
      intentStatuses: { perf: "released", c1: "released" },
    },
  },
  {
    stage: "customer part1 only (confirmed)",
    trigger: "arbitration/completion fine",
    seed: stageCustomerPart1Only,
    run: forfeitPerformerReleaseCustomer,
    expect: {
      performerLock: "forfeited",
      customerLock: "released",
      customerLockAmount: "9000",
      calls: [REVERSAL_C1, CAPTURE_PERF],
      intentStatuses: { perf: "forfeited", c1: "released" },
    },
  },
  {
    stage: "full escrow: part1 + part2 paid (started)",
    trigger: "arbitration/completion plain",
    seed: stageFullEscrow,
    run: releaseAll,
    expect: {
      performerLock: "released",
      customerLock: "released",
      customerLockAmount: "30000",
      calls: [REVERSAL_C1, REVERSAL_C2, REVERSAL_PERF],
      intentStatuses: { perf: "released", c1: "released", c2: "released" },
    },
  },
  {
    stage: "full escrow: part1 + part2 paid (started)",
    trigger: "arbitration/completion fine",
    seed: stageFullEscrow,
    run: forfeitPerformerReleaseCustomer,
    expect: {
      performerLock: "forfeited",
      customerLock: "released",
      customerLockAmount: "30000",
      calls: [REVERSAL_C1, REVERSAL_C2, CAPTURE_PERF],
      intentStatuses: { perf: "forfeited", c1: "released", c2: "released" },
    },
  },
  {
    stage: "full escrow: part1 + part2 paid (started)",
    trigger: "cancel (machinery; the route cannot reach a started order)",
    seed: stageFullEscrow,
    run: cancelByCustomer,
    expect: {
      performerLock: "refunded",
      customerLock: "refunded",
      customerLockAmount: "30000",
      calls: [REVERSAL_C1, REVERSAL_C2, REVERSAL_PERF],
      intentStatuses: { perf: "refunded", c1: "refunded", c2: "refunded" },
    },
  },
  {
    stage: "part2 pending / order paused (started)",
    trigger: "arbitration/completion plain",
    seed: stagePart2PendingPaused,
    run: releaseAll,
    expect: {
      performerLock: "released",
      customerLock: "released",
      customerLockAmount: "9000",
      calls: [REVERSAL_C1, REVERSAL_PERF],
      intentStatuses: { perf: "released", c1: "released", c2: "pending" },
    },
  },
  {
    stage: "part2 pending / order paused (started)",
    trigger: "arbitration/completion fine",
    seed: stagePart2PendingPaused,
    run: forfeitPerformerReleaseCustomer,
    expect: {
      performerLock: "forfeited",
      customerLock: "released",
      customerLockAmount: "9000",
      calls: [REVERSAL_C1, CAPTURE_PERF],
      intentStatuses: { perf: "forfeited", c1: "released", c2: "pending" },
    },
  },
  {
    stage: "part2 pending / order paused (started)",
    trigger: "cancel (machinery; the route cannot reach a started order)",
    seed: stagePart2PendingPaused,
    run: cancelByCustomer,
    expect: {
      performerLock: "refunded",
      customerLock: "refunded",
      customerLockAmount: "9000",
      calls: [REVERSAL_C1, REVERSAL_PERF],
      intentStatuses: { perf: "refunded", c1: "refunded", c2: "pending" },
    },
  },
  {
    stage: "legacy confirmed (old single 10% deposits)",
    trigger: "refuse (performer, customer committed)",
    seed: stageLegacyConfirmed,
    run: forfeitPerformerReleaseCustomer,
    expect: {
      performerLock: "forfeited",
      customerLock: "released",
      customerLockAmount: "10000",
      calls: [CAPTURE_PERF, REFUND_C1],
      intentStatuses: { perf: "forfeited", c1: "released" },
    },
  },
  {
    stage: "legacy confirmed (old single 10% deposits)",
    trigger: "arbitration/completion plain",
    seed: stageLegacyConfirmed,
    run: releaseAll,
    expect: {
      performerLock: "released",
      customerLock: "released",
      customerLockAmount: "10000",
      calls: [REVERSAL_PERF, REFUND_C1],
      intentStatuses: { perf: "released", c1: "released" },
    },
  },
];

for (const cell of CELLS) {
  test(`refund matrix: ${cell.stage} × ${cell.trigger}`, async (t) => {
    const stage = cell.seed("o-matrix");
    const calls: ProviderCall[] = [];
    const provider = interceptProviderFetch(calls);
    t.after(() => provider.restore());

    const tx = makeReleaseTx(stage.locks);
    const client = makeSettleClient(stage.intents, stage.locks);
    await cell.run(tx, client, stage.orderId);

    const performer = stage.locks.find((lock) => lock.role === "performer");
    const customer = stage.locks.find((lock) => lock.role === "customer");
    assert.equal(performer?.status ?? null, cell.expect.performerLock);
    assert.equal(customer?.status ?? null, cell.expect.customerLock);
    if (cell.expect.customerLockAmount) {
      assert.ok(customer);
      assert.equal(customer.amount.toString(), cell.expect.customerLockAmount);
    }
    assert.deepEqual(callSummary(calls), cell.expect.calls);
    for (const [intentId, status] of Object.entries(cell.expect.intentStatuses)) {
      const intent = stage.intents.find((i) => i.id === intentId);
      assert.ok(intent, `intent ${intentId} missing`);
      assert.equal(intent.status, status);
    }
  });
}

test("never double-refund: partial provider failure + retry moves each intent's money exactly once", async (t) => {
  const stage = stageFullEscrow("o-retry");
  const calls: ProviderCall[] = [];
  const provider = interceptProviderFetch(calls);
  t.after(() => provider.restore());
  provider.failFor("lp-c2");

  const tx = makeReleaseTx(stage.locks);
  const client = makeSettleClient(stage.intents, stage.locks);

  await releaseEscrowForOrder(tx, { orderId: stage.orderId, to: "refunded" });
  await settleProviderHolds({ orderId: stage.orderId, to: "refunded", client });

  assert.equal(stage.locks.find((l) => l.role === "performer")?.status, "refunded");
  assert.equal(stage.locks.find((l) => l.role === "customer")?.status, "refund_pending");
  assert.equal(stage.intents.find((i) => i.id === "c1")?.status, "refunded");
  assert.equal(stage.intents.find((i) => i.id === "c2")?.status, "paid");

  provider.failFor(null);
  await settleProviderHolds({ orderId: stage.orderId, to: "refunded", client });

  assert.equal(stage.locks.find((l) => l.role === "customer")?.status, "refunded");
  assert.equal(stage.intents.find((i) => i.id === "c2")?.status, "refunded");

  const perIntent = new Map<string, number>();
  for (const call of calls) {
    perIntent.set(call.orderId, (perIntent.get(call.orderId) ?? 0) + 1);
  }
  assert.equal(perIntent.get("lp-perf"), 1);
  assert.equal(perIntent.get("lp-c1"), 1);
  assert.equal(perIntent.get("lp-c2"), 2);
});

test("re-running a settled trigger is a no-op (lock-level idempotency)", async (t) => {
  const stage = stagePerformerPaidOnly("o-rerun");
  const calls: ProviderCall[] = [];
  const provider = interceptProviderFetch(calls);
  t.after(() => provider.restore());

  const tx = makeReleaseTx(stage.locks);
  const client = makeSettleClient(stage.intents, stage.locks);
  await releaseEscrowForOrder(tx, { orderId: stage.orderId, to: "refunded" });
  await settleProviderHolds({ orderId: stage.orderId, to: "refunded", client });
  await releaseEscrowForOrder(tx, { orderId: stage.orderId, to: "refunded" });
  await settleProviderHolds({ orderId: stage.orderId, to: "refunded", client });

  assert.deepEqual(callSummary(calls), [REVERSAL_PERF]);
  assert.equal(stage.locks[0].status, "refunded");
});
