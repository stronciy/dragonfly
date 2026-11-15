import { prisma } from "@/shared";
import type { AdminEvent } from "./events";

const BATCH_LIMIT = 500;

const ORDER_STATUS_EVENT_TYPES = {
  accepted: "order.accepted",
  confirmed: "order.confirmed",
  started: "order.started",
  completed: "order.completed",
  cancelled: "order.cancelled",
  arbitration: "order.arbitration",
} as const;

export type EventSource = {
  name: string;
  fetch: (since: Date) => Promise<AdminEvent[]>;
};

function ibanTail(iban: string): string {
  return iban.replace(/\s/g, "").slice(-4);
}

export const EVENT_SOURCES: readonly EventSource[] = [
  {
    name: "users.registered",
    fetch: async (since) => {
      const rows = await prisma.user.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        take: BATCH_LIMIT,
        select: { id: true, name: true, email: true, phone: true, role: true, createdAt: true },
      });
      return rows.map((u) => ({
        id: u.id,
        at: u.createdAt,
        type: "user.registered" as const,
        data: { userId: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role },
      }));
    },
  },
  {
    name: "legal-profiles.submitted",
    fetch: async (since) => {
      const rows = await prisma.legalProfile.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        take: BATCH_LIMIT,
        select: {
          id: true,
          userId: true,
          companyName: true,
          edrpou: true,
          createdAt: true,
          user: { select: { name: true, email: true } },
        },
      });
      return rows.map((p) => ({
        id: p.id,
        at: p.createdAt,
        type: "legal_profile.submitted" as const,
        data: {
          userId: p.userId,
          name: p.user.name,
          email: p.user.email,
          companyName: p.companyName,
          edrpou: p.edrpou,
        },
      }));
    },
  },
  {
    name: "orders.created",
    fetch: async (since) => {
      const rows = await prisma.order.findMany({
        where: { createdAt: { gte: since }, status: { not: "draft" } },
        orderBy: { createdAt: "asc" },
        take: BATCH_LIMIT,
        select: {
          id: true,
          orderNumber: true,
          locationLabel: true,
          budget: true,
          currency: true,
          areaHa: true,
          createdAt: true,
          customer: { select: { name: true } },
        },
      });
      return rows.map((o) => ({
        id: o.id,
        at: o.createdAt,
        type: "order.created" as const,
        data: {
          orderId: o.id,
          orderNumber: o.orderNumber,
          locationLabel: o.locationLabel,
          budget: Number(o.budget),
          currency: o.currency,
          areaHa: o.areaHa,
          customerName: o.customer.name,
        },
      }));
    },
  },
  {
    name: "orders.status",
    fetch: async (since) => {
      const rows = await prisma.orderStatusEvent.findMany({
        where: { createdAt: { gte: since }, status: { in: Object.keys(ORDER_STATUS_EVENT_TYPES) } },
        orderBy: { createdAt: "asc" },
        take: BATCH_LIMIT,
        select: {
          id: true,
          status: true,
          createdAt: true,
          order: {
            select: { id: true, orderNumber: true, locationLabel: true, budget: true, currency: true },
          },
        },
      });
      const events: AdminEvent[] = [];
      for (const row of rows) {
        const type = row.status ? ORDER_STATUS_EVENT_TYPES[row.status as keyof typeof ORDER_STATUS_EVENT_TYPES] : undefined;
        if (!type) continue;
        events.push({
          id: row.id,
          at: row.createdAt,
          type,
          data: {
            orderId: row.order.id,
            orderNumber: row.order.orderNumber,
            locationLabel: row.order.locationLabel,
            budget: Number(row.order.budget),
            currency: row.order.currency,
          },
        });
      }
      return events;
    },
  },
  {
    name: "payments.paid",
    fetch: async (since) => {
      const rows = await prisma.paymentIntent.findMany({
        where: { status: "paid", paidAt: { gte: since } },
        orderBy: { paidAt: "asc" },
        take: BATCH_LIMIT,
        select: {
          id: true,
          role: true,
          part: true,
          amount: true,
          currency: true,
          provider: true,
          paidAt: true,
          order: { select: { id: true, orderNumber: true } },
        },
      });
      return rows.flatMap((p) =>
        p.paidAt
          ? [
              {
                id: p.id,
                at: p.paidAt,
                type: "payment.paid" as const,
                data: {
                  orderId: p.order.id,
                  orderNumber: p.order.orderNumber,
                  role: p.role,
                  part: p.part,
                  amount: Number(p.amount),
                  currency: p.currency,
                  provider: p.provider,
                },
              },
            ]
          : []
      );
    },
  },
  {
    name: "payouts.requested",
    fetch: async (since) => {
      const rows = await prisma.payout.findMany({
        where: { requestedAt: { gte: since } },
        orderBy: { requestedAt: "asc" },
        take: BATCH_LIMIT,
        select: {
          id: true,
          amount: true,
          currency: true,
          iban: true,
          requestedAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
      });
      return rows.map((p) => ({
        id: p.id,
        at: p.requestedAt,
        type: "payout.requested" as const,
        data: {
          payoutId: p.id,
          userName: p.user.name,
          email: p.user.email,
          amount: Number(p.amount),
          currency: p.currency,
          ibanTail: ibanTail(p.iban),
        },
      }));
    },
  },
  {
    name: "arbitration.cases",
    fetch: async (since) => {
      const rows = await prisma.arbitrationCase.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        take: BATCH_LIMIT,
        select: {
          id: true,
          orderId: true,
          createdAt: true,
          order: { select: { orderNumber: true } },
          openedBy: { select: { name: true } },
        },
      });
      return rows.map((c) => ({
        id: c.id,
        at: c.createdAt,
        type: "arbitration.opened" as const,
        data: {
          caseId: c.id,
          orderId: c.orderId,
          orderNumber: c.order.orderNumber,
          openedByName: c.openedBy.name,
        },
      }));
    },
  },
  {
    name: "arbitration.messages",
    fetch: async (since) => {
      const rows = await prisma.arbitrationMessage.findMany({
        where: { createdAt: { gte: since }, userId: { not: null } },
        orderBy: { createdAt: "asc" },
        take: BATCH_LIMIT,
        select: {
          id: true,
          text: true,
          channel: true,
          createdAt: true,
          arbitrationCase: { select: { id: true, order: { select: { orderNumber: true } } } },
          user: { select: { name: true } },
          _count: { select: { media: true } },
        },
      });
      return rows.map((m) => ({
        id: m.id,
        at: m.createdAt,
        type: "arbitration.party_message" as const,
        data: {
          caseId: m.arbitrationCase.id,
          orderNumber: m.arbitrationCase.order.orderNumber,
          authorName: m.user?.name ?? "Учасник",
          channel: m.channel,
          text: m.text,
          hasAttachments: m._count.media > 0,
        },
      }));
    },
  },
];
