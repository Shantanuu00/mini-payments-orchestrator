# Architecture — Mini Payment Orchestrator (Hyperswitch-inspired)

## Purpose
Provide a unified, reliable payments layer for merchants that:
- Prevents double charges (safety)
- Eventually resolves “processing/unknown” outcomes (liveness)
- Records an auditable history of every provider interaction (auditability)

This system does **not** integrate with banks directly. It orchestrates *payment providers/gateways* via connectors.

---

## Scope (V1)
### In scope
- Unified merchant-facing API to create and confirm payments
- Connector abstraction (mock/flaky connectors for simulation)
- Payment state machine enforcing safe transitions
- Idempotency for confirm requests (replay same response on retries)
- Provider webhook ingestion with deduplication
- Background worker:
  - processing deadline enforcement → manual_review
  - merchant webhook delivery retries with exponential backoff
- Postgres as source of truth
- UI dashboard to demo flows + reliability scenarios

### Out of scope
- PCI/card storage
- Fraud/chargebacks
- Direct bank/card network integration
- Complex routing optimization (basic selection only)

---

## High-level components

### 1) API Service (`apps/api`)
Responsibilities:
- Exposes merchant-facing REST API:
  - `POST /payments`
  - `POST /payments/:id/confirm`
  - `GET /payments/:id`
  - `POST /webhooks/:connector`
  - `GET /deliveries?payment_id=...` (demo visibility)
- Validates requests (Zod)
- Enforces confirm idempotency
- Persists canonical payment state in Postgres
- Calls connector modules to execute a payment attempt
- Provides OpenAPI/Swagger docs at `/docs`

### 2) Worker Service (`apps/worker`)
Responsibilities:
- Liveness enforcement:
  - Finds payments stuck in `processing` beyond `processing_deadline_at`
  - Escalates them to `manual_review` via state machine transition
- Merchant webhook delivery:
  - Delivers terminal state notifications to merchant webhook URL
  - Retries failures with exponential backoff
  - Stores delivery attempts and last error for auditability

### 3) Web UI (`apps/web`)
Responsibilities:
- Recruiter-friendly demo dashboard:
  - Create payment
  - Confirm with connector + idempotency key
  - Replay confirm to prove idempotency
  - Simulate provider webhook resolution and dedupe
  - View payment timeline (attempts + webhook events)
  - View merchant delivery logs

### 4) Core Domain Package (`packages/core`)
Responsibilities:
- Contains the “business truth”:
  - Payment statuses
  - Transition events
  - `applyPaymentTransition()` enforcing allowed transitions
- Ensures terminal non-regression and controlled state evolution

### 5) DB Package (`packages/db`)
Responsibilities:
- Owns schema (`schema.sql`) + apply script
- Contains key DB constraints that enforce invariants:
  - Unique idempotency key per merchant
  - Webhook event dedupe unique keys
  - At most one succeeded attempt per payment (partial unique index)

### 6) Postgres (source of truth)
Role:
- Stores canonical payment state, attempts (audit trail), webhook logs, delivery jobs
- Guarantees consistency with constraints + transactions

---

## Core data model (conceptual)

### payments (canonical)
Represents the merchant’s payment intent and final state.

Key fields:
- `id` (payment_id)
- `merchant_id`
- `amount`, `currency` (immutable)
- `status`: created | processing | succeeded | failed | manual_review
- `processing_deadline_at` (used for liveness)
- `succeeded_attempt_id` (if succeeded)
- `latest_attempt_id` (last known provider attempt)

### payment_attempts (append-only audit trail)
Each call to a connector creates a new attempt record.

Key fields:
- `id` (attempt_id)
- `payment_id`
- `connector` (mock/flaky/etc)
- `status`: started | succeeded | failed | unknown
- `provider_payment_id` (provider reference for correlation)
- `error_code`, `error_message`
- timestamps

### idempotency_keys
Used to dedupe confirm requests.

Key fields:
- `merchant_id`
- `idempotency_key`
- `request_hash`
- `response_json`
Uniqueness:
- unique `(merchant_id, idempotency_key)`

### provider_webhook_events
Tracks provider webhook deliveries (at-least-once incoming).

