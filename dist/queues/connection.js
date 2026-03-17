"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedisConnectionOptions = getRedisConnectionOptions;
function getRedisConnectionOptions() {
    var _a;
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl)
        throw new Error("REDIS_URL is required");
    const url = new URL(redisUrl);
    const db = ((_a = url.pathname) === null || _a === void 0 ? void 0 : _a.length) > 1 ? Number(url.pathname.slice(1)) : undefined;
    return {
        host: url.hostname,
        port: url.port ? Number(url.port) : 6379,
        username: url.username || undefined,
        password: url.password || undefined,
        db: Number.isFinite(db) ? db : undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
    };
}
