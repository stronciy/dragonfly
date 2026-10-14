import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { ApiError } from "../../src/shared";
import {
  createApplication,
  withdrawApplication,
  acceptApplication,
  rejectApplication,
} from "../../src/services/application.service";

type App = {
  id: string;
  orderId: string;
  performerUserId: string;
  type: string;
  message: string | null;
  proposedPriceUah: Prisma.Decimal | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
};

type Ord = {
  id: string;
  status: string;
  customerUserId: string;
  performerUserId: string | null;
  acceptedAt: Date | null;
  depositDeadline: Date | null;
};

type AppWhere = {
  id?: string;
  uniq_order_performer_application?: { orderId: string; performerUserId: string };
};

type AppWhereMany = {
  orderId: string;
  status?: string;
  id?: { not: string };
};

function makeDb(seedOrders: Ord[], seedApps: App[]) {
  const orders = seedOrders.map((o) => ({ ...o }));
  const apps = seedApps.map((a) => ({ ...a }));
  const statusEvents: { orderId: string; status: string; note: string | null }[] = [];

  const db = {
    order: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        orders.find((o) => o.id === where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Partial<Ord>;
      }) => {
        const order = orders.find(
          (o) => o.id === where.id && (where.status == null || o.status === where.status)
        );
        if (!order) return { count: 0 };
        Object.assign(order, data);
        return { count: 1 };
      },
    },
    orderApplication: {
      findUnique: async ({ where }: { where: AppWhere }) => {
        if (where.id) return apps.find((a) => a.id === where.id) ?? null;
        const key = where.uniq_order_performer_application!;
        return (
          apps.find(
            (a) => a.orderId === key.orderId && a.performerUserId === key.performerUserId
          ) ?? null
        );
      },
      create: async ({
        data,
      }: {
        data: Partial<App> & Pick<App, "orderId" | "performerUserId" | "type">;
      }) => {
        const row: App = {
          id: data.id ?? `app-${apps.length + 1}`,
          orderId: data.orderId,
          performerUserId: data.performerUserId,
          type: data.type,
          message: data.message ?? null,
          proposedPriceUah: data.proposedPriceUah ?? null,
          status: data.status ?? "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
          decidedAt: data.decidedAt ?? null,
        };
        apps.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<App> }) => {
        const row = apps.find((a) => a.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }: { where: AppWhereMany; data: Partial<App> }) => {
        const matched = apps.filter(
          (a) =>
            a.orderId === where.orderId &&
            (where.status == null || a.status === where.status) &&
            (where.id?.not == null || a.id !== where.id.not)
        );
        matched.forEach((a) => Object.assign(a, data, { updatedAt: new Date() }));
        return { count: matched.length };
      },
    },
    orderStatusEvent: {
      create: async ({
        data,
      }: {
        data: { orderId: string; status: string; note: string | null };
      }) => {
        statusEvents.push(data);
        return data;
      },
    },
  };

  return { db: db as unknown as Prisma.TransactionClient, orders, apps, statusEvents };
}

function seedApp(overrides: Partial<App>): App {
  return {
    id: "a1",
    orderId: "o1",
    performerUserId: "p1",
    type: "apply",
    message: null,
    proposedPriceUah: null,
    status: "pending",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    decidedAt: null,
    ...overrides,
  };
}

function seedOrder(overrides: Partial<Ord>): Ord {
  return {
    id: "o1",
    status: "published",
    customerUserId: "c1",
    performerUserId: null,
    acceptedAt: null,
    depositDeadline: null,
    ...overrides,
  };
}

test("createApplication: published order creates a pending application", async () => {
  const { db, apps } = makeDb([seedOrder({})], []);
  const app = await createApplication(db, {
    orderId: "o1",
    performerUserId: "p1",
    type: "apply",
    message: "Готовий",
    proposedPriceUah: 1200,
  });
  assert.equal(app.status, "pending");
  assert.equal(app.orderId, "o1");
  assert.equal(app.performerUserId, "p1");
  assert.equal(app.message, "Готовий");
  assert.equal(app.proposedPriceUah?.toString(), "1200");
  assert.equal(apps.length, 1);
});

test("createApplication: non-published order is rejected with 409", async () => {
  const { db } = makeDb([seedOrder({ status: "accepted", performerUserId: "p9" })], []);
  await assert.rejects(
    createApplication(db, { orderId: "o1", performerUserId: "p1", type: "apply" }),
    (err: unknown) => err instanceof ApiError && err.status === 409
  );
});

