# Architecture (V1) — Mini Payment Orchestrator

## Goal
Provide a unified API for merchants to confirm payments via multiple gateways while ensuring:
- Safety: no double charge, terminal states don't regress
- Liveness: processing resolves or is escalated
- Auditability: every provider interaction is traceable

## Non-goals (V1)
No PCI/card storage, no direct bank/network integration, no fraud/chargebacks.

---

## High-level components

### 1) Router API (apps/api)
**Responsibilities**
- Expose merchant-facing REST API:
  - POST /payments (create intent)
  - POST /payments/{id}/confirm (attempt charge)
  - GET /payments/{id} (status + attempts)
- Validate requests + auth (later: API keys)
- Enforce idempotency for confirm
- Persist state transitions in Postgres
- Call connector modules (Stripe/Razorpay/Mock)
- Emit events for async tasks (later)

### 2) Worker (future: apps/worker)
**Responsibilities**
- Retry outgoing merchant webhooks
- Reconcile "processing" payments (poll provider if needed)
- Run scheduled jobs (dead-letter, cleanup)

(V1 can ship without this; V2 adds it.)

### 3) Postgres (infra)
**Role**
- Source of truth for:
  - payments (canonical state)
  - payment_attempts (audit trail)
  - idempotency_keys
  - webhook event logs + delivery attempts (later)

### 4) Gateways (external dependencies)
- Stripe/Razorpay/etc (in V1: Mock + Flaky connectors)
- Provide API responses + asynchronous webhooks

---

## Data flow (Confirm Payment)

### Happy path (sync success)
1. Merchant calls POST /payments/{id}/confirm with idempotency key
2. Router checks idempotency_keys:
   - if seen: return stored response
3. Router reads payment; validates allowed transition
4. Router inserts payment_attempt (status=started)
5. Router calls connector (gateway)
6. On success:
   - update payment.status = succeeded
   - set succeeded_attempt_id + finalized_at
   - update attempt.status = succeeded
7. Return response

### Timeout/500 (unknown)
1..5 same as above
6. On timeout/500:
   - update payment.status = processing
   - set processing_deadline_at
   - update attempt.status = unknown
7. Return "processing" to merchant
8. Later: webhook/poll resolves to succeeded/failed (V2)

---

## Correctness mechanisms

### Idempotency
- Unique (merchant_id, idempotency_key)
- Store request_hash + response snapshot

### State machine
- Allowed transitions enforced in one module (packages/core)
- Terminal states never regress
- Use conditional updates to avoid race conditions:
  - update only if current status == expected

### Auditability
- Attempts are append-only
- Store correlation IDs (request_id, provider_payment_id)

---

## Scalability & tradeoffs (explicit)
- Start as a single Router service + Postgres.
- Add Worker when async retries/polling is introduced.
- Postgres is chosen as source of truth for consistency; Redis queue can be added later for throughput.
- Exactly-once is not guaranteed; system is designed for at-least-once with idempotent handlers.