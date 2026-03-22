import { startMatchNewExecutorWorker } from "./matchNewExecutor.worker";
import { startMatchNewOrderWorker } from "./matchNewOrder.worker";
import { startDepositDeadlineTimeoutWorker } from "./depositDeadlineTimeout.worker";
import { startExpiredOrdersWorker } from "./expiredOrders.worker";

const workers = [
  startMatchNewOrderWorker(),
  startMatchNewExecutorWorker(),
  startDepositDeadlineTimeoutWorker(),
  startExpiredOrdersWorker(),
];

for (const w of workers) {
  w.on("failed", (job, err) => {
    if (job) {
      process.stderr.write(
        JSON.stringify({ level: "error", msg: "job_failed", queue: w.name, jobId: job.id, err })
      );
      process.stderr.write("\n");
    }
  });
}

process.on("SIGTERM", async () => {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});

process.on("SIGINT", async () => {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
