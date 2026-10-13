import type { Prisma } from "@prisma/client";
import { ESCROW_OPEN_STATUSES } from "./deposit.service";

export type BillingRole = "performer" | "customer";

/**
 * SUM(EscrowLock.amount) по відкритих статусах escrow, суворо обмежено
 * (userId, role) — чужі замороження не враховуються.
 */
export async function reservedEscrowTotal(
  client: Prisma.TransactionClient,
  args: { userId: string; role: BillingRole }
): Promise<number> {
  const agg = await client.escrowLock.aggregate({
    where: {
      userId: args.userId,
      role: args.role,
      status: { in: [...ESCROW_OPEN_STATUSES] },
    },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}
