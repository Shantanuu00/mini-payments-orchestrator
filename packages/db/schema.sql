-- Enums
DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('created','processing','succeeded','failed','manual_review');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE attempt_status AS ENUM ('started','succeeded','failed','unknown');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE webhook_processing_status AS ENUM ('received','processed','ignored','failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE merchant_webhook_delivery_status AS ENUM ('pending','delivering','delivered','failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 1) payments (source of truth)
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  status payment_status NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ NULL,
  latest_attempt_id UUID NULL,
  succeeded_attempt_id UUID NULL,
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  processing_deadline_at TIMESTAMPTZ NULL,
  idempotency_key_last TEXT NULL
);

-- 2) payment_attempts (audit trail)
CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'confirm',
  status attempt_status NOT NULL DEFAULT 'started',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_payment_id TEXT NULL,
  request_id TEXT NULL,
  idempotency_key TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  request_snapshot JSONB NULL,
  response_snapshot JSONB NULL
);

-- 3) idempotency_keys (merchant request dedupe)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  response_snapshot JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4) provider_webhook_events (incoming provider events)
CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id UUID PRIMARY KEY,
  connector TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_payment_id TEXT NULL,
  payment_id UUID NULL REFERENCES payments(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  processing_status webhook_processing_status NOT NULL DEFAULT 'received',
  payload_snapshot JSONB NULL
);

-- 5) merchant_webhook_deliveries (outgoing merchant notifications)
CREATE TABLE IF NOT EXISTS merchant_webhook_deliveries (
  id UUID PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  payload_snapshot JSONB NULL,
  status merchant_webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NULL,
  last_attempt_at TIMESTAMPTZ NULL,
  delivered_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- payment FK backrefs after attempts table exists
DO $$ BEGIN
  ALTER TABLE payments
    ADD CONSTRAINT fk_payments_latest_attempt
      FOREIGN KEY (latest_attempt_id) REFERENCES payment_attempts(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE payments
    ADD CONSTRAINT fk_payments_succeeded_attempt
      FOREIGN KEY (succeeded_attempt_id) REFERENCES payment_attempts(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Invariants / uniqueness constraints
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_success_attempt_per_payment
  ON payment_attempts (payment_id)
  WHERE status = 'succeeded';

CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_merchant_key
  ON idempotency_keys (merchant_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_webhook_connector_event
  ON provider_webhook_events (connector, provider_event_id);

-- Common query indexes
CREATE INDEX IF NOT EXISTS idx_payments_merchant_created
  ON payments (merchant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attempts_payment_created
  ON payment_attempts (payment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_merchant_webhook_deliveries_status_retry
  ON merchant_webhook_deliveries (status, next_retry_at);

-- Additional helpful indexes from model
CREATE INDEX IF NOT EXISTS idx_payments_status_deadline
  ON payments (status, processing_deadline_at);

CREATE INDEX IF NOT EXISTS idx_attempts_connector_provider_payment
  ON payment_attempts (connector, provider_payment_id);
