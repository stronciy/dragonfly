"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueMatchNewOrder = enqueueMatchNewOrder;
exports.enqueueMatchNewExecutor = enqueueMatchNewExecutor;
const queues_1 = require("./queues");
async function enqueueMatchNewOrder(orderId) {
    await queues_1.matchNewOrderQueue.add("match", { orderId }, { jobId: `order:${orderId}` });
}
async function enqueueMatchNewExecutor(performerUserId) {
    await queues_1.matchNewExecutorQueue.add("match", { performerUserId }, { jobId: `performer:${performerUserId}` });
}
