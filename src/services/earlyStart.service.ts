import { prisma } from "../lib/prisma";

export type EarlyStartStatus = "pending" | "approved" | "rejected" | "withdrawn";

export async function getLatestEarlyStartRequest(orderId: string) {
  return prisma.earlyStartRequest.findFirst({
    where: { orderId },
    orderBy: { createdAt: "desc" },
  });
}

export function serializeEarlyStartRequest(r: {
  id: string;
  orderId: string;
  requestedById: string;
  status: string;
  reason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}) {
  return {
    id: r.id,
    orderId: r.orderId,
    requestedById: r.requestedById,
    status: r.status,
    reason: r.reason,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  };
}
