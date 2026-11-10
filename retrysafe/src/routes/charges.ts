import { Prisma, PaymentStatus } from '@prisma/client';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { hashChargeRequest } from '../lib/hash';
import { createProviderCharge } from '../services/payment-processor';

export const chargesRouter = Router();

const chargeSchema = z.object({
  amount: z.number().int().positive().max(100_000_000),
  currency: z.string().length(3).default('INR').transform((v) => v.toUpperCase()),
}).strict();

const WAIT_MS = Number(process.env.IDEMPOTENCY_WAIT_MS ?? 10_000);
const POLL_MS = 50;

// Demo authentication boundary. Replace with verified API-key/JWT middleware.
// A client cannot choose another merchant's idempotency namespace in production.
function merchantFromRequest(req: Request): string {
  return req.header('x-merchant-id')?.trim() || 'demo-merchant';
}

async function waitForTerminalPayment(paymentId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (payment && payment.status !== PaymentStatus.PROCESSING) return payment;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return prisma.payment.findUnique({ where: { id: paymentId } });
}

function sendPayment(res: Response, payment: NonNullable<Awaited<ReturnType<typeof prisma.payment.findUnique>>>, replayed: boolean) {
  res.setHeader('Idempotency-Replayed', String(replayed));
  if (payment.status === PaymentStatus.PROCESSING) {
    return res.status(202).json({ id: payment.id, status: 'processing', message: 'The original request is still processing. Retry with the same Idempotency-Key.' });
  }
  if (payment.status === PaymentStatus.FAILED) {
    return res.status(402).json({ id: payment.id, status: 'failed', error: payment.failureCode ?? 'payment_failed' });
  }
  return res.status(201).json({
    id: payment.id,
    status: 'succeeded',
    amount: payment.amount,
    currency: payment.currency,
    charge_id: payment.providerChargeId,
  });
}

chargesRouter.post('/', async (req: Request, res: Response) => {
  const key = req.header('Idempotency-Key')?.trim();
  if (!key || key.length < 8 || key.length > 255) {
    return res.status(400).json({ error: 'invalid_idempotency_key', message: 'Provide an Idempotency-Key between 8 and 255 characters.' });
  }

  const parsed = chargeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
  }

  const merchantId = merchantFromRequest(req);
  const { amount, currency } = parsed.data;
  const requestHash = hashChargeRequest({ amount, currency });
  let payment;
  let isOwner = false;

  try {
    payment = await prisma.payment.create({
      data: { merchantId, idempotencyKey: key, requestHash, amount, currency },
    });
    isOwner = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    payment = await prisma.payment.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey: key } },
    });
    if (!payment) return res.status(503).json({ error: 'idempotency_record_unavailable', retryable: true });
    if (payment.requestHash !== requestHash) {
      return res.status(409).json({
        error: 'idempotency_key_reused',
        message: 'This key was already used with a different amount or currency. Use a new key for a new payment.',
      });
    }
  }

  if (!isOwner) {
    const settled = payment.status === PaymentStatus.PROCESSING
      ? await waitForTerminalPayment(payment.id, WAIT_MS)
      : payment;
    if (!settled) return res.status(503).json({ error: 'payment_status_unavailable', retryable: true });
    return sendPayment(res, settled, true);
  }

  try {
    // Provider-side key is namespaced by merchant and is stable across retries.
    const providerCharge = await createProviderCharge({
      amount,
      currency,
      idempotencyKey: `${merchantId}:${key}`,
    });
    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.SUCCEEDED, providerChargeId: providerCharge.id },
    });
    return sendPayment(res, updated, false);
  } catch (error) {
    // Provider idempotency conflicts are a client conflict; other failures are
    // marked failed in this demo. Production systems should classify retryable
    // provider/network failures and retain PROCESSING for reconciliation.
    const conflict = error instanceof Error && error.message === 'PROVIDER_IDEMPOTENCY_CONFLICT';
    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.FAILED, failureCode: conflict ? 'idempotency_conflict' : 'processor_error' },
    });
    return sendPayment(res, updated, false);
  }
});
