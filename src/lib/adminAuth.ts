import { timingSafeEqual } from "node:crypto";
import { ApiError, prisma } from "@/shared";

/**
 * Аутентификация админ-панели.
 *
 * Панель ходит в бэкенд server-to-server: браузер общается только с сервером
 * панели, поэтому секрет панели в клиент не попадает. Кроме секрета проверяем,
 * что администратор существует и активен — это защищает от отозванного доступа
 * даже при утёкшем секрете.
 */
export const ADMIN_KEY_HEADER = "x-admin-key";
export const ADMIN_ID_HEADER = "x-admin-id";

function panelSecret(): string {
  const secret = process.env.ADMIN_PANEL_SECRET;
  if (!secret) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "ADMIN_PANEL_SECRET не налаштовано", undefined, true);
  }
  return secret;
}

function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type PanelAdmin = { id: string; email: string; role: string };

export async function requirePanelAdmin(req: Request): Promise<PanelAdmin> {
  const provided = req.headers.get(ADMIN_KEY_HEADER);
  if (!provided || !secretsMatch(provided, panelSecret())) {
    throw new ApiError(401, "UNAUTHORIZED", "Недійсний ключ адмін-панелі");
  }

  const adminId = req.headers.get(ADMIN_ID_HEADER);
  if (!adminId) throw new ApiError(401, "UNAUTHORIZED", "Не вказано адміністратора");

  const admin = await prisma.admin.findUnique({
    where: { id: adminId },
    select: { id: true, email: true, role: true, active: true },
  });
  if (!admin || !admin.active) throw new ApiError(403, "FORBIDDEN", "Адміністратора вимкнено");

  return { id: admin.id, email: admin.email, role: admin.role };
}
