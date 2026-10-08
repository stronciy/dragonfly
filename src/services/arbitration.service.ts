import { prisma } from "../lib/prisma";

export type ArbitrationDecision = "close_plain" | "close_fine";
export type ArbitrationResolutionStatus = "pending" | "approved" | "rejected" | "withdrawn";

export async function getLatestArbitrationResolution(orderId: string) {
  return prisma.arbitrationResolution.findFirst({
    where: { orderId },
    orderBy: { createdAt: "desc" },
  });
}

export function serializeArbitrationResolution(r: {
  id: string;
  orderId: string;
  proposedById: string;
  decision: string;
  status: string;
  reason: string | null;
  rating: number | null;
  comment: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}) {
  return {
    id: r.id,
    orderId: r.orderId,
    proposedById: r.proposedById,
    decision: r.decision,
    status: r.status,
    reason: r.reason,
    rating: r.rating,
    comment: r.comment,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  };
}
