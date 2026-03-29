"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishDomainEvent = publishDomainEvent;
const redisBus_1 = require("./redisBus");
async function publishDomainEvent(event) {
    const payload = {
        eventId: crypto.randomUUID(),
        type: event.type,
        version: "1.0",
        timestamp: new Date().toISOString(),
        requestId: event.requestId,
        targets: event.targets,
        data: event.data,
    };
    // Логування для відладки WebSocket повідомлень (завжди)
    console.log("\n📡 [WebSocket] ВІДПРАВКА ПОДІЇ:", `\n   🆔 Type: ${payload.type}`, `\n   🔑 EventId: ${payload.eventId}`, `\n   ⏰ Timestamp: ${payload.timestamp}`, `\n   👥 Targets: ${JSON.stringify(payload.targets)}`, `\n   📦 Data: ${JSON.stringify(payload.data)}`, `\n   🏷️ RequestId: ${payload.requestId || "N/A"}\n`);
    await (0, redisBus_1.publishRaw)(JSON.stringify(payload));
}
