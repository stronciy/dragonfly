import test from "node:test";
import assert from "node:assert/strict";
import {
  RESET_PRESERVED_TABLES,
  buildResetTruncateSql,
  quotePgIdentifier,
  selectResetTables,
} from "../../src/lib/adminDataReset";

test("reset keeps migrations, admins and the bootstrap catalog", () => {
  assert.deepEqual([...RESET_PRESERVED_TABLES], [
    "_prisma_migrations",
    "admins",
    "crops",
    "service_categories",
    "service_subcategories",
    "service_types",
  ]);
});

test("reset selects every public business table and drops duplicates", () => {
  assert.deepEqual(
    selectResetTables([
      "orders",
      "users",
      "admins",
      "service_categories",
      "orders",
      "_prisma_migrations",
    ]),
    ["orders", "users"]
  );
});

test("reset SQL quotes identifiers and restarts identities", () => {
  assert.equal(quotePgIdentifier('order"items'), '"order""items"');
  assert.equal(
    buildResetTruncateSql(["users", "orders"]),
    'TRUNCATE TABLE "orders", "users" RESTART IDENTITY CASCADE'
  );
});

test("reset refuses an empty table set", () => {
  assert.throws(() => buildResetTruncateSql([]), /No tables selected/);
});
