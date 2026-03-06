-- Baseline rollback (destructive; for non-production local/dev use)
DROP TABLE IF EXISTS merchant_webhook_receipts CASCADE;
DROP TABLE IF EXISTS merchant_webhook_deliveries CASCADE;
DROP TABLE IF EXISTS provider_webhook_events CASCADE;
DROP TABLE IF EXISTS idempotency_keys CASCADE;
DROP TABLE IF EXISTS payment_attempts CASCADE;
DROP TABLE IF EXISTS merchant_api_key_audit CASCADE;
DROP TABLE IF EXISTS merchant_api_keys CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TYPE IF EXISTS merchant_webhook_delivery_status CASCADE;
DROP TYPE IF EXISTS webhook_processing_status CASCADE;
DROP TYPE IF EXISTS attempt_status CASCADE;
DROP TYPE IF EXISTS payment_status CASCADE;
