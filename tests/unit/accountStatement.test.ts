// Виписка по рахунку: баланс виконавця по кроках, взаємозалік по заказу та
// сверка з підсумками журналу.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeLedger, type LedgerEntry } from "../../src/lib/finance/ledger";
import { buildAccountStatement, type StatementRoleData } from "../../src/lib/finance/statement";

const user = { id: "u1", name: "Test", email: "t@test.ua", phone: null, role: "performer" };

function entry(partial: Partial<LedgerEntry> & Pick<LedgerEntry, "id" | "occurredAt" | "kind" | "direction" | "amount" | "status">): LedgerEntry {
  return {
    currency: "UAH",
    orderId: "o1",
    orderNumber: "DF-1",
    title: partial.kind,
    reason: "",
    ...partial,
  };
}

function roleData(role: "customer" | "performer", entries: LedgerEntry[]): StatementRoleData {
  return { entries, summary: summarizeLedger(role, entries) };
}

describe("виписка виконавця", () => {
  it("баланс рухається тільки за зарахуваннями та виведеннями, застава його не змінює", () => {
    const performer = roleData("performer", [
      entry({ id: "dep", occurredAt: "2026-01-01T10:00:00.000Z", kind: "performer_deposit", direction: "out", amount: 300, status: "in_escrow" }),
      entry({ id: "pay1", occurredAt: "2026-01-02T10:00:00.000Z", kind: "order_payout", direction: "in", amount: 1000, status: "completed" }),
      entry({ id: "wd1", occurredAt: "2026-01-03T10:00:00.000Z", kind: "withdrawal", direction: "out", amount: 300, status: "requested" }),
      entry({ id: "wd2", occurredAt: "2026-01-04T10:00:00.000Z", kind: "withdrawal", direction: "out", amount: 200, status: "rejected" }),
    ]);
    const st = buildAccountStatement({ user, roles: { customer: null, performer } });

    assert.deepEqual(
      st.operations.map((o) => [o.kind, o.balanceEffect, o.balanceAfter]),
      [
        ["performer_deposit", 0, 0],
        ["order_payout", 1000, 1000],
        ["withdrawal", -300, 700],
        ["withdrawal", 0, 700],
      ],
    );
    assert.equal(st.availableUah, 700);
    assert.equal(st.balanceMatchesSummary, true);
  });

  it("сплачена застава тільки за штрафом виходить з виписки як витрата", () => {
    const performer = roleData("performer", [
      entry({ id: "dep", occurredAt: "2026-01-01T10:00:00.000Z", kind: "performer_deposit", direction: "out", amount: 300, status: "forfeited" }),
    ]);
    const st = buildAccountStatement({ user, roles: { customer: null, performer } });
    assert.equal(st.totals.penaltiesPaid, 300);
    assert.equal(st.orders[0].paidOut, 300);
    assert.equal(st.orders[0].net, -300);
  });
});

describe("взаєморозрахунки по заказу", () => {
  it("заказчик: сплатив депозит і комісію, отримав повернення — нетто дорівнює комісії", () => {
    const customer = roleData("customer", [
      entry({ id: "dep", occurredAt: "2026-01-01T10:00:00.000Z", kind: "customer_deposit", direction: "out", amount: 1000, status: "refunded" }),
      entry({ id: "fee", occurredAt: "2026-01-01T10:00:00.000Z", kind: "service_fee", direction: "out", amount: 85, status: "completed" }),
      entry({ id: "ref", occurredAt: "2026-01-05T10:00:00.000Z", kind: "customer_refund", direction: "in", amount: 1000, status: "refunded" }),
    ]);
    const st = buildAccountStatement({ user: { ...user, role: "customer" }, roles: { customer, performer: null } });

    assert.equal(st.orders.length, 1);
    const order = st.orders[0];
    assert.equal(order.paidOut, 1085);
    assert.equal(order.received, 1000);
    assert.equal(order.net, -85);
    assert.equal(st.totals.feesPaid, 85);
    assert.equal(st.totals.refundsReceived, 1000);
  });

  it("кошти в ескроу не входять у нетто, а показуються окремо як «в процесі»", () => {
    const customer = roleData("customer", [
      entry({ id: "dep", occurredAt: "2026-01-01T10:00:00.000Z", kind: "customer_deposit", direction: "out", amount: 1000, status: "in_escrow" }),
    ]);
    const st = buildAccountStatement({ user: { ...user, role: "customer" }, roles: { customer, performer: null } });
    assert.equal(st.orders[0].inProcess, 1000);
    assert.equal(st.orders[0].net, 0);
    assert.equal(st.totals.customerInEscrow, 1000);
  });
});
