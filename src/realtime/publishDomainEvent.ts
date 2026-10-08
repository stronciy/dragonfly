import { publishRaw } from "./redisBus";
import type { DomainEvent, DomainEventType } from "./domainEvents";

export async function publishDomainEvent<T extends DomainEventType, D>(
  event: Omit<DomainEvent<T, D>, "eventId" | "version" | "timestamp"> & {
    requestId?: string;
  }
) {
  const payload: DomainEvent<T, D> = {
    eventId: crypto.randomUUID(),
    type: event.type,
    version: "1.0",
    timestamp: new Date().toISOString(),
    requestId: event.requestId,
    targets: event.targets,
    data: event.data,
  };

  // Логування для відладки WebSocket повідомлень (завжди)
  console.log(
    "\n📡 [WebSocket] ВІДПРАВКА ПОДІЇ:",
    `\n   🆔 Type: ${payload.type}`,
    `\n   🔑 EventId: ${payload.eventId}`,
    `\n   ⏰ Timestamp: ${payload.timestamp}`,
    `\n   👥 Targets: ${JSON.stringify(payload.targets)}`,
    `\n   📦 Data: ${JSON.stringify(payload.data)}`,
    `\n   🏷️ RequestId: ${payload.requestId || "N/A"}\n`
  );

  await publishRaw(JSON.stringify(payload));
}

