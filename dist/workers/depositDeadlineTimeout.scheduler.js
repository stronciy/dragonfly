"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.runScheduler = runScheduler;
const depositDeadlineTimeout_worker_1 = require("./depositDeadlineTimeout.worker");
const expiredOrders_worker_1 = require("./expiredOrders.worker");
/**
 * Scheduler для періодичної перевірки тайм-аутів депозитів та прострочених замовлень
 * Запускається кожні 5 хвилин
 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 хвилин
async function runScheduler() {
    process.stdout.write(JSON.stringify({
        level: "info",
        msg: "scheduler_started",
        intervalMs: CHECK_INTERVAL_MS,
        checks: ["deposit_deadline_timeout", "expired_orders"],
    }) + "\n");
    // Перший запуск одразу
    await runChecks();
    // Потім кожні 5 хвилин
    setInterval(runChecks, CHECK_INTERVAL_MS);
}
async function runChecks() {
    try {
        process.stdout.write(JSON.stringify({ level: "info", msg: "scheduler_checks_running" }) + "\n");
        // Перевірка тайм-аутів депозитів
        await (0, depositDeadlineTimeout_worker_1.scheduleDepositDeadlineTimeoutChecks)();
        // Перевірка прострочених замовлень
        await (0, expiredOrders_worker_1.scheduleExpiredOrderChecks)();
        process.stdout.write(JSON.stringify({ level: "info", msg: "scheduler_checks_completed" }) + "\n");
    }
    catch (error) {
        process.stderr.write(JSON.stringify({
            level: "error",
            msg: "scheduler_checks_failed",
            error: error instanceof Error ? error.message : String(error),
        }) + "\n");
    }
}
// Запускаємо scheduler якщо цей файл запущено напряму
if ((_a = process.argv[1]) === null || _a === void 0 ? void 0 : _a.endsWith("depositDeadlineTimeout.scheduler.ts")) {
    runScheduler().catch((err) => {
        process.stderr.write(JSON.stringify({
            level: "error",
            msg: "scheduler_error",
            error: err instanceof Error ? err.message : String(err),
        }) + "\n");
        process.exit(1);
    });
}
