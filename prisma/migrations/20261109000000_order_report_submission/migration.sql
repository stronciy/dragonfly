-- Момент відправки фотозвіту виконавця замовнику.
ALTER TABLE "orders" ADD COLUMN "report_submitted_at" TIMESTAMP(3);
