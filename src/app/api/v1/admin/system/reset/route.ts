import { z } from "zod";
import { ApiError, prisma } from "@/shared";
import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { clearQueues } from "@/shared";
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

    // Collect table names and counts before the destructive transaction. These
    // are read-only queries and can be slow on a seeded database; keeping them
    // in an interactive transaction used to hit Prisma's default 5s timeout
    // before the audit row was written.
    const tableRows = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
    `;
    const tables = selectResetTables(tableRows.map((row) => row.tablename));
    if (tables.length === 0) {
      throw new ApiError(500, "INTERNAL_ERROR", "Не знайдено таблиць для скидання");
    }

    const [
      users,
      orders,
      orderMatches,
      paymentIntents,
      escrowLocks,
      notifications,
      devices,
      reviews,
      auditLogs,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.order.count(),
      prisma.orderMatch.count(),
      prisma.paymentIntent.count(),
      prisma.escrowLock.count(),
      prisma.notification.count(),
      prisma.device.count(),
      prisma.review.count(),
      prisma.adminAuditLog.count(),
    ]);
    const deleted = {
      users,
      orders,
      orderMatches,
      paymentIntents,
      escrowLocks,
      notifications,
      devices,
      reviews,
      auditLogs,
    };

    const startedAt = Date.now();

    // Remove queued jobs before touching the DB. A stale `order-*` or
    // `performer-*` job keeps its deterministic id in the failed set and would
    // silently block every future rematch after the reset.
    const queuesBefore = await clearQueues().catch((err) => ({
      ok: false,
      cleared: [],
      errors: [{ name: "all", error: err instanceof Error ? err.message : String(err) }],
    }));

    const result = await prisma.$transaction(
      async (tx) => {
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
            queuesBeforeCleared: queuesBefore.cleared,
            queueErrors: queuesBefore.errors,
          },
        });

        return {
          resetAt,
          deleted,
          truncatedTables: tables.length,
          preservedTables: [...RESET_PRESERVED_TABLES],
        };
      },
      // TRUNCATE ... CASCADE can wait for locks; the default 5s is too short
      // for a reset that must also write its audit row atomically.
      { maxWait: 10_000, timeout: 45_000 }
    );

    // A request that was in flight while TRUNCATE ran could have enqueued a
    // job after the first drain. Clear once more so the fresh flow starts with
    // an empty queue. This is best-effort: the DB reset has already committed
    // and must not be reported as failed because Redis hiccuped.
    const queuesAfter = await clearQueues().catch((err) => ({
      ok: false,
      cleared: [],
      errors: [{ name: "all", error: err instanceof Error ? err.message : String(err) }],
    }));

    console.info(
      "[admin-reset] system reset completed",
      JSON.stringify({
        durationMs: Date.now() - startedAt,
        truncatedTables: tables.length,
        deleted,
        queuesBefore: queuesBefore.cleared,
        queuesAfter: queuesAfter.cleared,
        queueErrors: [...queuesBefore.errors, ...queuesAfter.errors],
      })
    );

    return ok(
      req,
      {
        ...result,
        queues: {
          ok: queuesBefore.ok && queuesAfter.ok,
          before: queuesBefore.cleared,
          after: queuesAfter.cleared,
          errors: [...queuesBefore.errors, ...queuesAfter.errors],
        },
      },
      {
        message: "Усі бізнес-дані скинуто. Можна починати тестовий флоу з нуля.",
      }
    );
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
