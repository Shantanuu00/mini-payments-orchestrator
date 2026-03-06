import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildApp, resetApiInMemoryStateForTests, validateProductionConfig } from "./index.js";

test("validateProductionConfig requires hardened settings in production", () => {
  const issues = validateProductionConfig({
    NODE_ENV: "production",
    STRICT_MERCHANT_AUTH: "false",
    RATE_LIMIT_RPM: "0",
  });

  assert.ok(issues.includes("STRICT_MERCHANT_AUTH must be enabled in production"));
  assert.ok(issues.includes("ADMIN_CONTROL_KEY is required in production"));
  assert.ok(issues.includes("PROVIDER_WEBHOOK_SIGNING_SECRET is required in production"));
  assert.ok(issues.includes("MERCHANT_WEBHOOK_SIGNING_SECRET is required in production"));
  assert.ok(issues.includes("RATE_LIMIT_RPM must be a positive number in production"));
});

test("validateProductionConfig returns no issues for compliant production config", () => {
  const issues = validateProductionConfig({
    NODE_ENV: "production",
    STRICT_MERCHANT_AUTH: "true",
    ADMIN_CONTROL_KEY: "admin_key",
    PROVIDER_WEBHOOK_SIGNING_SECRET: "provider_secret",
    MERCHANT_WEBHOOK_SIGNING_SECRET: "merchant_secret",
    RATE_LIMIT_RPM: "120",
  });

  assert.deepEqual(issues, []);
});

test("health endpoint", async () => {
  resetApiInMemoryStateForTests();
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  await app.close();
});

test("provider webhook rejects requests when shared token is configured and missing", async () => {
  resetApiInMemoryStateForTests();
  const app = buildApp();
  const previous = process.env.PROVIDER_WEBHOOK_SHARED_TOKEN;
  process.env.PROVIDER_WEBHOOK_SHARED_TOKEN = "secret_token";

  try {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/mock",
      payload: {
        providerEventId: "evt_1",
        providerPaymentId: "prov_1",
        eventType: "payment.succeeded",
        outcome: "succeeded",
      },
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "UNAUTHORIZED_WEBHOOK" });
  } finally {
    if (previous === undefined) {
      delete process.env.PROVIDER_WEBHOOK_SHARED_TOKEN;
    } else {
      process.env.PROVIDER_WEBHOOK_SHARED_TOKEN = previous;
    }
    await app.close();
  }
});

test("payments endpoint requires API key when MERCHANT_API_KEY is configured", async () => {
  resetApiInMemoryStateForTests();
  const app = buildApp();
  const previous = process.env.MERCHANT_API_KEY;
  const previousStrict = process.env.STRICT_MERCHANT_AUTH;
  process.env.MERCHANT_API_KEY = "merchant_secret";
  process.env.STRICT_MERCHANT_AUTH = "true";

  try {
    const unauthorized = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "x-merchant-id": "m1" },
      payload: { merchantId: "m1", amount: 100, currency: "USD" },
    });
    assert.equal(unauthorized.statusCode, 403);

    const authorized = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "x-api-key": "merchant_secret", "x-merchant-id": "m1" },
      payload: { merchantId: "m1", amount: 100, currency: "USD" },
    });
    assert.equal(authorized.statusCode, 201);
  } finally {
    if (previous === undefined) {
      delete process.env.MERCHANT_API_KEY;
    } else {
      process.env.MERCHANT_API_KEY = previous;
    }
    if (previousStrict === undefined) {
      delete process.env.STRICT_MERCHANT_AUTH;
    } else {
      process.env.STRICT_MERCHANT_AUTH = previousStrict;
    }
    await app.close();
  }
});

test("rate limiter returns 429 when request rate exceeds configured limit", async () => {
  resetApiInMemoryStateForTests();
  const app = buildApp();
  const previous = process.env.RATE_LIMIT_RPM;
  process.env.RATE_LIMIT_RPM = "1";

  try {
    const first = await app.inject({ method: "GET", url: "/health" });
    const second = await app.inject({ method: "GET", url: "/health" });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 429);
    assert.deepEqual(second.json(), { error: "RATE_LIMITED" });
  } finally {
    if (previous === undefined) {
      delete process.env.RATE_LIMIT_RPM;
    } else {
      process.env.RATE_LIMIT_RPM = previous;
    }
    await app.close();
  }
});

test("rejects invalid webhook signature when signing secret is configured", async () => {
  resetApiInMemoryStateForTests();
  const app = buildApp();
  const previous = process.env.PROVIDER_WEBHOOK_SIGNING_SECRET;
  process.env.PROVIDER_WEBHOOK_SIGNING_SECRET = "signing_secret";

  try {
    const payload = {
      providerEventId: "evt_2",
      providerPaymentId: "prov_2",
      eventType: "payment.succeeded",
      outcome: "succeeded",
    };

    const bad = await app.inject({
      method: "POST",
      url: "/webhooks/mock",
      headers: { "x-webhook-signature": "invalid" },
      payload,
    });
    assert.equal(bad.statusCode, 401);
    assert.deepEqual(bad.json(), { error: "INVALID_WEBHOOK_SIGNATURE" });

    const signature = createHash("sha256")
      .update(`signing_secret.${JSON.stringify(payload)}`)
      .digest("hex");
    const good = await app.inject({
      method: "POST",
      url: "/webhooks/mock",
      headers: { "x-webhook-signature": signature },
      payload,
    });
    assert.notEqual(good.statusCode, 401);
  } finally {
    if (previous === undefined) {
      delete process.env.PROVIDER_WEBHOOK_SIGNING_SECRET;
    } else {
      process.env.PROVIDER_WEBHOOK_SIGNING_SECRET = previous;
    }
    await app.close();
  }
});

test("accepts rotated webhook signing secrets via comma-separated env value", async () => {
  resetApiInMemoryStateForTests();
  const app = buildApp();
  const previous = process.env.PROVIDER_WEBHOOK_SIGNING_SECRET;
  process.env.PROVIDER_WEBHOOK_SIGNING_SECRET = "old_secret,new_secret";

  try {
    const payload = {
      providerEventId: "evt_3",
      providerPaymentId: "prov_3",
      eventType: "payment.succeeded",
      outcome: "succeeded",
    };

    const rotatedSignature = createHash("sha256")
      .update(`new_secret.${JSON.stringify(payload)}`)
      .digest("hex");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/mock",
      headers: { "x-webhook-signature": rotatedSignature },
      payload,
    });

    assert.notEqual(response.statusCode, 401);
  } finally {
    if (previous === undefined) {
      delete process.env.PROVIDER_WEBHOOK_SIGNING_SECRET;
    } else {
      process.env.PROVIDER_WEBHOOK_SIGNING_SECRET = previous;
    }
    await app.close();
  }
});

test("merchant routes require x-merchant-id header", async () => {
  resetApiInMemoryStateForTests();
  const app = buildApp();
  const previousStrict = process.env.STRICT_MERCHANT_AUTH;
  process.env.STRICT_MERCHANT_AUTH = "true";

  try {
    const response = await app.inject({
      method: "POST",
      url: "/payments",
      payload: { merchantId: "m1", amount: 100, currency: "USD" },
    });

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { error: "FORBIDDEN_MERCHANT_ACCESS" });
  } finally {
    if (previousStrict === undefined) {
      delete process.env.STRICT_MERCHANT_AUTH;
    } else {
      process.env.STRICT_MERCHANT_AUTH = previousStrict;
    }
    await app.close();
  }
});
