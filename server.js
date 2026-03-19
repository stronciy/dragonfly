const http = require("http");
const next = require("next");
const Redis = require("ioredis");
const { WebSocketServer } = require("ws");
const { jwtVerify } = require("jose");

const DOMAIN_EVENTS_CHANNEL = "domain-events-v1";
const PRESENCE_KEY_PREFIX = "ws:online:";
const PRESENCE_TTL_SECONDS = 120;

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
  if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;

  const { payload } = await jwtVerify(token, getJwtSecret());
  if (!payload || typeof payload.userId !== "string" || typeof payload.role !== "string") return null;
  return { userId: payload.userId, role: payload.role };
}

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  const port = Number(process.env.PORT || 3001);

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
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      const auth = req.headers["authorization"];
      const identity = await verifyBearerToken(auth);
      if (!identity) {
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
    for (const userId of targets) {
      const conns = connectionsByUserId.get(userId);
      if (!conns) continue;
      for (const ws of conns) {
        try {
          ws.send(message);
        } catch {}
      }
    }
  });

  server.listen(port, () => {
    process.stdout.write(JSON.stringify({ level: "info", msg: "server_ready", port }) + "\n");
  });
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err?.message || err) + "\n");
  process.exit(1);
});

