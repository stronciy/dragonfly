// Scenario world: seeded users, orders and helpers that drive real route
// handlers and payment services against the in-memory database.
import { Prisma } from "@prisma/client";
import { db, installFakePrisma } from "./fakePrisma";
import { prisma } from "../../src/lib/prisma";
import { signAccessToken } from "../../src/lib/auth/tokens";
import { liqpayEncodeData, liqpaySign } from "../../src/services/liqpay.service";
import { confirmDeposit, createDepositIntent, claimOrderForPerformer } from "../../src/services/deposit.service";

process.env.JWT_ACCESS_SECRET ??= "test-access-secret-for-scenarios";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-for-scenarios";
process.env.LIQPAY_PUBLIC_KEY ??= "sandbox_test_public";
process.env.LIQPAY_PRIVATE_KEY ??= "sandbox_test_private";

installFakePrisma();

export const USERS = {
  customer: "cust_1",
  otherCustomer: "cust_2",
  performer: "perf_1",
  otherPerformer: "perf_2",
} as const;

const DAY = 24 * 60 * 60 * 1000;

export function resetWorld() {
  db.reset();
  const now = new Date();
  const user = (id: string, role: "customer" | "performer", name: string) =>
    db.insert("user", {
      id,
      name,
      email: `${id}@test.local`,
      role,
      phone: null,
      avatarUrl: null,
      sessionVersion: 0,
      blockedAt: null,
      createdAt: now,
    });
  user(USERS.customer, "customer", "Замовник");
  user(USERS.otherCustomer, "customer", "Інший замовник");
  user(USERS.performer, "performer", "Виконавець");
  user(USERS.otherPerformer, "performer", "Інший виконавець");
  for (const performerUserId of [USERS.performer, USERS.otherPerformer]) {
    db.insert("performerProfile", {
      id: `pp_${performerUserId}`,
      userId: performerUserId,
      avgRating: 0,
      reviewCount: 0,
      baseLatitude: 49.5,
      baseLongitude: 34.5,
    });
  }
  db.insert("customerProfile", { id: "cp_1", userId: USERS.customer, riskScore: 0 });
  orderSeq = 0;
}

let orderSeq = 0;

export async function bearer(userId: string): Promise<string> {
  const role = userId.startsWith("cust") ? "customer" : "performer";
  const token = await signAccessToken({ userId, email: `${userId}@test.local`, role, sv: 0 });
  return `Bearer ${token}`;
}

/**
 * Creates an order row. `days` is the inclusive calendar length of the work
 * (1 = single day). `dates: null` simulates an order without dates.
 */
export function createOrder(opts: {
  days?: number;
  budget?: number;
  dates?: null;
  status?: string;
  performerUserId?: string | null;
  startInPast?: boolean;
}): string {
  orderSeq += 1;
  const id = `order_${orderSeq}`;
  const days = opts.days ?? 1;
  const from = opts.dates === null ? null : new Date(Date.now() - 60 * 60 * 1000);
  const to = opts.dates === null || !from ? null : new Date(from.getTime() + (days - 1) * DAY);
  db.insert("order", {
    id,
    orderNumber: `DF-${String(orderSeq).padStart(4, "0")}`,
    customerUserId: USERS.customer,
    performerUserId: opts.performerUserId === undefined ? null : opts.performerUserId,
    status: opts.status ?? "published",
    budget: new Prisma.Decimal(opts.budget ?? 10000),
    currency: "UAH",
    areaHa: new Prisma.Decimal(10),
    lat: 49.5,
    lng: 34.5,
    locationLabel: "Полтавська обл., тестове поле",
    regionName: "Полтавська обл.",
    dateFrom: from,
    dateTo: to,
    comment: null,
    specs: {},
    acceptedAt: null,
    completedAt: null,
    depositDeadline: null,
    customerPart2Deadline: null,
    part2ReminderSentAt: null,
    part2OverdueNotifiedAt: null,
    paymentPaused: false,
    enRouteAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

export function order(id: string) {
  const row = db.findUnique("order", { where: { id } });
  if (!row) throw new Error(`order ${id} not found`);
  return row as Record<string, any>;
}

export function rowsWhere(table: string, where: Record<string, unknown>) {
  return db.findMany(table, { where }) as Record<string, any>[];
}

export function ctx(orderId: string) {
  return { params: Promise.resolve({ orderId }) };
}

export async function call(
  userId: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Request> {
  const init: RequestInit = {
    method,
    headers: { authorization: await bearer(userId), ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  return new Request("http://localhost/api/v1/test", init);
}

export type RouteResult = { status: number; body: any };

export async function readResponse(res: Response): Promise<RouteResult> {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Confirms a LiqPay payment for a pending intent the same way the callback does. */
export async function settlePayment(intentId: string) {
  const intent = db.findUnique("paymentIntent", { where: { id: intentId } }) as Record<string, any>;
  const data = liqpayEncodeData({
    status: "success",
    action: "pay",
    amount: Number(intent.amount),
    currency: "UAH",
  } as any);
  const signature = liqpaySign(data);
  return confirmDeposit(prisma as unknown as Prisma.TransactionClient, {
    paymentIntentId: intentId,
    data,
    signature,
  });
}

/** Performer takes a published order and pays the 30% deposit. */
export async function performerClaimsAndPays(orderId: string, performerUserId: string = USERS.performer) {
  await claimOrderForPerformer(prisma as unknown as Prisma.TransactionClient, { orderId, performerUserId });
  const { intent } = await createDepositIntent(prisma as unknown as Prisma.TransactionClient, {
    orderId,
    role: "performer",
  });
  return settlePayment(intent.id);
}

/** Customer pays the counter deposit through the real customer-intent route. */
export async function customerPays(orderId: string, part?: 1 | 2) {
  const { POST } = await import("../../src/app/api/v1/orders/[orderId]/deposits/customer-intent/route");
  const req = await call(USERS.customer, "POST", part ? { part } : {});
  const res = await POST(req, ctx(orderId));
  const result = await readResponse(res);
  if (result.status !== 200 && result.status !== 201) return result;
  const intentId = result.body?.data?.paymentIntent?.id ?? result.body?.data?.id;
  if (!intentId) return result;
  await settlePayment(intentId);
  return result;
}

export function notificationsFor(userId: string) {
  return db.findMany("notification", { where: { userId } }) as Record<string, any>[];
}

export function escrowOf(orderId: string, role: "customer" | "performer") {
  const lock = db.findUnique("escrowLock", { where: { orderId, role } }) as Record<string, any> | null;
  return lock ? { status: lock.status, amount: Number(lock.amount) } : null;
}

export { DAY };
