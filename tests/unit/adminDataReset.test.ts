import test from "node:test";
import assert from "node:assert/strict";
import {
  RESET_PRESERVED_TABLES,
  RESET_EXCEPT_USERS_PRESERVED_TABLES,
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

test("reset except users preserves users, profiles, devices and credentials", () => {
  assert.ok(RESET_EXCEPT_USERS_PRESERVED_TABLES.includes("users"));
  assert.ok(RESET_EXCEPT_USERS_PRESERVED_TABLES.includes("customer_profiles"));
  assert.ok(RESET_EXCEPT_USERS_PRESERVED_TABLES.includes("performer_profiles"));
  assert.ok(RESET_EXCEPT_USERS_PRESERVED_TABLES.includes("legal_profiles"));
  assert.ok(RESET_EXCEPT_USERS_PRESERVED_TABLES.includes("fields"));
  assert.ok(RESET_EXCEPT_USERS_PRESERVED_TABLES.includes("wallets"));
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

test("reset except users selects orders and finance but preserves users", () => {
  assert.deepEqual(
    selectResetTables(
      [
        "orders",
        "order_matches",
        "payment_intents",
        "users",
        "customer_profiles",
        "legal_profiles",
        "wallets",
        "admins",
      ],
      "except_users"
    ),
    ["order_matches", "orders", "payment_intents"]
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
