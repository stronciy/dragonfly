"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueMatchNewOrder = enqueueMatchNewOrder;
exports.enqueueMatchNewExecutor = enqueueMatchNewExecutor;
exports.enqueueDepositDeadlineTimeout = enqueueDepositDeadlineTimeout;
exports.enqueueExpiredOrder = enqueueExpiredOrder;
const queues_1 = require("./queues");
async function enqueueMatchNewOrder(orderId) {
    await (0, queues_1.getMatchNewOrderQueue)().add("match", { orderId }, { jobId: `order-${orderId}` });
}
async function enqueueMatchNewExecutor(performerUserId) {
    await (0, queues_1.getMatchNewExecutorQueue)().add("match", { performerUserId }, { jobId: `performer-${performerUserId}` });
}
async function enqueueDepositDeadlineTimeout(orderId) {
    await (0, queues_1.getDepositDeadlineTimeoutQueue)().add("timeout", { orderId }, { jobId: `timeout-${orderId}` });
}
async function enqueueExpiredOrder(orderId) {
    await (0, queues_1.getExpiredOrdersQueue)().add("expire", { orderId }, { jobId: `expire-${orderId}` });
}
