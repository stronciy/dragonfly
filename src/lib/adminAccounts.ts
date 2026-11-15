import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ApiError, prisma } from "@/shared";
import type { PanelAdmin } from "@/lib/adminAuth";
import { isAdminRole, type AdminRole } from "@/lib/adminPermissions";

export const ADMIN_ACCOUNT_SELECT = {
  id: true,
  email: true,
  role: true,
  active: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

/** Тимчасовий пароль, який адмін бачить один раз і має змінити при першому вході. */
export function generateTemporaryPassword(): string {
  return randomBytes(9).toString("base64url");
}

export function assertRole(value: unknown): AdminRole {
  if (typeof value !== "string" || !isAdminRole(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Невідома роль");
  }
  return value;
}

/** Не даємо залишити панель без активного суперадміна. */
export async function assertNotLastActiveSuperadmin(tx: Prisma.TransactionClient, adminId: string) {
  const others = await tx.admin.count({
    where: { role: "superadmin", active: true, NOT: { id: adminId } },
  });
  if (others === 0) {
    throw new ApiError(409, "CONFLICT", "Має лишитися принаймні один активний суперадмін");
  }
}

export function assertNotSelf(actor: PanelAdmin, targetId: string) {
  if (actor.id === targetId) {
    throw new ApiError(400, "VALIDATION_ERROR", "Не можна змінити або вимкнути власний доступ");
  }
}
