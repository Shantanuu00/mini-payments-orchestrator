# State Machine (V1) — Mini Payment Orchestrator

This document defines the payment lifecycle states and allowed transitions.
It is derived from invariants:
- Safety: terminal states do not regress; at most one successful attempt
- Liveness: processing must resolve or be escalated
- Auditability: attempts + events explain transitions

---

## Payment Entity

### States

Non-terminal:
- created: Payment intent exists; no gateway attempt has been made yet.
- processing: Outcome is unknown / pending; awaiting webhook/poll/retry outcome.

Terminal:
- succeeded: Payment is finalized as successful (exactly one successful attempt recorded).
- failed: Payment is finalized as failed (no successful attempt exists).
- manual_review: Payment is finalized as "requires investigation" (system cannot decide automatically within SLA window).

> Note: `manual_review` is optional but recommended; if you prefer, you can collapse it into `failed` for V1 simplicity.

---

## Events (things that cause transitions)

Merchant-driven:
- payment_created
- confirm_requested

Gateway-driven (sync response):
- provider_sync_succeeded
- provider_sync_failed_definite
- provider_sync_unknown (timeout/5xx)

Gateway-driven (async webhook):
- provider_webhook_succeeded
- provider_webhook_failed

System-driven (timer/worker):
- processing_deadline_exceeded
- manual_resolution_applied (optional future admin action)

---

## Allowed Transitions

### From created
- created -> processing
  Trigger: confirm_requested AND provider_sync_unknown
  Side effects:
  - create payment_attempt(status=unknown)
  - set processing_deadline_at

- created -> succeeded
  Trigger: confirm_requested AND provider_sync_succeeded
  Side effects:
  - create payment_attempt(status=succeeded)
  - set succeeded_attempt_id, finalized_at

- created -> failed
  Trigger: confirm_requested AND provider_sync_failed_definite
  Side effects:
  - create payment_attempt(status=failed)
  - set failure_code/failure_message, finalized_at

---

### From processing
- processing -> succeeded
  Trigger: provider_webhook_succeeded (or provider_poll_succeeded in future)
  Guards:
  - no successful attempt already exists for this payment
  Side effects:
  - update/append attempt outcome (or create a new attempt record if needed)
  - set succeeded_attempt_id, finalized_at

- processing -> failed
  Trigger: provider_webhook_failed (or provider_poll_failed in future)
  Guards:
  - no successful attempt already exists for this payment
  Side effects:
  - set failure_code/failure_message, finalized_at

- processing -> manual_review
  Trigger: processing_deadline_exceeded (SLA exceeded; still unknown)
  Side effects:
  - set finalized_at (or reviewed_at)
  - attach reason = "deadline exceeded"

> Important: processing should not remain forever. If webhook/poll never arrives, we escalate.

---

### Terminal states (no regression)
- succeeded -> (no transitions)
- failed -> (no transitions)
- manual_review -> (no transitions)

Any attempt to transition out of a terminal state must be rejected.

---

## Idempotency Rules (API-level behavior)

### Confirm is idempotent (merchant retries)
- Repeated confirm requests with the same (merchant_id, idempotency_key) must return the same stored response.
- If payment is already in a terminal state, confirm must return that terminal state without calling a provider again.

---

## Webhook Rules (event-level behavior)

### Webhook events are at-least-once
- The same provider event may be delivered multiple times.
- Processing must be idempotent:
  - if (connector, provider_event_id) already processed, ignore.
- Webhook must never cause terminal state regression:
  - if payment is succeeded, ignore "failed" webhooks for that payment.
  - if payment is failed, ignore "processing" style updates.

---

## Concurrency / Race Safety (implementation notes)

To avoid races between:
- confirm endpoint
- webhook handler
- future worker

Use conditional updates (compare-and-swap style):
- Only update payment.status if current status is expected.

Example policy:
- processing -> succeeded only if current status = processing
- created -> succeeded only if current status = created

If update affects 0 rows, re-read payment and decide based on current status.

---

## Attempt Semantics (relationship to payment_attempts)
- A payment can have multiple attempts.
- At most one attempt may be marked succeeded for a given payment (enforced by invariant + DB constraint/policy).
- Attempts must be retained for auditability.

