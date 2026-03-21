import { getMatchNewExecutorQueue, getMatchNewOrderQueue, getDepositDeadlineTimeoutQueue } from "./queues";

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

export async function enqueueDepositDeadlineTimeout(orderId: string) {
  await getDepositDeadlineTimeoutQueue().add("timeout", { orderId }, { jobId: `timeout-${orderId}` });
}
