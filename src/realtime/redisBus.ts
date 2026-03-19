import Redis from "ioredis";

const CHANNEL = "domain-events-v1";

let publisher: Redis | null = null;

function getPublisher() {
  if (publisher) return publisher;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  publisher = new Redis(url, { enableReadyCheck: true, maxRetriesPerRequest: null });
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
  await pub.publish(CHANNEL, message);
}

export function getDomainEventsChannel() {
  return CHANNEL;
}

