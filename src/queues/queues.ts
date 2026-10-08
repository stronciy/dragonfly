import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "./connection";

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: true,
  removeOnFail: { count: 5000 },
};

let matchNewOrderQueue: Queue | null = null;
export function getMatchNewOrderQueue() {
  if (matchNewOrderQueue) return matchNewOrderQueue;
  matchNewOrderQueue = new Queue("match-new-order", {
    connection: getRedisConnectionOptions(),
    defaultJobOptions,
  });
  return matchNewOrderQueue;
}

let matchNewExecutorQueue: Queue | null = null;
export function getMatchNewExecutorQueue() {
  if (matchNewExecutorQueue) return matchNewExecutorQueue;
  matchNewExecutorQueue = new Queue("match-new-executor", {
    connection: getRedisConnectionOptions(),
    defaultJobOptions,
  });
  return matchNewExecutorQueue;
}

let depositDeadlineTimeoutQueue: Queue | null = null;
export function getDepositDeadlineTimeoutQueue() {
  if (depositDeadlineTimeoutQueue) return depositDeadlineTimeoutQueue;
  depositDeadlineTimeoutQueue = new Queue("deposit-deadline-timeout", {
    connection: getRedisConnectionOptions(),
    defaultJobOptions,
  });
  return depositDeadlineTimeoutQueue;
}

let expiredOrdersQueue: Queue | null = null;
export function getExpiredOrdersQueue() {
  if (expiredOrdersQueue) return expiredOrdersQueue;
  expiredOrdersQueue = new Queue("expired-orders", {
    connection: getRedisConnectionOptions(),
    defaultJobOptions,
  });
  return expiredOrdersQueue;
}
