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

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  const port = Number(process.env.PORT || 3000);

  const app = next({ dev });
  const handle = app.getRequestHandler();

  await app.prepare();

  const redisPub = new Redis(getRedisUrl(), { enableReadyCheck: true, maxRetriesPerRequest: null });
  const redisSub = new Redis(getRedisUrl(), { enableReadyCheck: true, maxRetriesPerRequest: null });

  const server = http.createServer((req, res) => handle(req, res));
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

  async function refreshPresence(userId) {
    await redisPub.set(getPresenceKey(userId), "1", "EX", PRESENCE_TTL_SECONDS);
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
    await refreshPresence(userId);
    if (dev) {
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
    }

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
        await refreshPresence(userId);
      } catch {}
    }, 30_000);

    ws.on("close", async () => {
      clearInterval(interval);
      removeConn(userId, ws);
      try {
        await clearPresenceIfNoConnections(userId);
      } catch {}
      if (dev) {
        const count = connectionsByUserId.get(userId)?.size ?? 0;
        process.stdout.write(
          JSON.stringify({
            level: "info",
            msg: "ws_closed",
            userId,
            connectionsForUser: count,
          }) + "\n"
        );
      }
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
    for (const userId of targets) {
      const conns = connectionsByUserId.get(userId);
      if (!conns) continue;
      deliveredUsers += 1;
      for (const ws of conns) {
        try {
          ws.send(message);
          delivered += 1;
        } catch {}
      }
    }
    if (dev && targets.length) {
      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "ws_broadcast",
          type: evt?.type,
          targetUsers: targets.length,
          usersWithConnections: deliveredUsers,
          delivered,
        }) + "\n"
      );
    }
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
