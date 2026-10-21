import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as unknown as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

/**
 * Admin-panel password hashing.
 *
 * The panel uses the same scrypt format (`salt:hash`, 16-byte salt, 64-byte
 * key) in `admin/src/lib/auth.ts`. Keeping the algorithms identical is what
 * lets a password reset performed by the backend be accepted by the panel.
 */
export async function hashAdminPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyAdminPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
