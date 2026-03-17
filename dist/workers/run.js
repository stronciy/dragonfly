"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const matchNewExecutor_worker_1 = require("./matchNewExecutor.worker");
const matchNewOrder_worker_1 = require("./matchNewOrder.worker");
const workers = [(0, matchNewOrder_worker_1.startMatchNewOrderWorker)(), (0, matchNewExecutor_worker_1.startMatchNewExecutorWorker)()];
for (const w of workers) {
    w.on("failed", (job, err) => {
        if (job) {
            process.stderr.write(JSON.stringify({ level: "error", msg: "job_failed", queue: w.name, jobId: job.id, err }));
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
