import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { reservedEscrowTotal } from "../../src/services/billing.service";
import { signAccessToken } from "../../src/lib/auth/tokens";
import { prisma } from "../../src/lib/prisma";
import { GET as performerBillingSummary } from "../../src/app/api/v1/performer/billing/summary/route";
import { GET as customerBillingSummary } from "../../src/app/api/v1/billing/summary/route";

process.env.JWT_ACCESS_SECRET = "test_secret";

type FakeLock = {
  orderId: string;
  userId: string;
  role: string;
  amount: Prisma.Decimal;
  status: string;
};

type FakeLockWhere = { userId: string; role: string; status: { in: string[] } };

function sumLocks(locks: FakeLock[], where: FakeLockWhere): Prisma.Decimal | null {
  const rows = locks.filter(
    (l) => l.userId === where.userId && l.role === where.role && where.status.in.includes(l.status)
  );
  return rows.length ? rows.reduce((s, l) => s.add(l.amount), new Prisma.Decimal(0)) : null;
}

function makeFakeClient(locks: FakeLock[]) {
  const client = {
    escrowLock: {
      aggregate: async ({ where }: { where: FakeLockWhere }) => ({
        _sum: { amount: sumLocks(locks, where) },
      }),
    },
  };
  return client as unknown as Prisma.TransactionClient;
}

const LOCKS: FakeLock[] = [
  { orderId: "o1", userId: "p1", role: "performer", amount: new Prisma.Decimal("30000"), status: "held" },
  { orderId: "o2", userId: "p2", role: "performer", amount: new Prisma.Decimal("5000"), status: "held" },
  { orderId: "o3", userId: "p2", role: "performer", amount: new Prisma.Decimal("9999"), status: "released" },
  { orderId: "o4", userId: "c1", role: "customer", amount: new Prisma.Decimal("9000"), status: "held" },
];

test("reservedEscrowTotal: performer with one held lock → reservedTotal equals the held sum", async () => {
  const client = makeFakeClient(LOCKS);
  const total = await reservedEscrowTotal(client, { userId: "p1", role: "performer" });
  assert.ok(total > 0);
  assert.equal(total, 30000);
});

test("reservedEscrowTotal: second performer sees only their own open locks", async () => {
  const client = makeFakeClient(LOCKS);
  const p2 = await reservedEscrowTotal(client, { userId: "p2", role: "performer" });
  assert.equal(p2, 5000);
  const p1 = await reservedEscrowTotal(client, { userId: "p1", role: "performer" });
  assert.equal(p1, 30000);
});

test("reservedEscrowTotal: open statuses counted, settled statuses excluded", async () => {
  const locks: FakeLock[] = [
    { orderId: "a1", userId: "p3", role: "performer", amount: new Prisma.Decimal("100"), status: "held" },
    { orderId: "a2", userId: "p3", role: "performer", amount: new Prisma.Decimal("200"), status: "release_pending" },
    { orderId: "a3", userId: "p3", role: "performer", amount: new Prisma.Decimal("300"), status: "refund_pending" },
    { orderId: "a4", userId: "p3", role: "performer", amount: new Prisma.Decimal("400"), status: "forfeit_pending" },
    { orderId: "a5", userId: "p3", role: "performer", amount: new Prisma.Decimal("1000"), status: "released" },
    { orderId: "a6", userId: "p3", role: "performer", amount: new Prisma.Decimal("2000"), status: "refunded" },
    { orderId: "a7", userId: "p3", role: "performer", amount: new Prisma.Decimal("4000"), status: "forfeited" },
  ];
  const client = makeFakeClient(locks);
  const total = await reservedEscrowTotal(client, { userId: "p3", role: "performer" });
  assert.equal(total, 1000);
});

test("reservedEscrowTotal: same user's other-role locks not counted", async () => {
  const locks: FakeLock[] = [
    { orderId: "b1", userId: "u1", role: "performer", amount: new Prisma.Decimal("30000"), status: "held" },
    { orderId: "b2", userId: "u1", role: "customer", amount: new Prisma.Decimal("9000"), status: "held" },
  ];
  const client = makeFakeClient(locks);
  assert.equal(await reservedEscrowTotal(client, { userId: "u1", role: "performer" }), 30000);
  assert.equal(await reservedEscrowTotal(client, { userId: "u1", role: "customer" }), 9000);
});

test("reservedEscrowTotal: no locks → 0", async () => {
  const client = makeFakeClient(LOCKS);
  assert.equal(await reservedEscrowTotal(client, { userId: "nobody", role: "performer" }), 0);
});

type FakeUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  sessionVersion: number;
};

const USERS: FakeUser[] = [
  { id: "p1", name: "Performer One", email: "p1@t.ua", role: "performer", phone: null, avatarUrl: null, createdAt: new Date(), sessionVersion: 1 },
  { id: "p2", name: "Performer Two", email: "p2@t.ua", role: "performer", phone: null, avatarUrl: null, createdAt: new Date(), sessionVersion: 1 },
  { id: "c1", name: "Customer One", email: "c1@t.ua", role: "customer", phone: null, avatarUrl: null, createdAt: new Date(), sessionVersion: 1 },
];

