import { getMatchNewExecutorQueue, getMatchNewOrderQueue } from "./queues";

export async function enqueueMatchNewOrder(orderId: string) {
  await getMatchNewOrderQueue().add("match", { orderId }, { jobId: `order-${orderId}` });
}

export async function enqueueMatchNewExecutor(performerUserId: string) {
  await getMatchNewExecutorQueue().add(
    "match",
    { performerUserId },
    { jobId: `performer-${performerUserId}` }
  );
}
