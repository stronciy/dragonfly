/**
 * Service fee (commission) helpers.
 * 8.5% of order budget is added to customer payment (deposit + fee).
 * Fee is non-refundable on successful order completion.
 */

export const SERVICE_FEE_RATE = 0.085;

/**
 * Calculate service fee amount (8.5% of budget, rounded to 2 decimals).
 */
export function serviceFeeAmount(budget: number | string): number {
  const rate = SERVICE_FEE_RATE;
  const amount = parseFloat(String(budget)) * rate;
  return Math.round(amount * 100) / 100;
}

/**
 * Customer deposit amount (30% of budget).
 */
export function customerDepositAmount(budget: number | string): number {
  const depositRate = 0.3;
  const amount = parseFloat(String(budget)) * depositRate;
  return Math.round(amount * 100) / 100;
}

/**
 * Total amount customer pays at deposit stage: deposit + service fee.
 */
export function customerPayableNow(budget: number | string): number {
  const deposit = customerDepositAmount(budget);
  const fee = serviceFeeAmount(budget);
  return deposit + fee;
}
