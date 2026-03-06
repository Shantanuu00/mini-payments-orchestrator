# Mini Payment Orchestrator (Hyperswitch-inspired)

A production-inspired backend engineering project inspired by Hyperswitch, built as a focused monorepo to demonstrate reliable payment orchestration patterns.

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
- `POST /merchant-webhook/mock` (local receiver for worker delivery loop)
- `GET /merchant-webhook/receipts?payment_id=`
- `GET /metrics` (Prometheus-compatible counters)

## Running Locally

Secret rotation helper:

```bash
npm run rotate:webhook-secret -w apps/api
```


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

Use versioned migrations for setup:

```bash
npm run db:migrate -w packages/db
# non-production only rollback:
ALLOW_DB_ROLLBACK=true npm run db:rollback -w packages/db
# migration policy verification
npm run db:policy-check -w packages/db
```

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
- Worker: `DATABASE_URL`, `MERCHANT_WEBHOOK_URL` (optional; defaults to API local mock receiver), `WORKER_METRICS_PORT` (default `9464`)
- Web: `NEXT_PUBLIC_API_BASE_URL`

Security hardening env vars (recommended):

- API ingress provider webhooks: `PROVIDER_WEBHOOK_SHARED_TOKEN`
- API ingress provider webhook signing: `PROVIDER_WEBHOOK_SIGNING_SECRET` (supports comma-separated active secrets for rotation)
- API local merchant receiver auth: `MERCHANT_WEBHOOK_SHARED_TOKEN`
- API local merchant webhook signing: `MERCHANT_WEBHOOK_SIGNING_SECRET` (supports comma-separated active secrets for rotation)
- API merchant endpoints auth: `MERCHANT_API_KEY`
- Tenant context header: `x-merchant-id`
- Strict tenant auth mode: `STRICT_MERCHANT_AUTH=true` (default behavior)
- Admin key for key issuance/revocation endpoints: `ADMIN_CONTROL_KEY`
- `ADMIN_CONTROL_KEY` must be set for key-management endpoints to be available
- API request throttling per IP: `RATE_LIMIT_RPM` (default `120`)

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


## End-to-End Demo Flow

1. Start Postgres (or your own DB) and apply schema:

```bash
npm run db:apply -w packages/db
```

2. Run API and worker:

```bash
npm run dev:api
npm run worker:dev
```

3. Create and confirm a payment to reach a terminal status, then inspect:

```bash
curl -s -X POST http://localhost:8080/payments -H 'content-type: application/json' -d '{"merchantId":"m_demo","amount":1299,"currency":"USD"}'
# then call confirm and fetch deliveries/receipts
```

The worker will enqueue and deliver merchant webhooks to `POST /merchant-webhook/mock` by default, and API will store receipts in `merchant_webhook_receipts` for audit/demo purposes.


## Final Resume Readiness Checklist

Before calling this project final, ensure all checks pass in CI:

- Build succeeds across all workspaces
- Typecheck succeeds across all workspaces
- Lint succeeds across all workspaces
- Tests succeed across API/core/worker/web/db workspaces
- Local end-to-end flow is demonstrated with API + worker + Postgres


## Known Production Gaps

Before claiming full production-readiness, complete these hardening items:

- key rotation policy and secret-management lifecycle for webhook signature verification
- expand tenant authorization with managed key issuance APIs integrated into admin plane
- wire metrics/tracing to a production monitoring backend and dashboards
- enforce forward-only production migration policy in release process
- failure-injection and race-condition integration tests


## Operations Docs

- Runbook: `docs/operations/runbook.md`
- SLO/SLI: `docs/operations/slo.md`
- Alert thresholds: `docs/operations/alerts.md`
- Alert queries: `docs/operations/alert-queries.md`


## Observability Notes

- API exposes Prometheus-style counters at `GET /metrics`.
- Worker exposes Prometheus-style counters at `GET /metrics` on `WORKER_METRICS_PORT` (default `9464`).
- API propagates `x-trace-id` (or generates one) in responses and logs for request tracing.
- Alert thresholds and SLO targets are documented in `docs/operations/`.
- Prometheus can scrape API and worker metrics via `infra/prometheus.yml` and `infra/docker_compose.yml`.

Migration docs: `packages/db/migrations/001_initial.md`


### API test reliability note

If local environment has registry restrictions, run API tests in CI/network-allowed environments to validate `apps/api` test suite consistently.
