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

-- Payments (source of truth)
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  merchant_id TEXT NOT NULL,

  amount BIGINT NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,

  status payment_status NOT NULL DEFAULT 'created',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ NULL,

  processing_deadline_at TIMESTAMPTZ NULL,

  latest_attempt_id UUID NULL,
  succeeded_attempt_id UUID NULL,

  failure_code TEXT NULL,
  failure_message TEXT NULL,

  last_confirm_idempotency_key TEXT NULL,
  last_confirm_response JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_merchant_created
  ON payments (merchant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_status_deadline
  ON payments (status, processing_deadline_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_confirm_idempotency
  ON payments (merchant_id, last_confirm_idempotency_key)
  WHERE last_confirm_idempotency_key IS NOT NULL;

-- Attempts (audit trail)
CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL,

  connector TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'confirm',

  status attempt_status NOT NULL DEFAULT 'started',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  request_id TEXT NULL,
  idempotency_key TEXT NULL,

  provider_event_id TEXT NULL,
  provider_payment_id TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,

  request_snapshot JSONB NULL,
  response_snapshot JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_payment_created
  ON payment_attempts (payment_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_attempts_webhook_event
  ON payment_attempts (connector, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_success_attempt_per_payment
  ON payment_attempts (payment_id)
  WHERE status = 'succeeded';
