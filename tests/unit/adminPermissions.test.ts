import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_PERMISSIONS, hasPermission, isAdminRole, ROLE_PERMISSIONS } from "../../src/lib/adminPermissions";

test("superadmin has every permission", () => {
  for (const permission of ADMIN_PERMISSIONS) {
    assert.equal(hasPermission("superadmin", permission), true, permission);
  }
});

test("admin manages operations but not admins or system reset", () => {
  assert.equal(hasPermission("admin", "finance.manage"), true);
  assert.equal(hasPermission("admin", "arbitration.decide"), true);
  assert.equal(hasPermission("admin", "system.read"), true);
  assert.equal(hasPermission("admin", "system.manage"), false);
  assert.equal(hasPermission("admin", "admins.manage"), false);
});

test("moderator can work with users, orders view and arbitration (chat and rulings) only", () => {
  assert.equal(hasPermission("moderator", "users.manage"), true);
  assert.equal(hasPermission("moderator", "arbitration.manage"), true);
  assert.equal(hasPermission("moderator", "diagnostics.read"), true);
  assert.equal(hasPermission("moderator", "orders.read"), true);
  assert.equal(hasPermission("moderator", "orders.manage"), false);
  assert.equal(hasPermission("moderator", "arbitration.decide"), true);
  assert.equal(hasPermission("moderator", "finance.read"), false);
  assert.equal(hasPermission("moderator", "finance.manage"), false);
  assert.equal(hasPermission("moderator", "audit.read"), false);
  assert.equal(hasPermission("moderator", "system.read"), false);
  assert.equal(hasPermission("moderator", "admins.manage"), false);
});

test("unknown or legacy role values grant nothing", () => {
  assert.equal(hasPermission("admin_legacy", "users.read"), false);
  assert.equal(hasPermission("", "users.read"), false);
  assert.equal(isAdminRole("moderator"), true);
  assert.equal(isAdminRole("owner"), false);
});

test("every role's permissions are drawn from the known list", () => {
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permission of permissions) {
      assert.ok((ADMIN_PERMISSIONS as readonly string[]).includes(permission), `${role}:${permission}`);
    }
  }
});
