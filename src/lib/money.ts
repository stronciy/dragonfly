// Сума для повідомлень користувачу: 3 000 000 з гривнею перед числом (₴ 3 000 000).
// Копійки не показуємо, роздільник тисяч — пробіл.
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatUahAmount(amount: number | string | { toString(): string }): string {
  const n = typeof amount === "number" ? amount : Number(amount.toString());
  const rounded = Math.round(Number.isFinite(n) ? n : 0);
  const sign = rounded < 0 ? "-" : "";
  return `₴ ${sign}${groupThousands(String(Math.abs(rounded)))}`;
}
