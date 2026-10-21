import { z } from "zod";
import { ApiError, prisma } from "@/shared";
import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import {
  RESET_PRESERVED_TABLES,
  buildResetTruncateSql,
  selectResetTables,
} from "@/lib/adminDataReset";

export const runtime = "nodejs";
export const maxDuration = 60;

const RESET_CONFIRMATION = "RESET ALL DATA";

const schema = z.object({
  confirm: z.string(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * OPS: full reset of business data from the admin panel.
 *
 * This is intentionally a destructive, non-reversible operation. It wipes every
 * public table except migrations, admin credentials, and the reference catalog
 * needed to bootstrap a fresh flow. The reset itself is written to the audit
 * log after all old audit rows have been removed, so there is always evidence
 * that the database was reset.
 */
export async function POST(req: Request) {
  try {
    const admin = await requirePanelAdmin(req);
    const body = schema.parse(await req.json().catch(() => null));
    if (body.confirm.trim() !== RESET_CONFIRMATION) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `Для підтвердження введіть «${RESET_CONFIRMATION}»`
      );
    }

    const reason = body.reason || "Повний скид даних через адмін-панель";

    const result = await prisma.$transaction(async (tx) => {
      const tableRows = await tx.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename
        FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
      `;
      const tables = selectResetTables(tableRows.map((row) => row.tablename));
      if (tables.length === 0) {
        throw new ApiError(500, "INTERNAL_ERROR", "Не знайдено таблиць для скидання");
      }

      const deleted = {
        users: await tx.user.count(),
        orders: await tx.order.count(),
        orderMatches: await tx.orderMatch.count(),
        paymentIntents: await tx.paymentIntent.count(),
        escrowLocks: await tx.escrowLock.count(),
        notifications: await tx.notification.count(),
        devices: await tx.device.count(),
        reviews: await tx.review.count(),
        auditLogs: await tx.adminAuditLog.count(),
      };

      await tx.$executeRawUnsafe(buildResetTruncateSql(tables));

      const resetAt = new Date().toISOString();
      await writeAuditLog(tx, req, {
        admin,
        action: "system.reset",
        entityType: "database",
        entityId: "all-business-data",
        reason,
        before: deleted,
        after: {
          resetAt,
          truncatedTables: tables.length,
          preservedTables: [...RESET_PRESERVED_TABLES],
        },
      });

      return {
        resetAt,
        deleted,
        truncatedTables: tables.length,
        preservedTables: [...RESET_PRESERVED_TABLES],
      };
    });

    return ok(req, result, {
      message: "Усі бізнес-дані скинуто. Можна починати тестовий флоу з нуля.",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(
        req,
        new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten())
      );
    }
    return fail(req, err);
  }
}
