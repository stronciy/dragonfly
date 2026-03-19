export function validateEdrpou(value: string) {
  return /^\d{8,10}$/.test(value);
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

