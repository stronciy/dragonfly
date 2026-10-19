import type { Prisma } from "@prisma/client";
import { getRequestId } from "@/lib/apiResponse";
import type { PanelAdmin } from "@/lib/adminAuth";

export type AuditEntry = {
  admin: PanelAdmin;
  /** `<entity>.<verb>`: user.block, user.update, user.revoke_sessions… */
  action: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
  /** Только затронутые поля, без секретов. */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

/**
 * AUD-1: одна запись журнала на мутирующий admin-запрос.
 *
 * Пишется в той же транзакции, что и само действие: если журнал не записался,
 * транзакция откатывается и действие не выполняется (правило из спеки, §7).
 */
export async function writeAuditLog(
  tx: Prisma.TransactionClient,
  req: Request,
  entry: AuditEntry
): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      adminId: entry.admin.id,
      adminEmail: entry.admin.email,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      reason: entry.reason ?? null,
      before: (entry.before ?? null) as Prisma.InputJsonValue,
      after: (entry.after ?? null) as Prisma.InputJsonValue,
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
      requestId: getRequestId(req),
    },
  });
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim().slice(0, 64) ?? null;
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

/** Общие «до/после» по затронутым полям — чтобы журнал читался без diff-а. */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      changedBefore[key] = before[key] ?? null;
      changedAfter[key] = after[key] ?? null;
    }
  }
  return { before: changedBefore, after: changedAfter };
}
