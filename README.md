# Mini Payment Orchestrator (Hyperswitch-inspired)

A production-grade backend engineering project inspired by Hyperswitch, built as a focused monorepo to demonstrate reliable payment orchestration patterns.

## Overview

This project models a modern payment orchestration platform with:

- **Unified payment API** for creating, confirming, and tracking payments.
- **Multiple gateway orchestration** through connector-based confirmation and webhook handling.
- **Idempotent confirms** to prevent duplicate charge attempts during retries.
- **Webhook reconciliation** for at-least-once provider events.
- **Processing deadlines** to avoid payments being stuck in indeterminate states.
- **Merchant webhook retries** with backoff for resilient outbound notifications.

It is designed as a practical, engineering-focused system demonstrating production reliability concerns in payments.

## Architecture

### Components

- `apps/api` — Fastify Router API
  - Merchant-facing payment APIs
  - Connector confirm path + provider webhook ingestion
  - Idempotency and reconciliation behavior
- `apps/web` — Next.js dashboard
  - Demo UI for payment lifecycle and reliability scenarios
- `apps/worker` — background reliability engine
  - Processing deadline sweeps
  - Merchant delivery retry loop
- `packages/core` — state machine + invariants
  - Payment transitions and safety rules
- `packages/db` — schema + constraints
  - Postgres tables, indexes, and integrity constraints

**Postgres is the source of truth** for canonical payment state, attempt history, idempotency keys, provider webhook events, and merchant delivery logs.

### Diagram

```text
Merchant → API → DB
                 ↓
             Worker
                 ↓
           Merchant Webhook
```

## Key Engineering Features

### Idempotency

- Confirm idempotency keys per merchant request.
- Request hash validation to reject key reuse with different payloads.
- Response replay for safe retry semantics.

### State Machine Safety

- Terminal states (`succeeded`, `failed`, `manual_review`) do not regress.
- Controlled transitions through `applyPaymentTransition`.

### Reliability

- Processing deadline enforcement.
- Worker escalation from `processing` to `manual_review` when SLA expires.

### Webhooks

- Provider webhook dedupe on `(connector, provider_event_id)`.
- Merchant webhook retries with delivery state tracking.
- Exponential backoff scheduling for transient failures.

### Auditability

- Full attempt timeline per payment.
- Provider reference persistence (`provider_payment_id`, event IDs).
- Merchant delivery logs with attempts and errors.

## Demo Scenarios

Use the dashboard to demonstrate:

1. **Duplicate Confirm Replay**
   - Same idempotency key, repeated confirm, same response, no extra attempt.
2. **Webhook Dedupe**
   - Same provider event sent twice, second call treated as dedupe/no-op.
3. **Processing → Manual Review**
   - Worker escalates expired processing payments.
4. **Merchant Delivery Retries**
   - Outbound delivery retries with increasing backoff and terminal failure state.

## API Endpoints

- `POST /payments`
- `POST /payments/{id}/confirm`
- `GET /payments/{id}`
- `POST /webhooks/{connector}`
- `GET /deliveries?payment_id=`

## Running Locally

1. Install dependencies:

```bash
npm install
```

2. Set database URL:

```bash
export DATABASE_URL='postgres://postgres:postgres@localhost:5432/mini_payments'
```

3. Run services:

```bash
npm run dev:api
npm run dev:web
npm run worker:dev
```

(Optionally apply schema first with `npm run db:apply -w packages/db`.)

## Tests

Run all workspace tests:

```bash
npm run test --workspaces
```

The suite includes invariant-focused tests (API + DB-backed paths) for idempotency replay, webhook dedupe behavior, terminal non-regression, and DB uniqueness guarantees.

## Deployment

Suggested cloud setup:

- **Neon** for Postgres
- **Render** for API + Worker services
- **Vercel** for Web dashboard

Use environment wiring:

- API: `DATABASE_URL`, `PORT`
- Worker: `DATABASE_URL`, `MERCHANT_WEBHOOK_URL`
- Web: `NEXT_PUBLIC_API_BASE_URL`

## Resume Value

This project demonstrates practical backend engineering skills in:

- payment systems reliability
- distributed idempotency design
- webhook/event-driven reconciliation
- state machine modeling and invariants
- background job retry orchestration
- SQL schema design with safety constraints
- full-stack observability and demoability

## Screenshots

- Dashboard _(placeholder)_
- Payment Timeline _(placeholder)_
- Delivery Log _(placeholder)_
