/** Скільки часу має кожна сторона, щоб відповісти в арбітражі. */
export const ARBITRATION_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function responseDueAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + ARBITRATION_RESPONSE_WINDOW_MS);
}
