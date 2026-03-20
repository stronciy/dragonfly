"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMatchNewOrderQueue = getMatchNewOrderQueue;
exports.getMatchNewExecutorQueue = getMatchNewExecutorQueue;
const bullmq_1 = require("bullmq");
const connection_1 = require("./connection");
const defaultJobOptions = {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: true,
    removeOnFail: { count: 5000 },
};
let matchNewOrderQueue = null;
function getMatchNewOrderQueue() {
    if (matchNewOrderQueue)
        return matchNewOrderQueue;
    matchNewOrderQueue = new bullmq_1.Queue("match-new-order", {
        connection: (0, connection_1.getRedisConnectionOptions)(),
        defaultJobOptions,
    });
    return matchNewOrderQueue;
}
let matchNewExecutorQueue = null;
function getMatchNewExecutorQueue() {
    if (matchNewExecutorQueue)
        return matchNewExecutorQueue;
    matchNewExecutorQueue = new bullmq_1.Queue("match-new-executor", {
        connection: (0, connection_1.getRedisConnectionOptions)(),
        defaultJobOptions,
    });
    return matchNewExecutorQueue;
}
