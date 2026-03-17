import { matchNewExecutorQueue, matchNewOrderQueue } from "./queues";

export async function enqueueMatchNewOrder(orderId: string) {
  await matchNewOrderQueue.add("match", { orderId }, { jobId: `order-${orderId}` });
}

export async function enqueueMatchNewExecutor(performerUserId: string) {
  await matchNewExecutorQueue.add(
    "match",
    { performerUserId },
    { jobId: `performer-${performerUserId}` }
  );
}
