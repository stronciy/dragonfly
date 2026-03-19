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
