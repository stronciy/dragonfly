import type { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "./errors";

type Db = Prisma.TransactionClient | PrismaClient;

export const VAT_PAYER_REQUIRED_MESSAGE =
  "Для участі в роботах потрібно бути платником ПДВ. Увімкніть «Платник ПДВ» у юридичних даних.";

export async function assertVatPayer(db: Db, userId: string) {
  const profile = await db.legalProfile.findUnique({
    where: { userId },
    select: { vatPayer: true },
  });
  if (!profile?.vatPayer) {
    throw new ApiError(403, "FORBIDDEN", VAT_PAYER_REQUIRED_MESSAGE);
  }
}
