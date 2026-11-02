export function validateEdrpou(value: string) {
  return /^\d{8,10}$/.test(value);
}

export function normalizeEdrpou(value: string) {
  return value.replace(/\D+/g, "");
}

export function normalizeUAIban(value: string) {
  return value.replace(/\s+/g, "").toUpperCase();
}

export function validateUAIban(value: string) {
  const iban = normalizeUAIban(value);
  if (!/^UA\d{27}$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;

  for (const ch of rearranged) {
    const digits = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) {
      remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
  }

  return remainder === 1;
}

/**
 * Межі України (в градусах). Координати материкової частини та Криму.
 */
export const UKRAINE_BOUNDS = {
  north: 52.5,
  south: 44.2,
  west: 22.0,
  east: 40.5,
} as const;

/**
 * Перевіряє, чи знаходиться точка в межах України.
 */
export function isWithinUkraine(latitude: number, longitude: number): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return (
    latitude >= UKRAINE_BOUNDS.south &&
    latitude <= UKRAINE_BOUNDS.north &&
    longitude >= UKRAINE_BOUNDS.west &&
    longitude <= UKRAINE_BOUNDS.east
  );
}

