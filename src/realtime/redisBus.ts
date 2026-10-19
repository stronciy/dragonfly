import Redis from "ioredis";

const CHANNEL = "domain-events-v1";

let publisher: Redis | null = null;

function getPublisher() {
  if (publisher) return publisher;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  // Realtime — побочный канал. Без commandTimeout/ограничения ретраев ioredis
  // копит команды в offline-очереди и ждёт переподключения бесконечно: HTTP-запрос,
  // который ждёт publish (смена статуса, депозит), висит вместе с Redis.
  publisher = new Redis(url, {
    enableReadyCheck: true,
    maxRetriesPerRequest: 2,
    commandTimeout: 2_000,
  });
  return publisher;
}

export async function publishRaw(message: string) {
  const pub = getPublisher();
  if (!pub) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[realtime] REDIS_URL is not set; realtime events are disabled");
    }
    return;
  }
  try {
    await pub.publish(CHANNEL, message);
  } catch (err) {
    // Недоступный Redis не должен ронять бизнес-действие: запись в БД уже
    // зафиксирована, а realtime-событие — best effort.
    process.stdout.write(
      JSON.stringify({
        level: "warn",
        msg: "realtime_publish_failed",
        error: err instanceof Error ? err.message : String(err),
      }) + "\n"
    );
  }
}

export function getDomainEventsChannel() {
  return CHANNEL;
}

