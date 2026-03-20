"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueMatchNewOrder = enqueueMatchNewOrder;
exports.enqueueMatchNewExecutor = enqueueMatchNewExecutor;
const queues_1 = require("./queues");
async function enqueueMatchNewOrder(orderId) {
    await (0, queues_1.getMatchNewOrderQueue)().add("match", { orderId }, { jobId: `order-${orderId}` });
}
async function enqueueMatchNewExecutor(performerUserId) {
    await (0, queues_1.getMatchNewExecutorQueue)().add("match", { performerUserId }, { jobId: `performer-${performerUserId}` });
}
