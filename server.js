require("dotenv").config({ quiet: true });

const http = require("http");
const next = require("next");
const Redis = require("ioredis");
const { WebSocketServer } = require("ws");
const { jwtVerify } = require("jose");

const DOMAIN_EVENTS_CHANNEL = "domain-events-v1";
const PRESENCE_KEY_PREFIX = "ws:online:";
const PRESENCE_TTL_SECONDS = 60;

function getJwtSecret() {
  const value = process.env.JWT_ACCESS_SECRET;
  if (!value) throw new Error("JWT_ACCESS_SECRET is required");
  return new TextEncoder().encode(value);
}

function getRedisUrl() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  return url;
}

function getPresenceKey(userId) {
  return `${PRESENCE_KEY_PREFIX}${userId}`;
}

async function verifyBearerToken(authHeader) {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;

  const { payload } = await jwtVerify(token, getJwtSecret());
  if (!payload || typeof payload.userId !== "string" || typeof payload.role !== "string") return null;
  return { userId: payload.userId, role: payload.role };
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PROBE_LOG_INTERVAL_MS = 60_000;
const probeLogAt = new Map();

function clip(value, max) {
  if (!value) return "-";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function clientIp(req) {
  // Security: probe-log throttle key must not be client-rotatable — X-Real-IP
  // is (re)set by our edge proxy; the right-most X-Forwarded-For entry is
  // appended by that same proxy, unlike the client-controlled head.
  const real = req.headers["x-real-ip"];
  if (real && String(real).trim()) return String(real).trim();
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = String(forwarded).split(",");
    const last = ips[ips.length - 1]?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || "unknown";
}

// One detailed line per source IP per minute: enough to see who probes us
// without replacing the old error flood with a warn flood.
function shouldLogProbe(ip) {
  const now = Date.now();
  const prev = probeLogAt.get(ip);
  if (prev !== undefined && now - prev < PROBE_LOG_INTERVAL_MS) return false;
  probeLogAt.set(ip, now);
  if (probeLogAt.size > 10_000) {
    for (const [key, ts] of probeLogAt) {
      if (now - ts >= PROBE_LOG_INTERVAL_MS) probeLogAt.delete(key);
    }
  }
  return true;
}

function rejectProbe(req, res, kind, detail) {
  const ip = clientIp(req);
  if (shouldLogProbe(ip)) {
    const extra = detail ? ` ${detail}` : "";
    console.warn(
      `[probe-blocked] ${kind} ${req.method} ${req.url} ip=${ip}${extra} ua=${clip(req.headers["user-agent"], 120)}`
    );
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  const port = Number(process.env.PORT || 3000);

  const app = next({ dev });
  const handle = app.getRequestHandler();

  await app.prepare();

  const redisPub = new Redis(getRedisUrl(), { enableReadyCheck: true, maxRetriesPerRequest: null });
  const redisSub = new Redis(getRedisUrl(), { enableReadyCheck: true, maxRetriesPerRequest: null });

  const server = http.createServer((req, res) => {
    // Security: the app defines zero Server Actions, so any `next-action`
    // header is a vulnerability scanner probe (CVE-2025-55182 "react2shell",
    // Next.js discussion #87851: bots send garbage like "x", "0", "action").
    // Rejecting before Next's action handler keeps its noisy errors out of
    // the production logs. LiqPay and the mobile app never send this header.
    if (req.headers["next-action"] !== undefined) {
      rejectProbe(req, res, "next-action", `action="${clip(String(req.headers["next-action"]), 64)}"`);
      return;
    }
    // Page paths only accept GET: multipart $ACTION_ID_ probes POST straight
    // to "/", while real traffic (mobile app, LiqPay, health checks) is GET
    // or lives under /api/ (file uploads included).
    const path = (req.url || "/").split("?")[0];
    if (WRITE_METHODS.has(req.method) && !path.startsWith("/api/") && !path.startsWith("/_next/")) {
      rejectProbe(req, res, "non-api-write", "");
      return;
    }
    handle(req, res);
  });
  const wss = new WebSocketServer({ noServer: true });

  const connectionsByUserId = new Map();

  function addConn(userId, ws) {
    const existing = connectionsByUserId.get(userId) || new Set();
    existing.add(ws);
    connectionsByUserId.set(userId, existing);
  }

  function removeConn(userId, ws) {
    const set = connectionsByUserId.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) connectionsByUserId.delete(userId);
  }

  async function refreshPresence(userId, role) {
    await redisPub.set(getPresenceKey(userId), role || "1", "EX", PRESENCE_TTL_SECONDS);
  }

  async function clearPresenceIfNoConnections(userId) {
    if (!connectionsByUserId.has(userId)) {
      await redisPub.del(getPresenceKey(userId));
    }
  }

  server.on("upgrade", async (req, socket, head) => {
    try {
      const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/ws" && url.pathname !== "/api/v1/ws") {
        socket.destroy();
        return;
      }

      const auth = req.headers["authorization"];
      let identity = await verifyBearerToken(auth);
      if (!identity && dev) {
        const token = url.searchParams.get("token");
        if (token) {
          try {
            const { payload } = await jwtVerify(token, getJwtSecret());
            if (payload && typeof payload.userId === "string" && typeof payload.role === "string") {
              identity = { userId: payload.userId, role: payload.role };
            }
          } catch {}
        }
      }
      if (!identity) {
        if (dev) {
          process.stdout.write(
            JSON.stringify({
              level: "info",
              msg: "ws_rejected",
              reason: "unauthorized",
              path: url.pathname,
              hasAuthHeader: Boolean(req.headers["authorization"]),
              hasTokenQuery: Boolean(url.searchParams.get("token")),
            }) + "\n"
          );
        }
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = identity.userId;
        ws.role = identity.role;
        wss.emit("connection", ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", async (ws) => {
    const userId = ws.userId;
    addConn(userId, ws);
    await refreshPresence(userId, ws.role);
    const count = connectionsByUserId.get(userId)?.size ?? 0;
    process.stdout.write(
      JSON.stringify({
        level: "info",
        msg: "ws_connected",
        userId,
        role: ws.role,
        connectionsForUser: count,
      }) + "\n"
    );
    process.stdout.write(`✅ [WebSocket] Користувач підключився: userId=${userId}, role=${ws.role}, connections=${count}\n`);

    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    const interval = setInterval(async () => {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}
        return;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
      try {
        await refreshPresence(userId, ws.role);
      } catch {}
    }, 30_000);

    ws.on("close", async () => {
      clearInterval(interval);
      removeConn(userId, ws);
      try {
        await clearPresenceIfNoConnections(userId);
      } catch {}
      const count = connectionsByUserId.get(userId)?.size ?? 0;
      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "ws_closed",
          userId,
          connectionsForUser: count,
        }) + "\n"
      );
      process.stdout.write(`❌ [WebSocket] Користувач відключився: userId=${userId}, connections=${count}\n`);
    });
  });

  await redisSub.subscribe(DOMAIN_EVENTS_CHANNEL);
  redisSub.on("message", (_channel, message) => {
    let evt;
    try {
      evt = JSON.parse(message);
    } catch {
      return;
    }

    const targets = evt && evt.targets && Array.isArray(evt.targets.userIds) ? evt.targets.userIds : [];
    let delivered = 0;
    let deliveredUsers = 0;
    const deliveredUserIds = [];
    const missedUserIds = [];
    
    for (const userId of targets) {
      const conns = connectionsByUserId.get(userId);
      if (!conns) {
        missedUserIds.push(userId);
        continue;
      }
      deliveredUsers += 1;
      deliveredUserIds.push(userId);
      for (const ws of conns) {
        try {
          ws.send(message);
          delivered += 1;
        } catch (err) {
          if (dev) {
            process.stdout.write(
              JSON.stringify({
                level: "warn",
                msg: "ws_send_error",
                userId,
                error: err.message,
              }) + "\n"
            );
          }
        }
      }
    }
    
    // Детальне логування для відладки (завжди)
    process.stdout.write(
      "\n📩 [WebSocket] ОТРИМАНО ПОДІЮ З REDIS:\n" +
      `   🆔 Type: ${evt?.type || "unknown"}\n` +
      `   🔑 EventId: ${evt?.eventId || "unknown"}\n` +
      `   ⏰ Timestamp: ${evt?.timestamp || "unknown"}\n` +
      `   👥 Targets: ${JSON.stringify(targets)}\n` +
      `   📦 Data: ${JSON.stringify(evt?.data || {})}\n` +
      `   ✅ Користувачів онлайн: ${deliveredUsers}/${targets.length}\n` +
      `   📨 Доставлено: ${delivered} повідомлень\n` +
      `   📲 Отримали: ${deliveredUserIds.length > 0 ? deliveredUserIds.join(", ") : "нікого"}\n` +
      `   ❌ Не отримали (offline): ${missedUserIds.length > 0 ? missedUserIds.join(", ") : "нікого"}\n\n`
    );
  });

  server.listen(port, () => {
    let redis;
    try {
      const u = new URL(getRedisUrl());
      redis = { host: u.hostname, port: u.port || "6379" };
    } catch {
      redis = { host: "unknown", port: "unknown" };
    }
    process.stdout.write(
      JSON.stringify({
        level: "info",
        msg: "server_ready",
        port,
        wsPaths: ["/ws", "/api/v1/ws"],
        redis,
      }) + "\n"
    );
  });
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err?.message || err) + "\n");
  process.exit(1);
});
