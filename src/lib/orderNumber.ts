import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

type Tx = Prisma.TransactionClient;

function pad(value: number | string, width: number) {
  return String(value).padStart(width, "0");
}

export async function nextOrderNumber(tx: Tx, serviceCategoryId: string, at: Date): Promise<string> {
  const serviceCode = pad(serviceCategoryId, 2);
  const yy = at.getUTCFullYear() % 100;
  const rows = await tx.$queryRaw<{ last_seq: number }[]>`
    INSERT INTO "order_number_counters" ("service_code", "yy", "last_seq")
    VALUES (${serviceCode}, ${yy}, 1)
    ON CONFLICT ("service_code", "yy")
    DO UPDATE SET "last_seq" = "order_number_counters"."last_seq" + 1
    RETURNING "last_seq"
  `;
  return `${serviceCode}${pad(yy, 2)}${pad(Number(rows[0].last_seq), 5)}`;
}

export function formatOrderNumber(code: string | null | undefined): string | null {
  if (!code || !/^\d{9}$/.test(code)) return null;
  return `№ ${code.slice(0, 2)}-${code.slice(2, 4)}-${code.slice(4)}`;
}

export async function orderRef(orderId: string): Promise<string> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
  return formatOrderNumber(order?.orderNumber) ?? "№ —";
}
