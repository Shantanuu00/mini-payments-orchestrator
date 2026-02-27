# Decision Log (V1) — Mini Payment Orchestrator

This document records key engineering decisions and tradeoffs for the V1 system.
Goal: make the system’s reasoning explicit, debuggable, and easy to evolve.

---

## ADR-001 — Use Postgres as the source of truth
**Decision:** Use Postgres as the canonical data store for payment state and audit history.

**Why:**
- Payments require strong consistency for correctness (state transitions, idempotency, no double charge).
- Relational constraints (unique keys, FKs) help enforce invariants.
- Auditability is easier when the history is stored durably in one place.

**Tradeoffs:**
- Higher write contention than purely event-stream approaches at extreme scale.
- Needs careful indexing and conditional updates for concurrency.

**Alternatives considered:**
- Redis as primary store (fast but not ideal as source of truth).
- Event sourcing only (powerful but heavier for V1 complexity).

---

## ADR-002 — Model payments as a state machine with terminal states
**Decision:** Payment lifecycle is explicitly modeled as states with allowed transitions. Terminal states do not regress.

**Why:**
- Prevents incorrect behavior during retries, timeouts, and out-of-order events.
- Makes correctness requirements testable (unit tests per transition).
- Mirrors real payment systems where “unknown” and async completion are common.

**Tradeoffs:**
- Requires upfront definition of transitions and guards.
- Adds structure compared to ad-hoc status updates, but reduces bugs long-term.

---

## ADR-003 — Use append-only payment_attempts for auditability
**Decision:** Every provider interaction creates (or updates minimally) an attempt record; attempts are retained and not deleted.

**Why:**
- Supports dispute/debug workflows: “what happened, when, and why?”
- Enables enforcement/verification of “at most one successful attempt”.
- Separates “payment intent” from “attempts to execute it”.

**Tradeoffs:**
- More rows and storage than a single “latest attempt” model.
- Requires indexes for efficient query of recent attempts.

---

## ADR-004 — Enforce idempotency at the API boundary using idempotency_keys
**Decision:** Confirm requests are idempotent using a unique (merchant_id, idempotency_key) record storing request_hash and response snapshot.

**Why:**
- Retries and duplicate requests are expected in real systems.
- Prevents duplicate external effects (double charge) and provides consistent client responses.
- Allows safe client retry after timeouts without re-executing the charge.

**Tradeoffs:**
- Must manage retention/TTL policy for idempotency records (future).
- Must handle key misuse (same key, different request) as a conflict.

---

## ADR-005 — Assume at-least-once delivery for webhooks and design idempotent handlers
**Decision:** Provider webhooks and merchant webhook deliveries are treated as at-least-once; handlers must be idempotent and deduplicate by event IDs.

**Why:**
- Gateways retry webhooks when they don’t receive 2xx responses.
- Duplicate/out-of-order events are normal; correctness requires dedupe and non-regression.
- Matches production reality and avoids fragile assumptions.

**Tradeoffs:**
- Requires storing webhook events (connector + provider_event_id uniqueness).
- Requires careful handling of ordering and terminal state rules.

---

## ADR-006 — V1 uses Mock/Flaky connectors before integrating real gateways
**Decision:** Build V1 behavior using a MockConnector and FlakyConnector to simulate success/failure/timeout, then add a real gateway integration later.

**Why:**
- Enables deterministic testing of invariants (unknown state, retries, duplicates).
- Avoids coupling early progress to external provider setup.
- Demonstrates production thinking even without real money movement.

**Tradeoffs:**
- Needs extra simulation code and scenarios.
- Real gateway integration still required for full realism (planned V2/V3).

---

## ADR-007 — Split responsibilities: Router API now, Worker later
**Decision:** Ship V1 with a single Router API; introduce a Worker service when async retries/polling are added.

**Why:**
- Keeps V1 simpler while retaining a clear path to production architecture.
- Worker is required for liveness features (retries, reconciliation), but can be staged.

**Tradeoffs:**
- Some “eventual completion” features are deferred to V2.
- Must ensure V1 still demonstrates core correctness for sync + basic async (later).