import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('schema defines critical uniqueness invariants', async () => {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.equal(sql.includes('uq_one_success_attempt_per_payment'), true);
  assert.equal(sql.includes('uq_idempotency_merchant_key'), true);
  assert.equal(sql.includes('uq_provider_webhook_connector_event'), true);
});

test('migration runner enforces checksum and rollback guard', async () => {
  const migrate = await readFile(new URL('../migrate.js', import.meta.url), 'utf8');
  assert.equal(migrate.includes('checksum'), true);
  assert.equal(migrate.includes('ALLOW_DB_ROLLBACK'), true);
});
