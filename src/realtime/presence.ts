import Redis from "ioredis";

const KEY_PREFIX = "ws:online:";
const TTL_SECONDS = 60;

let redis: Redis | null = null;

function getRedis() {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  redis = new Redis(url, { enableReadyCheck: true, maxRetriesPerRequest: null });
  return redis;
}

export function getPresenceKey(userId: string) {
  return `${KEY_PREFIX}${userId}`;
}

export async function markUserOnline(userId: string) {
  const r = getRedis();
  if (!r) return;
  await r.set(getPresenceKey(userId), "1", "EX", TTL_SECONDS);
}

export async function markUserOffline(userId: string) {
  const r = getRedis();
  if (!r) return;
  await r.del(getPresenceKey(userId));
}

export async function isUserOnline(userId: string) {
  const r = getRedis();
  if (!r) return false;
  const exists = await r.exists(getPresenceKey(userId));
  return exists === 1;
}

export async function getOnlineUserIds(userIds: string[]) {
  const r = getRedis();
  if (!r) return new Set<string>();
  const pipeline = r.pipeline();
  for (const userId of userIds) pipeline.exists(getPresenceKey(userId));
  const results = await pipeline.exec();
  const online = new Set<string>();
  for (let i = 0; i < userIds.length; i++) {
    const [, value] = results?.[i] ?? [];
    if (value === 1) online.add(userIds[i]);
  }
  return online;
}

export async function countOnlineByRole(): Promise<{ customers: number; performers: number }> {
  const r = getRedis();
  if (!r) return { customers: 0, performers: 0 };
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await r.scan(cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", 200);
    cursor = next;
    if (batch.length) keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length === 0) return { customers: 0, performers: 0 };
  const values = await r.mget(...keys);
  let customers = 0;
  let performers = 0;
  for (const v of values) {
    if (v === "customer") customers += 1;
    else if (v === "performer") performers += 1;
  }
  return { customers, performers };
}