Key fields:
- `connector`
- `provider_event_id`
- `provider_payment_id`
- `event_type` (succeeded/failed/etc)
Uniqueness:
- unique `(connector, provider_event_id)`

### merchant_webhook_deliveries
Jobs for outgoing merchant notifications.

Key fields:
- `payment_id`
- `event_type` (terminal update)
- `payload_json`
- `status`: pending | delivered | dead
- `attempt_count`
- `next_retry_at`
- `last_error`
- `delivered_at`

---

## State machine (business correctness)

### Terminal states
- `succeeded`, `failed`, `manual_review` are **terminal**
- Once terminal, state **must not regress** (no transitions out)

### Allowed transitions (V1)
- `created` → `succeeded` (sync provider success)
- `created` → `failed` (sync provider definite failure)
- `created` → `processing` (timeout/unknown outcome)
- `processing` → `succeeded` (provider webhook resolves)
- `processing` → `failed` (provider webhook resolves)
- `processing` → `manual_review` (deadline exceeded)

All transitions are applied through:
- `packages/core/applyPaymentTransition()`

---

## Key flows

## Flow A — Create Payment
1. Merchant calls `POST /payments` with amount/currency
2. API writes `payments` row with status `created`
3. Returns `payment_id`

Safety:
- amount/currency immutable after creation

---

## Flow B — Confirm Payment (idempotent)
1. Merchant calls `POST /payments/:id/confirm` with:
   - connector
   - idempotency key
2. API checks `idempotency_keys`:
   - If key exists:
     - If request_hash matches → return stored response (replay)
     - Else → 409 conflict (same key, different request)
3. API validates payment is not terminal
4. API inserts `payment_attempts` row (status started)
5. API calls connector
6. Connector outcomes:
   - Success → apply transition to `succeeded`
   - Definite fail → apply transition to `failed`
   - Timeout/unknown → apply transition to `processing` + set `processing_deadline_at`
7. API stores response snapshot in `idempotency_keys` and returns response

Safety:
- Confirm retries do not create additional charges
- Exactly-once is not assumed; system is designed for at-least-once with idempotency

---

## Flow C — Provider Webhook ingestion (dedupe + reconciliation)
1. Provider posts to `POST /webhooks/:connector`
2. API writes `provider_webhook_events` with unique `(connector, provider_event_id)`
   - If duplicate → treat as no-op (dedupe)
3. API correlates webhook to payment via `provider_payment_id` stored on attempts
4. If payment is `processing`, apply transition:
   - succeeded/failed based on webhook
5. Write updated payment state

Safety:
- Duplicate webhooks do not cause duplicate transitions
- Terminal state non-regression enforced

---

## Flow D — Worker: processing deadline (liveness)
1. Worker polls for payments:
   - status = processing AND deadline passed
2. Applies `processing_deadline_exceeded` transition
3. Updates payment to `manual_review`

Liveness:
- processing doesn’t hang forever
- escalates within SLA window

---

## Flow E — Merchant webhook delivery (retries)
1. When payment reaches terminal state, system ensures delivery job exists
2. Worker periodically picks pending jobs where `next_retry_at <= now`
3. Attempts HTTP POST to `MERCHANT_WEBHOOK_URL`
4. On 2xx: mark delivered
5. On failure/timeout:
   - increment attempt_count
   - compute exponential backoff
   - set next_retry_at
6. After max attempts: mark dead with last_error

Reliability:
- at-least-once delivery with idempotent consumer requirement on merchant side

---

## Observability & auditability
- payment_attempts provides a timeline of provider interactions
- provider_payment_id and provider_event_id are retained for traceability
- delivery logs show outbound retry history
- UI displays these timelines to support debugging and demo

---

## Tradeoffs (explicit)
- Postgres chosen for strong consistency and constraints
- At-least-once delivery assumed for webhooks; idempotency is required
- Worker uses polling (simple) rather than queue/stream (scalable later)
- Exactly-once is not promised; correctness is achieved via idempotency + dedupe + state machine

---

## Future improvements (V2 ideas)
- Connector routing rules (cost/success-rate based)
- Polling provider APIs for reconciliation
- Queue-based worker (Redis/Message broker)
- Multi-merchant auth keys and RBAC
- Metrics + tracing (Prometheus/OpenTelemetry)
