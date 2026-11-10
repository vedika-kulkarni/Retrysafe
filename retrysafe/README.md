# RetrySafe — Idempotent Payment Gateway

A backend-only payment API demonstrating safe retries under concurrent requests. Ten simultaneous `POST /charges` requests using the same merchant and `Idempotency-Key` produce one durable simulated processor charge.

## Architecture

- `POST /charges` validates the request and requires an `Idempotency-Key` header.
- PostgreSQL enforces `UNIQUE (merchantId, idempotencyKey)`. This is the concurrency gate; application-level `find then insert` is deliberately not used.
- The first request creates the idempotency record and becomes the owner. Concurrent duplicates hit the unique constraint, load the existing record, verify the request hash, and wait for the original result.
- Reusing a key with a different amount/currency returns `409 Conflict`.
- The mock processor has its own durable unique provider key, modelling the idempotency contract required from a real payment processor.
- Duplicate requests receive the same payment/charge identifiers. `Idempotency-Replayed: true` marks a replay.

## Requirements

- Node.js 20+
- Docker Desktop (or a PostgreSQL 16 database)

## Run locally

```bash
npm install
cp .env.example .env
docker compose up -d
npm run db:generate
npm run db:migrate -- --name init
npm run dev
```

Health check: `GET http://localhost:3000/health`

## Try one charge

```bash
curl -i http://localhost:3000/charges \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-2026-0001' \
  -H 'x-merchant-id: demo-merchant' \
  -d '{"amount":129900,"currency":"INR"}'
```

Amount is in the smallest currency unit: `129900` means ₹1,299.00. Repeat the exact request with the same key; it returns the original charge. Change the amount but keep the key; it returns 409.

## Prove the concurrency guarantee

With the API running in one terminal, run this in another:

```bash
npm run test:concurrency
```

The script sends ten requests concurrently using `Promise.all`, then verifies the durable processor ledger contains exactly one charge for that idempotency key. Expected final line:

```text
PASS: 10 simultaneous requests produced exactly one charge.
```

## API contract

`POST /charges`

Headers:
- `Idempotency-Key`: required, 8–255 characters
- `x-merchant-id`: demo tenant identifier (replace with authenticated merchant identity)

Body:

```json
{ "amount": 129900, "currency": "INR" }
```

Responses:
- `201`: charge succeeded (first request or replay)
- `202`: original request is still processing after the wait window; retry with the same key
- `400`: invalid header/body
- `402`: simulated processor failure
- `409`: same key used with a different request payload
- `503`: transient inability to read idempotency state

## Deployment note: Streamlit

Streamlit is a Python UI hosting framework; it does not natively run this Node.js/Express API as its backend service. Since this project intentionally has no generalized UI, deploy this API to Render, Railway, Fly.io, or a Node-capable host, and use managed PostgreSQL. Streamlit can be added separately as a thin Python demo client if you specifically need a Streamlit URL, but it should not host the payment API itself.

For Render/Railway deployment:
1. Provision PostgreSQL and set `DATABASE_URL`.
2. Set build command: `npm install && npm run db:generate && npm run build`.
3. Set start command: `npm run db:deploy && npm start`.
4. Set `PORT` if required by the host.

## Production hardening before real money

This is an educational reference implementation, not a PCI-compliant payment service. Before handling real payments:
- Replace demo merchant header with authenticated API keys/JWT and derive merchant ID from verified credentials.
- Replace the mock processor with an official Stripe/Razorpay SDK and pass a stable provider idempotency key on every retry.
- Do not mark ambiguous network timeouts as final failures. Keep them reconcilable and use provider webhooks/reconciliation jobs.
- Add request signing, rate limits, structured logs, audit trails, secrets management, monitoring, retention policy, and integration tests.
- Store amounts as integer minor units; never use floating-point money.
- Add a durable outbox/reconciliation workflow if payment side effects expand beyond the processor call.

## Why the unique constraint matters

A naïve `SELECT` then `INSERT` has a race: ten requests can all observe “key absent” before any inserts. The database unique constraint serializes the claim. Exactly-once external charging still depends on the processor's own idempotency guarantee; no local database can atomically commit a transaction with an unrelated payment provider.
