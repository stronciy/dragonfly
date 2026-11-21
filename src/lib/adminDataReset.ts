/**
 * Full business-data reset for the admin panel.
 *
 * The reset is deliberately table-driven instead of model-by-model: new
 * business tables must be wiped even before someone remembers to add them to
 * this file. Only infrastructure/reference data survives:
 *  - `_prisma_migrations` — schema version must stay intact;
 *  - `admins` — otherwise the panel locks itself out;
 *  - service catalog + crops — required for a usable fresh flow.
 */
export const RESET_CONFIRMATION_ALL = "RESET ALL DATA";
export const RESET_CONFIRMATION_EXCEPT_USERS = "RESET EXCEPT USERS";

export const RESET_PRESERVED_TABLES = [
  "_prisma_migrations",
  "admins",
  "crops",
  "service_categories",
  "service_subcategories",
  "service_types",
] as const;

export const RESET_EXCEPT_USERS_PRESERVED_TABLES = [
  ...RESET_PRESERVED_TABLES,
  "users",
  "refresh_tokens",
  "password_reset_tokens",
  "customer_profiles",
  "performer_profiles",
  "performer_services",
  "legal_profiles",
  "fields",
  "devices",
  "wallets",
  "admin_telegram_links",
  "admin_telegram_link_codes",
  "admin_notification_settings",
  "admin_event_cursors",
  "admin_password_reset_tokens",
  "admin_audit_logs",
  "client_diagnostic_reports",
] as const;

export type ResetScope = "all" | "except_users";

export function selectResetTables(
  allTables: readonly string[],
  scope: ResetScope = "all"
): string[] {
  const preserved = new Set<string>(
    scope === "except_users"
      ? RESET_EXCEPT_USERS_PRESERVED_TABLES
      : RESET_PRESERVED_TABLES
  );
  return [...new Set(allTables)]
    .filter((table) => table.length > 0 && !table.includes("\0") && !preserved.has(table))
    .sort();
}

export function quotePgIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function buildResetTruncateSql(tables: readonly string[]): string {
  if (tables.length === 0) {
    throw new Error("No tables selected for reset");
  }
  return `TRUNCATE TABLE ${[...new Set(tables)]
    .sort()
    .map(quotePgIdentifier)
    .join(", ")} RESTART IDENTITY CASCADE`;
}
