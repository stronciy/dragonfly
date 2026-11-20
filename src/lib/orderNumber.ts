import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

type Tx = Prisma.TransactionClient;

function pad(value: number | string, width: number) {
  return String(value).padStart(width, "0");
}

export async function nextOrderNumber(tx: Tx, _serviceCategoryId?: string, _at?: Date): Promise<string> {
  const rows = await tx.$queryRaw<{ last_seq: number }[]>`
    INSERT INTO "order_number_counters" ("service_code", "yy", "last_seq")
    VALUES ('DF', 0, 1001)
    ON CONFLICT ("service_code", "yy")
    DO UPDATE SET "last_seq" = "order_number_counters"."last_seq" + 1
    RETURNING "last_seq"
  `;
  const seq = Number(rows[0].last_seq);
  return `DF-${pad(seq, 5)}`;
}

export function formatOrderNumber(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = String(code).trim();
  if (!trimmed) return null;
  if (/^DF-\d+$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^\d{9}$/.test(trimmed)) {
    return `№ ${trimmed.slice(0, 2)}-${trimmed.slice(2, 4)}-${trimmed.slice(4)}`;
  }
  if (/^\d{5}$/.test(trimmed)) {
    return `DF-${trimmed}`;
  }
  if (/^\d+$/.test(trimmed)) {
    return `№ ${trimmed}`;
  }
  return trimmed;
}

export async function orderRef(orderId: string): Promise<string> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
  return formatOrderNumber(order?.orderNumber) ?? "№ —";
}
