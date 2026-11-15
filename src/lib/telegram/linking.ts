import { createHash, randomInt } from "node:crypto";
import { prisma } from "@/shared";

export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export function generateLinkCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/** Новий код замінює попередні невикористані коди цього адміна. */
export async function createLinkCode(adminId: string, now: Date = new Date()) {
  const code = generateLinkCode();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
  await prisma.$transaction([
    prisma.adminTelegramLinkCode.deleteMany({ where: { adminId, usedAt: null } }),
    prisma.adminTelegramLinkCode.create({
      data: { adminId, codeHash: hashLinkCode(code), expiresAt },
    }),
  ]);
  return { code, expiresAt };
}

/**
 * Прив'язує чат до адміна за кодом. Повертає адміна або null, якщо код невірний,
 * прострочений або вже використаний. Чат, прив'язаний раніше до іншого адміна, відв'язується.
 */
export async function consumeLinkCode(
  code: string,
  chat: { chatId: string; username: string | null },
  now: Date = new Date()
): Promise<{ adminId: string; email: string } | null> {
  const record = await prisma.adminTelegramLinkCode.findUnique({
    where: { codeHash: hashLinkCode(code) },
    include: { admin: { select: { id: true, email: true, active: true } } },
  });
  if (!record || record.usedAt || record.expiresAt <= now || !record.admin.active) return null;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.adminTelegramLinkCode.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw new Error("LINK_CODE_ALREADY_USED");
    await tx.adminTelegramLink.deleteMany({ where: { chatId: chat.chatId, NOT: { adminId: record.adminId } } });
    await tx.adminTelegramLink.upsert({
      where: { adminId: record.adminId },
      create: { adminId: record.adminId, chatId: chat.chatId, username: chat.username },
      update: { chatId: chat.chatId, username: chat.username, linkedAt: now },
    });
  });

  return { adminId: record.admin.id, email: record.admin.email };
}
