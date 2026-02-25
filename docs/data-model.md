# Data Model (V1) — Mini Payment Orchestrator

This data model is designed to enforce the system invariants:
- Safety: no double charge, idempotent confirm, terminal states don't regress
- Liveness: processing resolves or is escalated
- Auditability: every attempt and webhook is traceable and correlatable

## Entities

### 1) payments (source of truth)
Represents a merchant-facing "payment intent" and its canonical state.

**Fields**
- id (uuid, PK)
- merchant_id (string/uuid, indexed)
- amount (integer, smallest currency unit; immutable)
- currency (string; immutable)
- status (enum: created | processing | succeeded | failed | manual_review)
- created_at (timestamp)
- updated_at (timestamp)
- finalized_at (timestamp, nullable)
- latest_attempt_id (uuid, nullable, FK -> payment_attempts.id)
- succeeded_attempt_id (uuid, nullable, FK -> payment_attempts.id)
- failure_code (string, nullable)
- failure_message (string, nullable)
- processing_deadline_at (timestamp, nullable)  # e.g., now + 15 minutes
- idempotency_key_last (string, nullable)      # convenience/debug only

**Notes**
- amount/currency must never change after creation.
- terminal state requires finalized_at to be set.

**Indexes**
- (merchant_id, created_at)
- (status, processing_deadline_at)

---

### 2) payment_attempts (audit trail of provider interactions)
Every time we try a gateway/provider action, we create an attempt row.
This is the immutable timeline of "what we tried".

**Fields**
- id (uuid, PK)
- payment_id (uuid, FK -> payments.id, indexed)
- merchant_id (same as payments.merchant_id, indexed)  # denormalized for faster queries
- connector (string; e.g., "stripe", "razorpay", "mock")
- operation (enum: authorize | capture | confirm)  # V1 can just use confirm
- status (enum: started | succeeded | failed | unknown)
- created_at (timestamp)
- updated_at (timestamp)

**Provider correlation**
- provider_payment_id (string, nullable)   # gateway charge/payment reference
- request_id (string, nullable)            # internal correlation id for logs
- idempotency_key (string, nullable)       # what we used when calling provider
- error_code (string, nullable)
- error_message (string, nullable)

**Optional evidence (keep minimal in V1)**
- request_snapshot (json, nullable; sanitized)
- response_snapshot (json, nullable; sanitized)

**Notes**
- Attempts are append-only records. We do not delete attempts.
- If we get a timeout/500, attempt.status becomes `unknown` and payment.status becomes `processing`.

**Indexes**
- (payment_id, created_at)
- (connector, provider_payment_id)  # helps reconciliation from webhook/provider IDs

---

### 3) idempotency_keys (dedupe repeated merchant requests)
Guarantees idempotent behavior for merchant "confirm" requests.

**Fields**
- id (uuid, PK)
- merchant_id (string/uuid, indexed)
- key (string, indexed)
- request_hash (string)                 # hash of normalized request (payment_id, amount, etc.)
- payment_id (uuid, FK -> payments.id)
- response_snapshot (json, nullable)    # what we returned for this key (status, ids)
- created_at (timestamp)
- updated_at (timestamp)

**Constraints**
- UNIQUE (merchant_id, key)

**Notes**
- On repeated calls with same (merchant_id, key), return stored response_snapshot.
- If same key is reused with a different request_hash, return 409 conflict (client misuse).

---

### 4) provider_webhook_events (incoming events from gateways)
Stores provider webhooks to ensure:
- idempotent processing (webhooks can arrive multiple times)
- auditability (what did provider tell us)

**Fields**
- id (uuid, PK)
- connector (string)
- provider_event_id (string)             # unique event id from provider (if available)
- provider_payment_id (string, nullable) # maps to payment_attempts.provider_payment_id
- payment_id (uuid, nullable, FK -> payments.id)  # may be filled after correlation
- event_type (string)                    # e.g., payment.succeeded
- received_at (timestamp)
- processed_at (timestamp, nullable)
- processing_status (enum: received | processed | ignored | failed)
- payload_snapshot (json, nullable; sanitized/redacted)

**Constraints**
- UNIQUE (connector, provider_event_id)

**Notes**
- The webhook handler should be idempotent:
  If event already exists, do not re-apply side effects.

---

### 5) merchant_webhook_deliveries (outgoing notifications to merchant)
Your system notifies merchant backend about status changes.
This requires retries (liveness).

**Fields**
- id (uuid, PK)
- merchant_id (string/uuid, indexed)
- payment_id (uuid, FK -> payments.id, indexed)
- event_type (string)                    # e.g., payment.succeeded
- destination_url (string)
- payload_snapshot (json, nullable)
- status (enum: pending | delivering | delivered | failed)
- attempt_count (int, default 0)
- next_retry_at (timestamp, nullable)
- last_attempt_at (timestamp, nullable)
- delivered_at (timestamp, nullable)
- last_error (string, nullable)
- created_at (timestamp)

**Notes**
- Delivery is at-least-once; merchant should also be able to dedupe using event ids.
- Use exponential backoff via next_retry_at.

---

## Relationships (Summary)
- payments 1—N payment_attempts
- payments 1—N provider_webhook_events (after correlation)
- payments 1—N merchant_webhook_deliveries
- idempotency_keys N—1 payments
- provider_webhook_events correlate to payment_attempts using (connector + provider_payment_id) or metadata

## Minimal V1 Guarantees Enabled by This Model
- No double charge: at most one succeeded_attempt_id per payment.
- Idempotent confirm: UNIQUE (merchant_id, key) + response snapshot.
- Unknown state handling: attempts can be `unknown`; payments can be `processing` with a deadline.
- Auditability: attempts + webhooks stored with correlation ids.
- Liveness: webhook deliveries tracked with retries.