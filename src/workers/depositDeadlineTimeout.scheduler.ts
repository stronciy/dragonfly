import { scheduleDepositDeadlineTimeoutChecks } from "./depositDeadlineTimeout.worker";

/**
 * Scheduler для періодичної перевірки тайм-аутів депозитів
 * Запускається кожні 5 хвилин
 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 хвилин

async function runScheduler() {
  process.stdout.write(
    JSON.stringify({
      level: "info",
      msg: "deposit_timeout_scheduler_started",
      intervalMs: CHECK_INTERVAL_MS,
    }) + "\n"
  );

  // Перший запуск одразу
  await runCheck();

  // Потім кожні 5 хвилин
  setInterval(runCheck, CHECK_INTERVAL_MS);
}

async function runCheck() {
  try {
    process.stdout.write(
      JSON.stringify({ level: "info", msg: "deposit_timeout_check_running" }) + "\n"
    );

    await scheduleDepositDeadlineTimeoutChecks();

    process.stdout.write(
      JSON.stringify({ level: "info", msg: "deposit_timeout_check_completed" }) + "\n"
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        msg: "deposit_timeout_check_failed",
        error: error instanceof Error ? error.message : String(error),
      }) + "\n"
    );
  }
}

// Запускаємо scheduler якщо цей файл запущено напряму
if (process.argv[1]?.endsWith("depositDeadlineTimeout.scheduler.ts")) {
  runScheduler().catch((err) => {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        msg: "deposit_timeout_scheduler_error",
        error: err instanceof Error ? err.message : String(err),
      }) + "\n"
    );
    process.exit(1);
  });
}

export { runScheduler };
