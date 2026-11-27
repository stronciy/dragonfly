import { escapeHtml } from "@/lib/telegram/client";
import type { AdminEvent, OrderStatusPayload } from "./events";

const MAX_TEXT_LENGTH = 300;

function money(amount: number, currency: string): string {
  const rounded = Math.round(Number.isFinite(amount) ? amount : 0);
  const sign = rounded < 0 ? "-" : "";
  const formatted = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${formatted} ${currency === "UAH" ? "₴" : escapeHtml(currency)}`;
}

function orderLabel(orderNumber: string | null, orderId: string): string {
  return escapeHtml(orderNumber ? `№${orderNumber}` : `#${orderId.slice(-6)}`);
}

function link(panelUrl: string | undefined, path: string, label: string): string | null {
  if (!panelUrl) return null;
  return `<a href="${escapeHtml(panelUrl.replace(/\/$/, "") + path)}">${label}</a>`;
}

function orderLines(data: OrderStatusPayload): string[] {
  return [
    `Замовлення: <b>${orderLabel(data.orderNumber, data.orderId)}</b>`,
    `Локація: ${escapeHtml(data.locationLabel)}`,
    `Бюджет: ${money(data.budget, data.currency)}`,
  ];
}

const ORDER_TITLES: Record<string, string> = {
  "order.accepted": "✅ Замовлення прийнято Виконавцем",
  "order.confirmed": "🤝 Замовлення підтверджено",
  "order.started": "🚜 Роботи розпочато",
  "order.completed": "🏁 Замовлення завершено",
  "order.cancelled": "⛔ Замовлення скасовано",
  "order.arbitration": "⚖️ Замовлення передано в арбітраж",
};

/**
 * Текст сповіщення для Telegram (HTML). Повертає null для типів, яких немає в каталозі.
 * `panelUrl` — базова адреса адмін-панелі (ADMIN_PANEL_URL); посилання додаються, якщо вона задана.
 */
export function formatAdminEvent(event: AdminEvent, panelUrl?: string): string {
  const lines = formatBody(event, panelUrl);
  return lines.filter((line): line is string => line !== null).join("\n");
}

function formatBody(event: AdminEvent, panelUrl?: string): Array<string | null> {
  switch (event.type) {
    case "user.registered": {
      const d = event.data;
      return [
        "👤 <b>Нова реєстрація</b>",
        `Ім'я: ${escapeHtml(d.name)}`,
        `Email: ${escapeHtml(d.email)}`,
        d.phone ? `Телефон: ${escapeHtml(d.phone)}` : null,
        `Роль: ${escapeHtml(d.role)}`,
        link(panelUrl, "/dashboard/users", "Відкрити користувачів"),
      ];
    }
    case "legal_profile.submitted": {
      const d = event.data;
      return [
        "🧾 <b>Юридичний профіль на верифікацію</b>",
        `Користувач: ${escapeHtml(d.name)} (${escapeHtml(d.email)})`,
        d.companyName ? `Компанія: ${escapeHtml(d.companyName)}` : null,
        d.edrpou ? `ЄДРПОУ: ${escapeHtml(d.edrpou)}` : null,
        link(panelUrl, "/dashboard/users", "Відкрити користувачів"),
      ];
    }
    case "order.created": {
      const d = event.data;
      return [
        "🆕 <b>Нове замовлення</b>",
        `Замовлення: <b>${orderLabel(d.orderNumber, d.orderId)}</b>`,
        `Замовник: ${escapeHtml(d.customerName)}`,
        `Локація: ${escapeHtml(d.locationLabel)}`,
        `Площа: ${d.areaHa} га`,
        `Бюджет: ${money(d.budget, d.currency)}`,
        link(panelUrl, "/dashboard/orders", "Відкрити замовлення"),
      ];
    }
    case "order.accepted":
    case "order.confirmed":
    case "order.started":
    case "order.completed":
    case "order.cancelled":
    case "order.arbitration":
      return [
        ORDER_TITLES[event.type],
        ...orderLines(event.data),
        link(panelUrl, "/dashboard/orders", "Відкрити замовлення"),
      ];
    case "payment.paid": {
      const d = event.data;
      const who = d.role === "performer" ? "Виконавець" : "Замовник";
      const stage = d.part === 2 ? "залишок" : "застава";
      return [
        "💳 <b>Оплата отримана</b>",
        `Замовлення: <b>${orderLabel(d.orderNumber, d.orderId)}</b>`,
        `Платить: ${who}, ${stage}`,
        `Сума: ${money(d.amount, d.currency)}`,
        `Провайдер: ${escapeHtml(d.provider)}`,
        link(panelUrl, "/dashboard/orders", "Відкрити замовлення"),
      ];
    }
    case "payout.requested": {
      const d = event.data;
      return [
        "💸 <b>Запит на виведення коштів</b>",
        `Виконавець: ${escapeHtml(d.userName)} (${escapeHtml(d.email)})`,
        `Сума: <b>${money(d.amount, d.currency)}</b>`,
        `IBAN: ****${escapeHtml(d.ibanTail)}`,
        link(panelUrl, "/dashboard/finance", "Відкрити фінанси"),
      ];
    }
    case "arbitration.opened": {
      const d = event.data;
      return [
        "⚖️ <b>Відкрито арбітраж</b>",
        `Замовлення: <b>${orderLabel(d.orderNumber, d.orderId)}</b>`,
        `Ініціатор: ${escapeHtml(d.openedByName)}`,
        link(panelUrl, `/dashboard/arbitration/${d.caseId}`, "Відкрити арбітраж"),
      ];
    }
    case "arbitration.party_message": {
      const d = event.data;
      const text = d.text.length > MAX_TEXT_LENGTH ? `${d.text.slice(0, MAX_TEXT_LENGTH)}…` : d.text;
      return [
        "💬 <b>Повідомлення в арбітражі</b>",
        `Замовлення: <b>${d.orderNumber ? escapeHtml(`№${d.orderNumber}`) : "—"}</b>`,
        `Від: ${escapeHtml(d.authorName)} (${escapeHtml(d.channel === "common" ? "загальний чат" : "приватна гілка")})`,
        text ? `«${escapeHtml(text)}»` : null,
        d.hasAttachments ? "📎 Є вкладення" : null,
        link(panelUrl, `/dashboard/arbitration/${d.caseId}`, "Відкрити арбітраж"),
      ];
    }
  }
}
