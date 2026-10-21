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

export const ALL_QUEUE_NAMES = [
  "match-new-order",
  "match-new-executor",
  "deposit-deadline-timeout",
  "expired-orders",
] as const;

function allQueues(): Queue[] {
  return [
    getMatchNewOrderQueue(),
    getMatchNewExecutorQueue(),
    getDepositDeadlineTimeoutQueue(),
    getExpiredOrdersQueue(),
  ];
}

const COUNT_KEYS = ["wait", "active", "delayed", "failed", "completed", "paused"] as const;

export type QueueCounts = Record<(typeof COUNT_KEYS)[number], number>;

export type QueueSnapshot = {
  name: string;
  counts: QueueCounts;
};

export type QueueClearResult = {
  ok: boolean;
  cleared: QueueSnapshot[];
  errors: Array<{ name: string; error: string }>;
};

async function readCounts(queue: Queue): Promise<QueueCounts> {
  const raw = await queue.getJobCounts(...COUNT_KEYS);
  return COUNT_KEYS.reduce((acc, key) => {
    acc[key] = Number(raw[key] ?? 0);
    return acc;
  }, {} as QueueCounts);
}

/**
 * Read-only queue counters for the admin panel. A missing/failed Redis must
 * never break the system page, so the caller can show a degraded state.
 */
export async function getQueuesSnapshot(): Promise<QueueSnapshot[]> {
  return Promise.all(
    allQueues().map(async (queue) => ({
      name: queue.name,
      counts: await readCounts(queue),
    }))
  );
}

/**
 * OPS: remove queued work left over from a previous test run.
 *
 * `drain(true)` drops waiting and delayed jobs; `clean` removes failed and
 * completed jobs. Failed jobs are especially important: BullMQ keeps them
 * (removeOnFail: { count: 5000 }) and an enqueue with the same deterministic
 * jobId is silently ignored, so a failed match job would otherwise block every
 * future re-match for that order/performer.
 *
 * Active jobs are intentionally left alone: they finish against the old data
 * and no-op after the reset. `obliterate()` would also kill in-flight jobs and
 * can make the worker log spurious failures.
 */
export async function clearQueues(): Promise<QueueClearResult> {
  const cleared: QueueSnapshot[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const queue of allQueues()) {
    try {
      await queue.drain(true);
      await queue.clean(0, 10_000, "failed");
      await queue.clean(0, 10_000, "completed");
      cleared.push({ name: queue.name, counts: await readCounts(queue) });
    } catch (err) {
      errors.push({
        name: queue.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: errors.length === 0, cleared, errors };
}
