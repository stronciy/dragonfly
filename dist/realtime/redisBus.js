"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishRaw = publishRaw;
exports.getDomainEventsChannel = getDomainEventsChannel;
const ioredis_1 = __importDefault(require("ioredis"));
const CHANNEL = "domain-events-v1";
let publisher = null;
function getPublisher() {
    if (publisher)
        return publisher;
    const url = process.env.REDIS_URL;
    if (!url)
        return null;
    publisher = new ioredis_1.default(url, { enableReadyCheck: true, maxRetriesPerRequest: null });
    return publisher;
}
async function publishRaw(message) {
    const pub = getPublisher();
    if (!pub) {
        if (process.env.NODE_ENV !== "production") {
            console.warn("[realtime] REDIS_URL is not set; realtime events are disabled");
        }
        return;
    }
    await pub.publish(CHANNEL, message);
}
function getDomainEventsChannel() {
    return CHANNEL;
}