type FakeOrderRow = { performerUserId: string | null; customerUserId: string; status: string; budget: Prisma.Decimal };

const ORDERS: FakeOrderRow[] = [
  { performerUserId: "p1", customerUserId: "c1", status: "completed", budget: new Prisma.Decimal("100000") },
  { performerUserId: "p2", customerUserId: "c9", status: "completed", budget: new Prisma.Decimal("20000") },
  { performerUserId: "p1", customerUserId: "c1", status: "started", budget: new Prisma.Decimal("55555") },
];

type SummaryBody = {
  success: boolean;
  data?: { summary?: { completedTotal: number; reservedTotal: number; currency: string } };
};

function authedReq(url: string, token: string) {
  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

async function tokenFor(userId: string, role: "performer" | "customer") {
  return signAccessToken({ userId, email: `${userId}@t.ua`, role, sv: 1 });
}

function patchPrisma(t: { after: (fn: () => void) => void }) {
  const userDelegate = prisma.user as unknown as {
    findUnique: (args: { where: { id: string } }) => Promise<FakeUser | null>;
  };
  const orderDelegate = prisma.order as unknown as {
    aggregate: (args: {
      where: { performerUserId?: string; customerUserId?: string; status: string };
    }) => Promise<{ _sum: { budget: Prisma.Decimal | null } }>;
  };
  const lockDelegate = prisma.escrowLock as unknown as {
    aggregate: (args: { where: FakeLockWhere }) => Promise<{ _sum: { amount: Prisma.Decimal | null } }>;
  };
  const originals = {
    findUnique: userDelegate.findUnique,
    orderAggregate: orderDelegate.aggregate,
    lockAggregate: lockDelegate.aggregate,
  };
  userDelegate.findUnique = async ({ where }) => USERS.find((u) => u.id === where.id) ?? null;
  orderDelegate.aggregate = async ({ where }) => {
    const rows = ORDERS.filter(
      (o) =>
        (where.performerUserId === undefined || o.performerUserId === where.performerUserId) &&
        (where.customerUserId === undefined || o.customerUserId === where.customerUserId) &&
        o.status === where.status
    );
    return {
      _sum: {
        budget: rows.length ? rows.reduce((s, o) => s.add(o.budget), new Prisma.Decimal(0)) : null,
      },
    };
  };
  lockDelegate.aggregate = async ({ where }) => ({ _sum: { amount: sumLocks(LOCKS, where) } });
  t.after(() => {
    userDelegate.findUnique = originals.findUnique;
    orderDelegate.aggregate = originals.orderAggregate;
    lockDelegate.aggregate = originals.lockAggregate;
  });
}

test("performer billing summary: reservedTotal from own escrow locks, completed from own orders", async (t) => {
  patchPrisma(t);
  const token = await tokenFor("p1", "performer");
  const res = await performerBillingSummary(
    authedReq("http://localhost/api/v1/performer/billing/summary", token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as SummaryBody;
  assert.equal(body.success, true);
  assert.equal(body.data?.summary?.reservedTotal, 30000);
  assert.equal(body.data?.summary?.completedTotal, 100000);
  assert.equal(body.data?.summary?.currency, "UAH");
});

test("performer billing summary: second performer sees only their own totals", async (t) => {
  patchPrisma(t);
  const token = await tokenFor("p2", "performer");
  const res = await performerBillingSummary(
    authedReq("http://localhost/api/v1/performer/billing/summary", token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as SummaryBody;
  assert.equal(body.data?.summary?.reservedTotal, 5000);
  assert.equal(body.data?.summary?.completedTotal, 20000);
});

test("performer billing summary: customer gets 403, cannot see a performer total", async (t) => {
  patchPrisma(t);
  const token = await tokenFor("c1", "customer");
  const res = await performerBillingSummary(
    authedReq("http://localhost/api/v1/performer/billing/summary", token)
  );
  assert.equal(res.status, 403);
  const body = (await res.json()) as SummaryBody;
  assert.equal(body.success, false);
  assert.equal(body.data, undefined);
});

test("customer billing summary: reservedTotal from own customer escrow locks", async (t) => {
  patchPrisma(t);
  const token = await tokenFor("c1", "customer");
  const res = await customerBillingSummary(authedReq("http://localhost/api/v1/billing/summary", token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as SummaryBody;
  assert.equal(body.success, true);
  assert.equal(body.data?.summary?.reservedTotal, 9000);
  assert.equal(body.data?.summary?.completedTotal, 100000);
  assert.equal(body.data?.summary?.currency, "UAH");
});

test("customer billing summary: performer gets 403", async (t) => {
  patchPrisma(t);
  const token = await tokenFor("p1", "performer");
  const res = await customerBillingSummary(authedReq("http://localhost/api/v1/billing/summary", token));
  assert.equal(res.status, 403);
  const body = (await res.json()) as SummaryBody;
  assert.equal(body.success, false);
  assert.equal(body.data, undefined);
});
