// Локалізація повідомлень API за мовою застосунку. Клієнт передає
// Accept-Language; якщо це англійська, відомі повідомлення замінюються
// перекладом. Без заголовка або з українською — відповідь без змін.
import { EN_SERVER_MESSAGES } from "./serverMessages.en";

export type ServerLocale = "uk" | "en";

export function resolveServerLocale(req: Request): ServerLocale {
  const primary = (req.headers.get("accept-language") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return primary.startsWith("en") ? "en" : "uk";
}

export function localizeServerMessage(message: string, locale: ServerLocale): string {
  if (locale === "uk") return message;
  return EN_SERVER_MESSAGES[message] ?? message;
}
