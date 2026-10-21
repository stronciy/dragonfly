import test from "node:test";
import assert from "node:assert/strict";
import {
  hashAdminPassword,
  verifyAdminPassword,
} from "../../src/lib/adminPassword";

test("admin password hash uses the panel's salt:hash format", async () => {
  const hash = await hashAdminPassword("Test1234");
  const [salt, digest] = hash.split(":");
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.match(digest, /^[0-9a-f]{128}$/);
});

test("admin password hash verifies only the original password", async () => {
  const hash = await hashAdminPassword("NewPass123");
  assert.equal(await verifyAdminPassword("NewPass123", hash), true);
  assert.equal(await verifyAdminPassword("newpass123", hash), false);
  assert.equal(await verifyAdminPassword("Wrong123", hash), false);
});

test("admin password hashes are salted per call", async () => {
  const first = await hashAdminPassword("SamePass123");
  const second = await hashAdminPassword("SamePass123");
  assert.notEqual(first, second);
  assert.equal(await verifyAdminPassword("SamePass123", first), true);
  assert.equal(await verifyAdminPassword("SamePass123", second), true);
});

test("malformed stored hashes are rejected", async () => {
  assert.equal(await verifyAdminPassword("Test1234", ""), false);
  assert.equal(await verifyAdminPassword("Test1234", "nocolon"), false);
});
