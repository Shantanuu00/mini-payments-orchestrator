# Invariants (V1)

These are rules that must hold under retries, timeouts, duplicate requests, and repeated webhooks.

## Safety (nothing bad ever happens)

INV-S1 — No double charge:
For a given payment_id, there must be at most one successful provider attempt across all connectors.

INV-S2 — Idempotent confirm:
For a given (merchant_id, idempotency_key), confirm must return the same result and must not cause a second external charge.

INV-S3 — Terminal states do not regress:
Once a payment enters a terminal state (succeeded, failed, manual_review), it must not transition back to a non-terminal state.

INV-S4 — Amount/currency immutability:
A payment’s amount and currency are immutable after creation; all attempts must match the payment’s amount/currency.

INV-S5 — Webhook processing is idempotent:
Processing the same provider webhook event multiple times must not change the final outcome after the first successful processing.

## Liveness (something good eventually happens)

INV-L1 — Processing must resolve:
A payment in processing must eventually transition to succeeded/failed/manual_review within a defined SLA window.

INV-L2 — Merchant notification completes:
A merchant webhook event must be retried until delivered or until a max retry threshold is reached, after which it is marked failed for delivery.

INV-L3 — Jobs are not lost:
Once a webhook delivery job is created, it must eventually be attempted (crash/restart should not drop it).

INV-L4 — Stale unknown handling:
If a payment remains unknown beyond the SLA window (e.g., 24 hours), it must be moved to manual_review (or failed) and flagged for investigation.

## Auditability (we can always explain what happened)

INV-A1 — Attempt audit trail:
Every provider interaction must produce a persistent attempt record with timestamps, connector name, and outcome.

INV-A2 — Correlation identifiers exist:
Each payment and attempt must have correlation identifiers that connect logs ↔ DB ↔ provider references (payment_id, attempt_id, request_id, provider_ref).

INV-A3 — Evidence is retained:
Webhook events received from providers must be recorded (at least event_id + received_at + type + linked payment_id). Payload may be stored/redacted.

INV-A4 — Finalization evidence:
When a payment becomes terminal, it must store finalized_at and either:
- succeeded: provider_ref + successful attempt_id
- failed/manual_review: failure_reason (code/message) + last attempt_id
