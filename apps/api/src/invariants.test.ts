import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "./index.js";
import { closePool, initSchema, pool } from "@pkg/db";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const testDb = hasDatabase ? test : test.skip;

const app = buildApp();

before(async () => {
  if (!hasDatabase) return;
  await initSchema();
});

beforeEach(async () => {
  if (!hasDatabase) return;
  await pool.query(
    "TRUNCATE TABLE merchant_webhook_deliveries, provider_webhook_events, idempotency_keys, payment_attempts, payments RESTART IDENTITY CASCADE",
  );
});

after(async () => {
  await app.close();
  if (hasDatabase) {
    await closePool();
  }
});

async function createPayment(merchantId: string) {
  const response = await app.inject({
    method: "POST",
    url: "/payments",
    payload: { merchantId, amount: 1200, currency: "USD" },
  });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string };
}

testDb("confirm idempotency replay returns same response and does not create extra attempts", async () => {
  const merchantId = `m_${randomUUID()}`;
  const { id: paymentId } = await createPayment(merchantId);

  const idempotencyKey = `idem_${randomUUID()}`;
  const payload = { merchantId, connector: "mock", idempotencyKey };

  const firstConfirm = await app.inject({
    method: "POST",
    url: `/payments/${paymentId}/confirm`,
    payload,
  });
  const secondConfirm = await app.inject({
    method: "POST",
    url: `/payments/${paymentId}/confirm`,
    payload,
  });

  assert.equal(firstConfirm.statusCode, 200);
  assert.equal(secondConfirm.statusCode, 200);
  assert.deepEqual(secondConfirm.json(), firstConfirm.json());

  const paymentDetails = await app.inject({ method: "GET", url: `/payments/${paymentId}` });
  assert.equal(paymentDetails.statusCode, 200);
  const paymentJson = paymentDetails.json() as { attempts: unknown[] };
  assert.equal(paymentJson.attempts.length, 1);
});

testDb("webhook dedupe does not create duplicate event processing and state is stable", async () => {
  const merchantId = `m_${randomUUID()}`;
  const { id: paymentId } = await createPayment(merchantId);

  const confirm = await app.inject({
    method: "POST",
    url: `/payments/${paymentId}/confirm`,
    payload: { merchantId, connector: "mock", idempotencyKey: `idem_${randomUUID()}` },
  });
  assert.equal(confirm.statusCode, 200);

  const details = await app.inject({ method: "GET", url: `/payments/${paymentId}` });
  const detailsJson = details.json() as {
    payment: { status: string };
    attempts: Array<{ provider_payment_id: string | null }>;
  };
  const providerPaymentId = detailsJson.attempts[0]?.provider_payment_id;
  assert.ok(providerPaymentId);

  const providerEventId = `evt_${randomUUID()}`;
  const webhookPayload = {
    providerEventId,
    providerPaymentId,
    eventType: "payment.succeeded",
    outcome: "succeeded",
  };

  const firstWebhook = await app.inject({
    method: "POST",
    url: "/webhooks/mock",
    payload: webhookPayload,
  });
  assert.equal(firstWebhook.statusCode, 200);

  const afterFirst = await app.inject({ method: "GET", url: `/payments/${paymentId}` });
  const statusAfterFirst = (afterFirst.json() as { payment: { status: string } }).payment.status;

  const secondWebhook = await app.inject({
    method: "POST",
    url: "/webhooks/mock",
    payload: webhookPayload,
  });
  assert.equal(secondWebhook.statusCode, 200);
  const secondWebhookJson = secondWebhook.json() as { deduped?: boolean };
  assert.equal(secondWebhookJson.deduped, true);

  const afterSecond = await app.inject({ method: "GET", url: `/payments/${paymentId}` });
  const statusAfterSecond = (afterSecond.json() as { payment: { status: string } }).payment.status;
  assert.equal(statusAfterSecond, statusAfterFirst);

  const rowCount = await pool.query(
    "SELECT COUNT(*)::int AS count FROM provider_webhook_events WHERE connector = $1 AND provider_event_id = $2",
    ["mock", providerEventId],
  );
  assert.equal(rowCount.rows[0].count, 1);
});

testDb("terminal non-regression: succeeded payment remains succeeded when conflicting webhook arrives", async () => {
  const merchantId = `m_${randomUUID()}`;
  const { id: paymentId } = await createPayment(merchantId);

  const providerPaymentId = `prov_${randomUUID()}`;
  const attemptId = randomUUID();

  await pool.query(
    `INSERT INTO payment_attempts (id, payment_id, merchant_id, connector, status, provider_payment_id)
     VALUES ($1, $2, $3, 'mock', 'unknown', $4)`,
    [attemptId, paymentId, merchantId, providerPaymentId],
  );

  await pool.query(
    `UPDATE payments
     SET status = 'succeeded', succeeded_attempt_id = $1, latest_attempt_id = $1, finalized_at = now(), updated_at = now()
     WHERE id = $2`,
    [attemptId, paymentId],
  );

  const webhook = await app.inject({
    method: "POST",
    url: "/webhooks/mock",
    payload: {
      providerEventId: `evt_${randomUUID()}`,
      providerPaymentId,
      eventType: "payment.failed",
      outcome: "failed",
      errorCode: "DECLINED",
      errorMessage: "Should not regress",
    },
  });

  assert.equal(webhook.statusCode, 200);

  const details = await app.inject({ method: "GET", url: `/payments/${paymentId}` });
  const status = (details.json() as { payment: { status: string } }).payment.status;
  assert.equal(status, "succeeded");
});

testDb("db constraint prevents two succeeded attempts for same payment", async () => {
  const merchantId = `m_${randomUUID()}`;
  const { id: paymentId } = await createPayment(merchantId);

  await pool.query(
    `INSERT INTO payment_attempts (id, payment_id, merchant_id, connector, status, provider_payment_id)
     VALUES ($1, $2, $3, 'mock', 'succeeded', $4)`,
    [randomUUID(), paymentId, merchantId, `prov_${randomUUID()}`],
  );

  await assert.rejects(async () => {
    await pool.query(
      `INSERT INTO payment_attempts (id, payment_id, merchant_id, connector, status, provider_payment_id)
       VALUES ($1, $2, $3, 'mock', 'succeeded', $4)`,
      [randomUUID(), paymentId, merchantId, `prov_${randomUUID()}`],
    );
  });
});
