import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

const baseUrl = process.env.API_URL ?? 'http://localhost:3000';
const key = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const payload = { amount: 129900, currency: 'INR' };

async function main() {
  const before = await prisma.processorCharge.count({ where: { providerKey: `demo-merchant:${key}` } });
  const responses = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const response = await fetch(`${baseUrl}/charges`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': key,
        'x-merchant-id': 'demo-merchant',
      },
      body: JSON.stringify(payload),
    });
    return { request: index + 1, status: response.status, body: await response.json() as Record<string, unknown> };
  }));

  const after = await prisma.processorCharge.count({ where: { providerKey: `demo-merchant:${key}` } });
  const ids = [...new Set(responses.map((r) => r.body.charge_id).filter(Boolean))];
  console.table(responses.map((r) => ({ request: r.request, http: r.status, status: r.body.status, charge_id: r.body.charge_id ?? '-' })));
  console.log({ idempotencyKey: key, requestsSent: 10, newProcessorCharges: after - before, uniqueChargeIds: ids.length });
  if (after - before !== 1 || ids.length !== 1 || responses.some((r) => r.body.status !== 'succeeded')) {
    throw new Error('Concurrency test failed: expected exactly one successful charge shared by all ten requests.');
  }
  console.log('PASS: 10 simultaneous requests produced exactly one charge.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
