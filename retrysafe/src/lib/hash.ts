import { createHash } from 'node:crypto';

export function hashChargeRequest(input: { amount: number; currency: string }): string {
  // Stable serialization: only business-significant fields are included.
  return createHash('sha256')
    .update(JSON.stringify({ amount: input.amount, currency: input.currency.toUpperCase() }))
    .digest('hex');
}
