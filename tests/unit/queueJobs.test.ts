import assert from "node:assert/strict";
import test from "node:test";
import type { Queue } from "bullmq";
import { addQueueJob } from "../../src/queues/jobs";

function fakeQueue(existing: {
  state: string;
  remove?: () => Promise<void>;
} | null) {
  const calls: string[] = [];
  const job = existing
    ? {
        getState: async () => existing.state,
        remove: async () => {
          calls.push("remove");
          await existing.remove?.();
        },
      }
    : null;

  const queue = {
    getJob: async (jobId: string) => {
      calls.push(`get:${jobId}`);
      return job;
    },
    add: async (name: string, data: unknown, opts: { jobId: string }) => {
      calls.push(`add:${name}:${opts.jobId}`);
      return { name, data, opts };
    },
  } as unknown as Queue;

  return { queue, calls };
}

test("addQueueJob removes a failed job before re-adding it", async () => {
  const { queue, calls } = fakeQueue({ state: "failed" });

  await addQueueJob(queue, "match", { orderId: "o1" }, "order-o1");

  assert.deepEqual(calls, ["get:order-o1", "remove", "add:match:order-o1"]);
});

test("addQueueJob removes a completed job before re-adding it", async () => {
  const { queue, calls } = fakeQueue({ state: "completed" });

  await addQueueJob(queue, "match", { orderId: "o1" }, "order-o1");

  assert.deepEqual(calls, ["get:order-o1", "remove", "add:match:order-o1"]);
});

test("addQueueJob keeps dedupe for waiting/active jobs", async () => {
  for (const state of ["waiting", "active", "delayed"]) {
    const { queue, calls } = fakeQueue({ state });

    await addQueueJob(queue, "match", { orderId: "o1" }, "order-o1");

    assert.deepEqual(calls, ["get:order-o1"], `state=${state}`);
  }
});

test("addQueueJob falls back to a unique id when remove is locked", async () => {
  const { queue, calls } = fakeQueue({
    state: "failed",
    remove: async () => {
      throw new Error("locked");
    },
  });

  await addQueueJob(queue, "match", { orderId: "o1" }, "order-o1");

  assert.equal(calls[0], "get:order-o1");
  assert.equal(calls[1], "remove");
  assert.match(calls[2], /^add:match:order-o1-retry-\d+$/);
});
