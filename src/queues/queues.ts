import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "./connection";

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: true,
  removeOnFail: { count: 5000 },
};

export const matchNewOrderQueue = new Queue("match-new-order", {
  connection: getRedisConnectionOptions(),
  defaultJobOptions,
});

export const matchNewExecutorQueue = new Queue("match-new-executor", {
  connection: getRedisConnectionOptions(),
  defaultJobOptions,
});
