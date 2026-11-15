export const ADMIN_EVENT_GROUPS = {
  users: "Користувачі",
  orders: "Замовлення",
  payments: "Оплати",
  finance: "Фінанси",
  arbitration: "Арбітраж",
} as const;

export type AdminEventGroup = keyof typeof ADMIN_EVENT_GROUPS;

export type AdminEventDefinition = {
  type: string;
  group: AdminEventGroup;
  label: string;
  /** Значення, якщо адмін ще не змінював вибірку. Початково увімкнено все. */
  defaultEnabled: boolean;
};

/**
 * Порядок важливий: індекс є коротким ідентифікатором кнопки в боті
 * (callback_data обмежено 64 байтами). Нові типи додавати в кінець.
 */
export const ADMIN_EVENT_DEFINITIONS: readonly AdminEventDefinition[] = [
  { type: "user.registered", group: "users", label: "Нова реєстрація", defaultEnabled: true },
  { type: "legal_profile.submitted", group: "users", label: "Юр. профіль на верифікацію", defaultEnabled: true },
  { type: "order.created", group: "orders", label: "Нове замовлення", defaultEnabled: true },
  { type: "order.accepted", group: "orders", label: "Замовлення прийнято", defaultEnabled: true },
  { type: "order.confirmed", group: "orders", label: "Замовлення підтверджено", defaultEnabled: true },
  { type: "order.started", group: "orders", label: "Роботи розпочато", defaultEnabled: true },
  { type: "order.completed", group: "orders", label: "Замовлення завершено", defaultEnabled: true },
  { type: "order.cancelled", group: "orders", label: "Замовлення скасовано", defaultEnabled: true },
  { type: "order.arbitration", group: "orders", label: "Замовлення передано в арбітраж", defaultEnabled: true },
  { type: "payment.paid", group: "payments", label: "Оплата (застава / залишок)", defaultEnabled: true },
  { type: "payout.requested", group: "finance", label: "Запит на виведення коштів", defaultEnabled: true },
  { type: "arbitration.opened", group: "arbitration", label: "Відкрито арбітраж", defaultEnabled: true },
  { type: "arbitration.party_message", group: "arbitration", label: "Повідомлення сторони в арбітражі", defaultEnabled: true },
];

const BY_TYPE = new Map(ADMIN_EVENT_DEFINITIONS.map((d) => [d.type, d]));

export function findEventDefinition(type: string): AdminEventDefinition | undefined {
  return BY_TYPE.get(type);
}

export function isKnownEventType(type: string): boolean {
  return BY_TYPE.has(type);
}

/** Ефективне значення з урахуванням рядка вибірки адміна (якщо він є). */
export function isEventEnabled(type: string, override: boolean | undefined): boolean {
  if (override !== undefined) return override;
  return findEventDefinition(type)?.defaultEnabled ?? false;
}