test("createApplication: active duplicate is rejected with 409", async () => {
  const { db } = makeDb([seedOrder({})], [seedApp({ status: "pending" })]);
  await assert.rejects(
    createApplication(db, { orderId: "o1", performerUserId: "p1", type: "apply" }),
    (err: unknown) => err instanceof ApiError && err.status === 409
  );
});

test("createApplication: withdrawn application is revived to pending", async () => {
  const { db, apps } = makeDb(
    [seedOrder({})],
    [seedApp({ status: "withdrawn", decidedAt: new Date("2026-01-02T00:00:00Z") })]
  );
  const app = await createApplication(db, { orderId: "o1", performerUserId: "p1", type: "apply" });
  assert.equal(app.status, "pending");
  assert.equal(app.decidedAt, null);
  assert.equal(apps.length, 1);
});

test("withdrawApplication: own pending application becomes withdrawn", async () => {
  const { db } = makeDb([], [seedApp({ status: "pending" })]);
  const app = await withdrawApplication({ orderId: "o1", performerUserId: "p1", db });
  assert.equal(app.status, "withdrawn");
  assert.ok(app.decidedAt instanceof Date);
});

test("withdrawApplication: non-pending application is rejected with 409", async () => {
  const { db } = makeDb([], [seedApp({ status: "accepted" })]);
  await assert.rejects(
    withdrawApplication({ orderId: "o1", performerUserId: "p1", db }),
    (err: unknown) => err instanceof ApiError && err.status === 409
  );
});

test("acceptApplication: assigns order, accepts one and rejects siblings", async () => {
  const orders = [seedOrder({})];
  const apps = [
    seedApp({ id: "a1", performerUserId: "p1", status: "pending" }),
    seedApp({ id: "a2", performerUserId: "p2", status: "pending" }),
    seedApp({ id: "a3", performerUserId: "p3", status: "pending" }),
  ];
  const { db, orders: storedOrders, apps: storedApps, statusEvents } = makeDb(orders, apps);

  const { order, application } = await acceptApplication({
    orderId: "o1",
    customerUserId: "c1",
    applicationId: "a1",
    db,
  });

  assert.equal(order.status, "accepted");
  assert.equal(order.performerUserId, "p1");
  assert.ok(order.acceptedAt instanceof Date);
  assert.ok(order.depositDeadline instanceof Date);
  assert.equal(application.status, "accepted");
  assert.ok(application.decidedAt instanceof Date);
  assert.equal(storedApps.find((x) => x.id === "a2")?.status, "rejected");
  assert.equal(storedApps.find((x) => x.id === "a3")?.status, "rejected");
  assert.ok(storedApps.find((x) => x.id === "a2")?.decidedAt instanceof Date);
  assert.equal(storedOrders[0].status, "accepted");
  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0].status, "accepted");
});

test("acceptApplication: non-owner is rejected with 403", async () => {
  const { db } = makeDb([seedOrder({})], [seedApp({ id: "a1", status: "pending" })]);
  await assert.rejects(
    acceptApplication({ orderId: "o1", customerUserId: "cX", applicationId: "a1", db }),
    (err: unknown) => err instanceof ApiError && err.status === 403
  );
});

test("acceptApplication: already-decided application is rejected with 409", async () => {
  const { db } = makeDb([seedOrder({})], [seedApp({ id: "a1", status: "accepted" })]);
  await assert.rejects(
    acceptApplication({ orderId: "o1", customerUserId: "c1", applicationId: "a1", db }),
    (err: unknown) => err instanceof ApiError && err.status === 409
  );
});

test("rejectApplication: owner rejects a pending application", async () => {
  const { db } = makeDb([seedOrder({})], [seedApp({ id: "a1", status: "pending" })]);
  const app = await rejectApplication({
    orderId: "o1",
    customerUserId: "c1",
    applicationId: "a1",
    db,
  });
  assert.equal(app.status, "rejected");
  assert.ok(app.decidedAt instanceof Date);
});

test("rejectApplication: non-owner is rejected with 403", async () => {
  const { db } = makeDb([seedOrder({})], [seedApp({ id: "a1", status: "pending" })]);
  await assert.rejects(
    rejectApplication({ orderId: "o1", customerUserId: "cX", applicationId: "a1", db }),
    (err: unknown) => err instanceof ApiError && err.status === 403
  );
});
