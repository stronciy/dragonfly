import type { Queue } from "bullmq";
import { getMatchNewExecutorQueue, getMatchNewOrderQueue, getDepositDeadlineTimeoutQueue, getExpiredOrdersQueue } from "./queues";

/**
 * Add a deterministic job, but do not let an old failed/completed job with the
 * same id block a fresh attempt.
 *
 * BullMQ treats `jobId` as unique: adding a job that already exists in a
 * failed state is a no-op. After a worker restart or a transient DB error the
 * job stays failed (removeOnFail keeps 5000), so saving performer settings or
 * re-publishing an order would silently never rematch. Waiting/active/delayed
 * jobs still dedupe normally.
 */
export async function addQueueJob<T extends Record<string, unknown>>(
  queue: Queue,
  name: string,
  data: T,
  jobId: string
) {
  let effectiveJobId = jobId;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState().catch(() => "unknown");
    if (state === "failed" || state === "completed") {
      try {
        await existing.remove();
      } catch {
        // A worker may hold a lock for a split second. A timestamped id keeps
        // the rematch possible; the worker itself is idempotent.
        effectiveJobId = `${jobId}-retry-${Date.now()}`;
      }
    } else {
      return existing;
    }
  }
  return queue.add(name, data, { jobId: effectiveJobId });
}

export async function enqueueMatchNewOrder(orderId: string) {
  await addQueueJob(getMatchNewOrderQueue(), "match", { orderId }, `order-${orderId}`);
}

export async function enqueueMatchNewExecutor(performerUserId: string) {
  await addQueueJob(
    getMatchNewExecutorQueue(),
    "match",
    { performerUserId },
    `performer-${performerUserId}`
  );
}

export async function enqueueDepositDeadlineTimeout(orderId: string) {
  await addQueueJob(
    getDepositDeadlineTimeoutQueue(),
    "timeout",
    { orderId },
    `timeout-${orderId}`
  );
}

export async function enqueueExpiredOrder(orderId: string) {
  await addQueueJob(getExpiredOrdersQueue(), "expire", { orderId }, `expire-${orderId}`);
}
