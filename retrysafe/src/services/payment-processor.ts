import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export interface ChargeInput {
  amount: number;
  currency: string;
  idempotencyKey: string;
}

export interface ChargeResult {
  id: string;
  amount: number;
  currency: string;
}

/**
 * Local deterministic processor simulator.
 * In production, replace this with Stripe/Razorpay and pass idempotencyKey to
 * their charge/payment API. Never call a non-idempotent provider here.
 */
export async function createProviderCharge(input: ChargeInput): Promise<ChargeResult> {
  // Simulate provider latency so the concurrency test creates real overlap.
  await new Promise((resolve) => setTimeout(resolve, 300));

  try {
    const charge = await prisma.processorCharge.create({
      data: {
        providerKey: input.idempotencyKey,
        amount: input.amount,
        currency: input.currency.toUpperCase(),
      },
    });
    return { id: charge.id, amount: charge.amount, currency: charge.currency };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.processorCharge.findUnique({
        where: { providerKey: input.idempotencyKey },
      });
      if (existing) {
        if (existing.amount !== input.amount || existing.currency !== input.currency.toUpperCase()) {
          throw new Error('PROVIDER_IDEMPOTENCY_CONFLICT');
        }
        return { id: existing.id, amount: existing.amount, currency: existing.currency };
      }
    }
    throw error;
  }
}
