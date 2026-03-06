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


testDb("merchant webhook mock receiver stores receipts and can be queried", async () => {
  const merchantId = `m_${randomUUID()}`;
  const { id: paymentId } = await createPayment(merchantId);

  const post = await app.inject({
    method: "POST",
    url: "/merchant-webhook/mock",
    payload: {
      payment_id: paymentId,
      event_type: "payment.succeeded",
      payload: { payment_id: paymentId, status: "succeeded" },
    },
  });
  assert.equal(post.statusCode, 202);

  const receipts = await app.inject({
    method: "GET",
    url: `/merchant-webhook/receipts?payment_id=${paymentId}`,
  });
  assert.equal(receipts.statusCode, 200);

  const json = receipts.json() as { receipts: Array<{ payment_id: string; event_type: string }> };
  assert.equal(json.receipts.length, 1);
  assert.equal(json.receipts[0].payment_id, paymentId);
  assert.equal(json.receipts[0].event_type, "payment.succeeded");
});


testDb("concurrent confirms with same idempotency key remain single-attempt", async () => {
  const merchantId = `m_${randomUUID()}`;
  const { id: paymentId } = await createPayment(merchantId);

  const idempotencyKey = `idem_${randomUUID()}`;
  const payload = { merchantId, connector: "mock", idempotencyKey };

  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, payload }),
    app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, payload }),
  ]);

  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);

  const paymentDetails = await app.inject({ method: "GET", url: `/payments/${paymentId}` });
  const paymentJson = paymentDetails.json() as { attempts: unknown[] };
  assert.equal(paymentJson.attempts.length, 1);
});


testDb("admin can issue and revoke merchant api keys", async () => {
  const merchantId = `m_${randomUUID()}`;
  process.env.ADMIN_CONTROL_KEY = "admin_secret";

  const issue = await app.inject({
    method: "POST",
    url: `/merchants/${merchantId}/api-keys`,
    headers: { "x-admin-key": "admin_secret" },
    payload: { role: "operator", scopes: ["payments:write", "payments:read"] },
  });
  assert.equal(issue.statusCode, 201);
  const issued = issue.json() as { id: string; apiKey: string };
  assert.ok(issued.apiKey);

  const list = await app.inject({
    method: "GET",
    url: `/merchants/${merchantId}/api-keys`,
    headers: { "x-admin-key": "admin_secret" },
  });
  assert.equal(list.statusCode, 200);

  const revoke = await app.inject({
    method: "POST",
    url: `/merchants/${merchantId}/api-keys/${issued.id}/revoke`,
    headers: { "x-admin-key": "admin_secret" },
  });
  assert.equal(revoke.statusCode, 200);

  delete process.env.ADMIN_CONTROL_KEY;
});

testDb("tenant boundary blocks cross-merchant key usage", async () => {
  process.env.ADMIN_CONTROL_KEY = "admin_secret";
  process.env.STRICT_MERCHANT_AUTH = "true";

  const merchantA = `mA_${randomUUID()}`;
  const merchantB = `mB_${randomUUID()}`;

  const issue = await app.inject({
    method: "POST",
    url: `/merchants/${merchantA}/api-keys`,
    headers: { "x-admin-key": "admin_secret" },
    payload: { role: "operator", scopes: ["payments:write"] },
  });
  assert.equal(issue.statusCode, 201);
  const issued = issue.json() as { apiKey: string };

  const forbidden = await app.inject({
    method: "POST",
    url: "/payments",
    headers: { "x-api-key": issued.apiKey, "x-merchant-id": merchantB },
    payload: { merchantId: merchantB, amount: 100, currency: "USD" },
  });

  assert.equal(forbidden.statusCode, 403);

  delete process.env.ADMIN_CONTROL_KEY;
  delete process.env.STRICT_MERCHANT_AUTH;
});


testDb("parallel duplicate webhook events still persist single event row", async () => {
  const merchantId = `m_${randomUUID()}`;
  const { id: paymentId } = await createPayment(merchantId);

  const confirm = await app.inject({
    method: "POST",
    url: `/payments/${paymentId}/confirm`,
    payload: { merchantId, connector: "mock", idempotencyKey: `idem_${randomUUID()}` },
  });
  assert.equal(confirm.statusCode, 200);

  const details = await app.inject({ method: "GET", url: `/payments/${paymentId}` });
  const detailsJson = details.json() as { attempts: Array<{ provider_payment_id: string | null }> };
  const providerPaymentId = detailsJson.attempts[0]?.provider_payment_id;
  assert.ok(providerPaymentId);

  const providerEventId = `evt_${randomUUID()}`;
  const payload = {
    providerEventId,
    providerPaymentId,
    eventType: "payment.succeeded",
    outcome: "succeeded",
  };

  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: "/webhooks/mock", payload }),
    app.inject({ method: "POST", url: "/webhooks/mock", payload }),
  ]);

  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);

  const rowCount = await pool.query(
    "SELECT COUNT(*)::int AS count FROM provider_webhook_events WHERE connector = $1 AND provider_event_id = $2",
    ["mock", providerEventId],
  );
  assert.equal(rowCount.rows[0].count, 1);
});
