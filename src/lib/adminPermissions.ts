/**
 * Ролі адміністраторів панелі та їхні права. Дзеркальна копія — admin/src/lib/permissions.ts;
 * зміни треба переносити в обидва файли (тест перевіряє, що ролі та права співпадають).
 */
export const ADMIN_PERMISSIONS = [
  "users.read",
  "users.manage",
  "orders.read",
  "orders.manage",
  "arbitration.read",
  "arbitration.manage",
  "arbitration.decide",
  "finance.read",
  "finance.manage",
  "audit.read",
  "diagnostics.read",
  "system.read",
  "system.manage",
  "admins.manage",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export const ADMIN_ROLES = ["superadmin", "admin", "moderator"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const OPERATOR_PERMISSIONS: AdminPermission[] = ADMIN_PERMISSIONS.filter(
  (p) => p !== "admins.manage" && p !== "system.manage"
);

export const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  superadmin: ADMIN_PERMISSIONS,
  admin: OPERATOR_PERMISSIONS,
  moderator: [
    "users.read",
    "users.manage",
    "orders.read",
    "arbitration.read",
    "arbitration.manage",
    "arbitration.decide",
    "diagnostics.read",
  ],
};

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

/** Невідома роль у БД не дає жодних прав. */
export function hasPermission(role: string, permission: AdminPermission): boolean {
  if (!isAdminRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}
