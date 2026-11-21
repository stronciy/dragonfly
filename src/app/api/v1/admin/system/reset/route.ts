import { z } from "zod";
import { ApiError, prisma } from "@/shared";
import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import { clearQueues } from "@/shared";
import {
  RESET_CONFIRMATION_ALL,
  RESET_CONFIRMATION_EXCEPT_USERS,
  RESET_PRESERVED_TABLES,
  RESET_EXCEPT_USERS_PRESERVED_TABLES,
  buildResetTruncateSql,
  selectResetTables,
} from "@/lib/adminDataReset";
import { createDatabaseBackup } from "@/lib/dbBackup";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  confirm: z.string(),
  scope: z.enum(["all", "except_users"]).default("all"),
  reason: z.string().trim().max(500).optional(),
});

/**
 * OPS: reset of business data from the admin panel.
 *
 * Supports two scopes:
 * - "all": Wipes every public table except migrations, admin credentials, and catalog.
 * - "except_users": Wipes orders, escrow, payments, chats, reviews, notifications,
 *   and resets wallet balances to 0, while keeping users, profiles, legal info,
 *   devices, and login sessions intact for seamless re-testing.
 */
export async function POST(req: Request) {
  try {
    const admin = await requirePanelAdmin(req, "system.manage");
    const body = schema.parse(await req.json().catch(() => null));
    const isExceptUsers = body.scope === "except_users";
    const expectedConfirm = isExceptUsers
      ? RESET_CONFIRMATION_EXCEPT_USERS
      : RESET_CONFIRMATION_ALL;

    if (body.confirm.trim() !== expectedConfirm) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `Для підтвердження введіть «${expectedConfirm}»`
      );
    }

    const reason =
      body.reason ||
      (isExceptUsers
        ? "Скидання замовлень та фінансових даних (крім користувачів) через адмін-панель"
        : "Повний скид даних через адмін-панель");

    // Dump the database before anything destructive happens. If pg_dump fails
    // the reset is aborted: a wipe without a fallback copy is not worth one
    // click. The dump is written inside the backend container.
    const backup = await createDatabaseBackup();

    // Collect table names and counts before the destructive transaction. These
    // are read-only queries and can be slow on a seeded database; keeping them
    // in an interactive transaction used to hit Prisma's default 5s timeout
    // before the audit row was written.
    const tableRows = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
    `;
    const tables = selectResetTables(tableRows.map((row) => row.tablename), body.scope);
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
    const deleted: Record<string, number> = {
      orders,
      orderMatches,
      paymentIntents,
      escrowLocks,
      notifications,
      reviews,
    };
    if (!isExceptUsers) {
      deleted.users = users;
      deleted.devices = devices;
      deleted.auditLogs = auditLogs;
    }

    const startedAt = Date.now();

    // Remove queued jobs before touching the DB. A stale `order-*` or
    // `performer-*` job keeps its deterministic id in the failed set and would
    // silently block every future rematch after the reset.
    const queuesBefore = await clearQueues().catch((err) => ({
      ok: false,
      cleared: [],
      errors: [{ name: "all", error: err instanceof Error ? err.message : String(err) }],
    }));

    const preservedList = isExceptUsers
      ? [...RESET_EXCEPT_USERS_PRESERVED_TABLES]
      : [...RESET_PRESERVED_TABLES];

    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(buildResetTruncateSql(tables));

        if (isExceptUsers) {
          await tx.$executeRawUnsafe('UPDATE "wallets" SET "balance" = 0, "hold_amount" = 0');
        }

        const resetAt = new Date().toISOString();
        await writeAuditLog(tx, req, {
          admin,
          action: isExceptUsers ? "system.reset_except_users" : "system.reset",
          entityType: "database",
          entityId: isExceptUsers ? "orders-finance-data" : "all-business-data",
          reason,
          before: deleted,
          after: {
            resetAt,
            scope: body.scope,
            truncatedTables: tables.length,
            preservedTables: preservedList,
            backup,
            queuesBeforeCleared: queuesBefore.cleared,
            queueErrors: queuesBefore.errors,
          },
        });

        return {
          resetAt,
          scope: body.scope,
          deleted,
          truncatedTables: tables.length,
          preservedTables: preservedList,
          backup,
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
        backup,
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
        message: isExceptUsers
          ? "Замовлення та фінансові дані скинуто. Користувачів збережено для тестування з чистого аркуша."
          : "Усі бізнес-дані скинуто. Можна починати тестовий флоу з нуля.",
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
