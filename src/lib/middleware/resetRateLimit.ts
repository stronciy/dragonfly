import Redis from "ioredis";

const RESET_LIMIT_PREFIX = "ratelimit:password-reset:";
const ADMIN_RESET_LIMIT_PREFIX = "ratelimit:admin-password-reset:";
const WINDOW_SECONDS = 15 * 60;

// IP-ліміт — єдиний захист для користувацького відновлення пароля.
// Мобільні оператори й корпоративні мережі ділять одну IP між багатьма
// клієнтами (CGNAT), тому попередні 5 запитів / 15 хв блокували реальних
// людей. 20 — запас, який не дає кільком користувачам за однією IP
// вичерпати квоту, але не заважає нормальним користувачам.
const MAX_PER_IP = 20;

// Email-ліміт для користувацького скидання ПРИБРАНО. Він блокував реальних
// людей, які кілька разів повторили запит через повільний SMTP (див. лог
// "[password-reset] rate limited; no email sent"). Захист від спам-бомб і
// перебору кодів тримається на трьох рівнях: (1) IP-ліміт вище,
// (2) код чинний лише 15 хв, (3) у БД живе тільки ОДИН активний токен на
// користувача — новий запит інвалідує попередній, тож перебрати 6-значний
// код через повторні запити не виходить.
// Адмін-панель нижче зберігає обидві корзини: там перебір кодів критичніший,
// а обсяг запитів малий.
const MAX_PER_ADMIN_EMAIL = 3;

let redisClient: Redis | null = null;
let redisInitAttempted = false;

function getRedisClient(): Redis | null {
  if (redisInitAttempted) return redisClient;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    redisInitAttempted = true;
    return null;
  }

  try {
    redisClient = new Redis(redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null,
    });

    redisClient.on("error", () => {
      redisClient = null;
    });

    redisInitAttempted = true;
    return redisClient;
  } catch {
    redisInitAttempted = true;
    return null;
  }
}

export function getClientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (ips.length > 0) return ips[ips.length - 1];
  }
  return "unknown";
}

async function consume(key: string, limit: number): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return true;

  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
    return count <= limit;
  } catch {
    return true;
  }
}

async function checkResetRateLimit(prefix: string, ip: string, email: string): Promise<boolean> {
  const ipAllowed = await consume(`${prefix}ip:${ip}`, MAX_PER_IP);
  const emailAllowed = await consume(
    `${prefix}email:${email.trim().toLowerCase()}`,
    MAX_PER_ADMIN_EMAIL
  );
  return ipAllowed && emailAllowed;
}

/**
 * Користувацьке відновлення пароля: лімітуємо ТІЛЬКИ по IP.
 * Email-ліміт прибрано, бо він блокував реальних людей під час повторних
 * спроб (повільний SMTP). Захист від перебору — один активний токен
 * на користувача + TTL 15 хв (див. коментар до MAX_PER_ADMIN_EMAIL).
 */
export async function checkPasswordResetRateLimit(ip: string): Promise<boolean> {
  return consume(`${RESET_LIMIT_PREFIX}ip:${ip}`, MAX_PER_IP);
}

/** Адмін-скидання: обмеження по IP і по email (перебір кодів критичніший). */
export async function checkAdminPasswordResetRateLimit(ip: string, email: string): Promise<boolean> {
  return checkResetRateLimit(ADMIN_RESET_LIMIT_PREFIX, ip, email);
}
