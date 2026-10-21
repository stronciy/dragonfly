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
export const RESET_PRESERVED_TABLES = [
  "_prisma_migrations",
  "admins",
  "crops",
  "service_categories",
  "service_subcategories",
  "service_types",
] as const;

const PRESERVED = new Set<string>(RESET_PRESERVED_TABLES);

export function selectResetTables(allTables: readonly string[]): string[] {
  return [...new Set(allTables)]
    .filter((table) => table.length > 0 && !table.includes("\0") && !PRESERVED.has(table))
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
