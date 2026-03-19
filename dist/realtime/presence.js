"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPresenceKey = getPresenceKey;
exports.markUserOnline = markUserOnline;
exports.markUserOffline = markUserOffline;
exports.isUserOnline = isUserOnline;
exports.getOnlineUserIds = getOnlineUserIds;
const ioredis_1 = __importDefault(require("ioredis"));
const KEY_PREFIX = "ws:online:";
const TTL_SECONDS = 60;
let redis = null;
function getRedis() {
    if (redis)
        return redis;
    const url = process.env.REDIS_URL;
    if (!url)
        return null;
    redis = new ioredis_1.default(url, { enableReadyCheck: true, maxRetriesPerRequest: null });
    return redis;
}
function getPresenceKey(userId) {
    return `${KEY_PREFIX}${userId}`;
}
async function markUserOnline(userId) {
    const r = getRedis();
    if (!r)
        return;
    await r.set(getPresenceKey(userId), "1", "EX", TTL_SECONDS);
}
async function markUserOffline(userId) {
    const r = getRedis();
    if (!r)
        return;
    await r.del(getPresenceKey(userId));
}
async function isUserOnline(userId) {
    const r = getRedis();
    if (!r)
        return false;
    const exists = await r.exists(getPresenceKey(userId));
    return exists === 1;
}
async function getOnlineUserIds(userIds) {
    var _a;
    const r = getRedis();
    if (!r)
        return new Set();
    const pipeline = r.pipeline();
    for (const userId of userIds)
        pipeline.exists(getPresenceKey(userId));
    const results = await pipeline.exec();
    const online = new Set();
    for (let i = 0; i < userIds.length; i++) {
        const [, value] = (_a = results === null || results === void 0 ? void 0 : results[i]) !== null && _a !== void 0 ? _a : [];
        if (value === 1)
            online.add(userIds[i]);
    }
    return online;
}
