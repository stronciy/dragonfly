-- Сповіщення про залишок 70%: нагадування та прострочка (ідемпотентність воркера).
ALTER TABLE "orders"
  ADD COLUMN "part2_reminder_sent_at" TIMESTAMP(3),
  ADD COLUMN "part2_overdue_notified_at" TIMESTAMP(3);
