import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { applyPaymentTransition, type Payment } from "@pkg/core";
import { initSchema, pool, type AttemptRow, type PaymentRow } from "@pkg/db";

const createPaymentSchema = z.object({
  merchantId: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().length(3).transform((v) => v.toUpperCase()),
});

const confirmSchema = z.object({
  merchantId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  connector: z.string().min(1).default("mock"),
});

const webhookParamsSchema = z.object({ connector: z.string().min(1) });

const webhookBodySchema = z.object({
  providerEventId: z.string().min(1),
  providerPaymentId: z.string().min(1),
  eventType: z.string().min(1),
  outcome: z.enum(["succeeded", "failed"]),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  payload: z.unknown().optional(),
});

const paymentIdParamsSchema = z.object({ id: z.string().uuid() });
const deliveriesQuerySchema = z.object({ payment_id: z.string().uuid() });
const receiptQuerySchema = z.object({ payment_id: z.string().uuid().optional() });

const merchantWebhookMockSchema = z.object({
  payment_id: z.string().uuid().optional(),
  event_type: z.string().min(1).default("payment.event"),
  payload: z.unknown().optional(),
});

const createApiKeyBodySchema = z.object({
  role: z.enum(["admin", "operator", "viewer"]).default("operator"),
  scopes: z.array(z.string()).default([]),
  ttlDays: z.number().int().positive().max(365).optional(),
});

const apiKeyParamsSchema = z.object({
  merchantId: z.string().min(1),
  keyId: z.string().uuid(),
});

const merchantParamsSchema = z.object({ merchantId: z.string().min(1) });

const metrics = {
  api_requests_total: 0,
  api_rate_limited_total: 0,
  webhook_unauthorized_total: 0,
  webhook_invalid_signature_total: 0,
  merchant_auth_forbidden_total: 0,
  merchant_api_key_issued_total: 0,
  merchant_api_key_revoked_total: 0,
};

function toDomainPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    latestAttemptId: row.latest_attempt_id,
    succeededAttemptId: row.succeeded_attempt_id,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
  };
}

function buildRequestHash(input: object): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}



type HeaderValue = string | string[] | undefined;

function getConfiguredSecrets(envName: string): string[] {
  const raw = process.env[envName];
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const rateLimitWindowMs = 60_000;
const rateLimitCleanupWindowMs = 5 * 60_000;
const requestCounters = new Map<string, { count: number; windowStart: number }>();

function getHeaderValue(headers: Record<string, unknown>, name: string): HeaderValue {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return undefined;
}

function hasAdminControlKey(headers: Record<string, unknown>): boolean {
  const expected = process.env.ADMIN_CONTROL_KEY;
  if (!expected) return false;

  const value = getHeaderValue(headers, "x-admin-key");
  if (typeof value === "string") return secureEqual(value, expected);
  if (Array.isArray(value)) return value.some((v) => secureEqual(v, expected));
  return false;
}

function secureEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

function hasValidSharedToken(headers: Record<string, unknown>, secretEnvName: string): boolean {
  const expectedSecrets = getConfiguredSecrets(secretEnvName);
  if (expectedSecrets.length === 0) return true;

  const tokenHeader = getHeaderValue(headers, "x-webhook-token");
  if (typeof tokenHeader === "string") {
    return expectedSecrets.some((secret) => secureEqual(tokenHeader, secret));
  }
  if (Array.isArray(tokenHeader)) {
    return tokenHeader.some((token) => expectedSecrets.some((secret) => secureEqual(token, secret)));
  }
  return false;
}

function hasValidWebhookSignature(
  headers: Record<string, unknown>,
  body: unknown,
  secretEnvName: string,
): boolean {
  const secrets = getConfiguredSecrets(secretEnvName);
  if (secrets.length === 0) return true;

  const signatureHeader = getHeaderValue(headers, "x-webhook-signature");
  if (typeof signatureHeader !== "string") return false;

  const payload = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return secrets.some((secret) => {
    const expected = createHash("sha256").update(`${secret}.${payload}`).digest("hex");
    return secureEqual(signatureHeader, expected);
  });
}



type RequiredAccess = {
  merchantId: string;
  requiredScopes: string[];
};

function isStrictMerchantAuthEnabled(): boolean {
  const value = (process.env.STRICT_MERCHANT_AUTH ?? "true").toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  if ((env.NODE_ENV ?? "development") !== "production") return [];

  const issues: string[] = [];
  const strictAuth = (env.STRICT_MERCHANT_AUTH ?? "true").toLowerCase();
  if (!["true", "1", "yes"].includes(strictAuth)) {
    issues.push("STRICT_MERCHANT_AUTH must be enabled in production");
  }

  if (!env.ADMIN_CONTROL_KEY) {
    issues.push("ADMIN_CONTROL_KEY is required in production");
  }

  if (!env.PROVIDER_WEBHOOK_SIGNING_SECRET) {
    issues.push("PROVIDER_WEBHOOK_SIGNING_SECRET is required in production");
  }

  if (!env.MERCHANT_WEBHOOK_SIGNING_SECRET) {
    issues.push("MERCHANT_WEBHOOK_SIGNING_SECRET is required in production");
  }

  const rpm = Number(env.RATE_LIMIT_RPM ?? 120);
  if (!Number.isFinite(rpm) || rpm <= 0) {
    issues.push("RATE_LIMIT_RPM must be a positive number in production");
  }

  return issues;
}

function resolveRequiredAccess(method: string, url: string, headers: Record<string, unknown>): RequiredAccess | null {
  if (!url.startsWith('/payments') && !url.startsWith('/deliveries')) return null;

  const merchantIdHeader = getHeaderValue(headers, 'x-merchant-id');
  if (typeof merchantIdHeader !== 'string' || merchantIdHeader.trim().length === 0) {
    return { merchantId: '', requiredScopes: [] };
  }

  const merchantId = merchantIdHeader.trim();
  const upper = method.toUpperCase();
  if (url.startsWith('/deliveries')) {
    return { merchantId, requiredScopes: ['deliveries:read'] };
  }

  if (upper === 'GET') {
    return { merchantId, requiredScopes: ['payments:read'] };
  }

  return { merchantId, requiredScopes: ['payments:write'] };
}

async function hasAuthorizedMerchantAccess(
  headers: Record<string, unknown>,
  method: string,
  url: string,
): Promise<boolean> {
  const required = resolveRequiredAccess(method, url, headers);
  if (!required) return true;
  if (!required.merchantId) return isStrictMerchantAuthEnabled() ? false : true;

  const expected = process.env.MERCHANT_API_KEY;
  const apiKeyHeader = getHeaderValue(headers, 'x-api-key');

  if (expected) {
    if (typeof apiKeyHeader === 'string') {
      return secureEqual(apiKeyHeader, expected);
    }
    if (Array.isArray(apiKeyHeader)) {
      return apiKeyHeader.some((key) => secureEqual(key, expected));
    }
    return false;
  }

  if (typeof apiKeyHeader !== 'string' || apiKeyHeader.trim().length === 0) {
    return isStrictMerchantAuthEnabled() ? false : true;
  }

  const keyHash = createHash('sha256').update(apiKeyHeader).digest('hex');
  const result = await pool.query<{
    id: string;
    role: 'admin' | 'operator' | 'viewer';
    scopes: string[];
  }>(
    `SELECT id, role, scopes
     FROM merchant_api_keys
     WHERE merchant_id = $1
       AND key_hash = $2
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [required.merchantId, keyHash],
  );

  if (!result.rowCount) {
    await recordApiKeyAudit(required.merchantId, 'auth_failure', null, 'api_request', {
      method,
      url,
      reason: 'key_not_found_or_expired',
    });
    return false;
  }

  const row = result.rows[0];
  const scopes = row.scopes ?? [];
  const allowed = row.role === 'admin' || required.requiredScopes.every((scope) => scopes.includes(scope));

  await recordApiKeyAudit(required.merchantId, allowed ? 'auth_success' : 'auth_failure', row.id, 'api_request', {
    method,
    url,
    required_scopes: required.requiredScopes,
    role: row.role,
  });

  return allowed;
}


function cleanupRateLimitCounters(): void {
  const now = Date.now();
  for (const [key, value] of requestCounters.entries()) {
    if (now - value.windowStart >= rateLimitCleanupWindowMs) {
      requestCounters.delete(key);
    }
  }
}

function isWithinRateLimit(clientKey: string): boolean {
  const configuredRpm = Number(process.env.RATE_LIMIT_RPM ?? 120);
  if (!Number.isFinite(configuredRpm) || configuredRpm <= 0) return true;

  const now = Date.now();
  const current = requestCounters.get(clientKey);
  if (!current || now - current.windowStart >= rateLimitWindowMs) {
    requestCounters.set(clientKey, { count: 1, windowStart: now });
    return true;
  }

  if (current.count >= configuredRpm) {
    return false;
  }

  current.count += 1;
  return true;
}

async function recordApiKeyAudit(
  merchantId: string,
  action: "issued" | "revoked" | "auth_success" | "auth_failure",
  apiKeyId: string | null,
  actor: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO merchant_api_key_audit (id, merchant_id, api_key_id, actor, action, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), merchantId, apiKeyId, actor, action, JSON.stringify(metadata)],
  );
}

export function resetApiInMemoryStateForTests(): void {
  requestCounters.clear();
  metrics.api_requests_total = 0;
  metrics.api_rate_limited_total = 0;
  metrics.webhook_unauthorized_total = 0;
  metrics.webhook_invalid_signature_total = 0;
  metrics.merchant_auth_forbidden_total = 0;
  metrics.merchant_api_key_issued_total = 0;
  metrics.merchant_api_key_revoked_total = 0;
}

async function mockConnector(paymentId: string): Promise<{
  attemptStatus: "succeeded" | "failed" | "unknown";
  code?: string;
  message?: string;
  providerPaymentId: string;
}> {
  const score = paymentId.charCodeAt(0) % 3;
  if (score === 0) return { attemptStatus: "succeeded", providerPaymentId: `mock_${paymentId}` };
  if (score === 1) {
    return {
      attemptStatus: "failed",
      code: "DECLINED",
      message: "Card declined",
      providerPaymentId: `mock_${paymentId}`,
    };
  }
  return {
    attemptStatus: "unknown",
    code: "TIMEOUT",
    message: "Gateway timeout",
    providerPaymentId: `mock_${paymentId}`,
  };
}

export function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  app.register(cors, { origin: true });
  app.register(swagger, {
    openapi: {
      info: { title: "Mini Payment Orchestrator API", version: "0.1.0" },
    },
  });
  app.register(swaggerUI, { routePrefix: "/docs" });

  app.addHook("onRequest", async (request, reply) => {
    metrics.api_requests_total += 1;
    const incomingTrace = getHeaderValue(request.headers as Record<string, unknown>, "x-trace-id");
    const traceId = typeof incomingTrace === "string" ? incomingTrace : randomUUID();
    reply.header("x-trace-id", traceId);
    request.log.info({ request_id: request.id, trace_id: traceId, method: request.method, url: request.url }, "request_received");
  });

  app.addHook("preHandler", async (request, reply) => {
    const clientIp = request.ip ?? "unknown";
    if (!isWithinRateLimit(clientIp)) {
      metrics.api_rate_limited_total += 1;
      return reply.code(429).send({ error: "RATE_LIMITED" });
    }

    if (!await hasAuthorizedMerchantAccess(request.headers as Record<string, unknown>, request.method, request.url)) {
      metrics.merchant_auth_forbidden_total += 1;
      return reply.code(403).send({ error: "FORBIDDEN_MERCHANT_ACCESS" });
    }

    return undefined;
  });

  const rateLimitCleanupTimer = setInterval(cleanupRateLimitCounters, rateLimitCleanupWindowMs);
  app.addHook("onClose", async () => {
    clearInterval(rateLimitCleanupTimer);
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/metrics", async (_request, reply) => {
    const body = Object.entries(metrics)
      .map(([key, value]) => `${key} ${value}`)
      .join("\n");
    reply.header("content-type", "text/plain; version=0.0.4");
    return reply.send(`${body}\n`);
  });

  app.post("/payments", async (request, reply) => {
    const parsed = createPaymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    const id = randomUUID();
    const { merchantId, amount, currency } = parsed.data;

    await pool.query(
      `INSERT INTO payments (id, merchant_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, 'created')`,
      [id, merchantId, amount, currency],
    );

    return reply.code(201).send({ id, merchantId, amount, currency, status: "created" });
  });

  app.get("/payments/:id", async (request, reply) => {
    const params = paymentIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: params.error.flatten() });
    }

    const paymentResult = await pool.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [params.data.id]);
    if (!paymentResult.rowCount) {
      return reply.code(404).send({ error: "PAYMENT_NOT_FOUND" });
    }

    const attempts = await pool.query<AttemptRow>(
      "SELECT * FROM payment_attempts WHERE payment_id = $1 ORDER BY created_at DESC",
      [params.data.id],
    );

    return reply.send({ payment: paymentResult.rows[0], attempts: attempts.rows });
  });

  app.post("/payments/:id/confirm", async (request, reply) => {
    const params = paymentIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: params.error.flatten() });
    }

    const body = confirmSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: body.error.flatten() });
    }

    const paymentId = params.data.id;
    const { merchantId, idempotencyKey, connector } = body.data;
    const requestHash = buildRequestHash({ paymentId, merchantId, idempotencyKey, connector });

    await pool.query("BEGIN");
    try {
      const existingKey = await pool.query<{
        request_hash: string;
        response_snapshot: unknown;
      }>(
        `SELECT request_hash, response_snapshot
         FROM idempotency_keys
         WHERE merchant_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [merchantId, idempotencyKey],
      );

      if (existingKey.rowCount) {
        const row = existingKey.rows[0];
        if (row.request_hash !== requestHash) {
          await pool.query("ROLLBACK");
          return reply.code(409).send({ error: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
        }

        await pool.query("COMMIT");
        return reply.send(row.response_snapshot);
      }

      const paymentResult = await pool.query<PaymentRow>(
        `SELECT * FROM payments WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
        [paymentId, merchantId],
      );
      if (!paymentResult.rowCount) {
        await pool.query("ROLLBACK");
        return reply.code(404).send({ error: "PAYMENT_NOT_FOUND" });
      }

      const current = paymentResult.rows[0];

      if (current.status === "succeeded") {
        const response = {
          paymentId,
          status: "succeeded",
          attemptId: current.succeeded_attempt_id,
          reason: "Already succeeded",
        };

        await pool.query(
          `INSERT INTO idempotency_keys (id, merchant_id, idempotency_key, request_hash, payment_id, response_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), merchantId, idempotencyKey, requestHash, paymentId, JSON.stringify(response)],
        );

        await pool.query("COMMIT");
        return reply.send(response);
      }

      if (current.status === "failed" || current.status === "manual_review") {
        const response = {
          paymentId,
          status: current.status,
          attemptId: current.latest_attempt_id,
          reason: "Terminal payment cannot be reconfirmed",
        };

        await pool.query(
          `INSERT INTO idempotency_keys (id, merchant_id, idempotency_key, request_hash, payment_id, response_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), merchantId, idempotencyKey, requestHash, paymentId, JSON.stringify(response)],
        );

        await pool.query("COMMIT");
        return reply.send(response);
      }

      const attemptId = randomUUID();
      const connectorResult = await mockConnector(paymentId);

      await pool.query(
        `INSERT INTO payment_attempts (
          id, payment_id, merchant_id, connector, status, idempotency_key, provider_payment_id,
          error_code, error_message, request_snapshot, response_snapshot
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          attemptId,
          paymentId,
          merchantId,
          connector,
          connectorResult.attemptStatus,
          idempotencyKey,
          connectorResult.providerPaymentId,
          connectorResult.code ?? null,
          connectorResult.message ?? null,
          JSON.stringify(body.data),
          JSON.stringify(connectorResult),
        ],
      );

      const transition =
        connectorResult.attemptStatus === "succeeded"
          ? applyPaymentTransition(toDomainPayment(current), {
              type: "provider_sync_succeeded",
              attemptId,
            })
          : connectorResult.attemptStatus === "failed"
            ? applyPaymentTransition(toDomainPayment(current), {
                type: "provider_sync_failed_definite",
                attemptId,
                code: connectorResult.code ?? "UNKNOWN",
                message: connectorResult.message ?? "Unknown",
              })
            : applyPaymentTransition(toDomainPayment(current), {
                type: "provider_sync_unknown",
                attemptId,
              });

      if (!transition.ok) {
        await pool.query("ROLLBACK");
        return reply.code(409).send({ error: transition.error, reason: transition.reason });
      }

      const next = transition.payment;
      const processingDeadlineAt = next.status === "processing" ? new Date(Date.now() + 15 * 60 * 1000) : null;
      const response = {
        paymentId,
        status: next.status,
        attemptId,
        reason: "Confirmed",
      };

      await pool.query(
        `UPDATE payments
         SET status = $1,
             latest_attempt_id = $2,
             succeeded_attempt_id = $3,
             failure_code = $4,
             failure_message = $5,
             finalized_at = CASE WHEN $1 IN ('succeeded','failed','manual_review') THEN now() ELSE finalized_at END,
             processing_deadline_at = $6,
             idempotency_key_last = $7,
             updated_at = now()
         WHERE id = $8`,
        [
          next.status,
          next.latestAttemptId ?? null,
          next.succeededAttemptId ?? null,
          next.failureCode ?? null,
          next.failureMessage ?? null,
          processingDeadlineAt,
          idempotencyKey,
          paymentId,
        ],
      );

      await pool.query(
        `INSERT INTO idempotency_keys (id, merchant_id, idempotency_key, request_hash, payment_id, response_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), merchantId, idempotencyKey, requestHash, paymentId, JSON.stringify(response)],
      );

      await pool.query("COMMIT");
      return reply.send(response);
    } catch (error) {
      await pool.query("ROLLBACK");
      request.log.error({ request_id: request.id, err: error }, "confirm_failed");
      return reply.code(500).send({ error: "INTERNAL_ERROR" });
    }
  });


  app.get("/deliveries", async (request, reply) => {
    const parsed = deliveriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    const result = await pool.query(
      `SELECT * FROM merchant_webhook_deliveries WHERE payment_id = $1 ORDER BY created_at DESC`,
      [parsed.data.payment_id],
    );

    return reply.send({ deliveries: result.rows });
  });

  app.post("/merchant-webhook/mock", async (request, reply) => {
    if (!hasValidSharedToken(request.headers as Record<string, unknown>, "MERCHANT_WEBHOOK_SHARED_TOKEN")) {
      metrics.webhook_unauthorized_total += 1;
      return reply.code(401).send({ error: "UNAUTHORIZED_WEBHOOK" });
    }

    if (!hasValidWebhookSignature(request.headers as Record<string, unknown>, request.body, "MERCHANT_WEBHOOK_SIGNING_SECRET")) {
      metrics.webhook_invalid_signature_total += 1;
      return reply.code(401).send({ error: "INVALID_WEBHOOK_SIGNATURE" });
    }

    const parsed = merchantWebhookMockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    const payload = parsed.data.payload ?? request.body ?? {};
    await pool.query(
      `INSERT INTO merchant_webhook_receipts (id, payment_id, event_type, payload_snapshot)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), parsed.data.payment_id ?? null, parsed.data.event_type, JSON.stringify(payload)],
    );

    return reply.code(202).send({ accepted: true });
  });

  app.get("/merchant-webhook/receipts", async (request, reply) => {
    const parsed = receiptQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    const result = parsed.data.payment_id
      ? await pool.query(
          `SELECT * FROM merchant_webhook_receipts WHERE payment_id = $1 ORDER BY received_at DESC LIMIT 200`,
          [parsed.data.payment_id],
        )
      : await pool.query(`SELECT * FROM merchant_webhook_receipts ORDER BY received_at DESC LIMIT 200`);

    return reply.send({ receipts: result.rows });
  });

  app.get("/merchants/:merchantId/api-keys", async (request, reply) => {
    if (!process.env.ADMIN_CONTROL_KEY) {
      return reply.code(503).send({ error: "ADMIN_CONTROL_KEY_NOT_CONFIGURED" });
    }
    if (!hasAdminControlKey(request.headers as Record<string, unknown>)) {
      return reply.code(403).send({ error: "FORBIDDEN_ADMIN_KEY" });
    }

    const params = merchantParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: params.error.flatten() });
    }

    const result = await pool.query(
      `SELECT id, merchant_id, role, scopes, status, expires_at, created_at, revoked_at
       FROM merchant_api_keys
       WHERE merchant_id = $1
       ORDER BY created_at DESC`,
      [params.data.merchantId],
    );

    return reply.send({ keys: result.rows });
  });

  app.post("/merchants/:merchantId/api-keys", async (request, reply) => {
    if (!process.env.ADMIN_CONTROL_KEY) {
      return reply.code(503).send({ error: "ADMIN_CONTROL_KEY_NOT_CONFIGURED" });
    }
    if (!hasAdminControlKey(request.headers as Record<string, unknown>)) {
      return reply.code(403).send({ error: "FORBIDDEN_ADMIN_KEY" });
    }

    const params = merchantParamsSchema.safeParse(request.params);
    const body = createApiKeyBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        details: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }

    const plainApiKey = randomBytes(24).toString("hex");
    const keyHash = createHash("sha256").update(plainApiKey).digest("hex");
    const keyId = randomUUID();
    const expiresAt = body.data.ttlDays ? new Date(Date.now() + body.data.ttlDays * 24 * 60 * 60 * 1000) : null;

    await pool.query(
      `INSERT INTO merchant_api_keys (id, merchant_id, key_hash, role, scopes, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [keyId, params.data.merchantId, keyHash, body.data.role, body.data.scopes, expiresAt],
    );

    await recordApiKeyAudit(params.data.merchantId, "issued", keyId, "admin_control", {
      role: body.data.role,
      scopes: body.data.scopes,
      expires_at: expiresAt,
    });
    metrics.merchant_api_key_issued_total += 1;

    return reply.code(201).send({
      id: keyId,
      merchantId: params.data.merchantId,
      apiKey: plainApiKey,
      role: body.data.role,
      scopes: body.data.scopes,
      expiresAt,
    });
  });

  app.post("/merchants/:merchantId/api-keys/:keyId/revoke", async (request, reply) => {
    if (!process.env.ADMIN_CONTROL_KEY) {
      return reply.code(503).send({ error: "ADMIN_CONTROL_KEY_NOT_CONFIGURED" });
    }
    if (!hasAdminControlKey(request.headers as Record<string, unknown>)) {
      return reply.code(403).send({ error: "FORBIDDEN_ADMIN_KEY" });
    }

    const params = apiKeyParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: params.error.flatten() });
    }

    const result = await pool.query(
      `UPDATE merchant_api_keys
       SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND merchant_id = $2 AND status = 'active'
       RETURNING id`,
      [params.data.keyId, params.data.merchantId],
    );

    if (!result.rowCount) {
      return reply.code(404).send({ error: "API_KEY_NOT_FOUND" });
    }

    await recordApiKeyAudit(params.data.merchantId, "revoked", params.data.keyId, "admin_control", {});
    metrics.merchant_api_key_revoked_total += 1;
    return reply.send({ revoked: true, id: params.data.keyId });
  });

  app.post("/webhooks/:connector", async (request, reply) => {
    if (!hasValidSharedToken(request.headers as Record<string, unknown>, "PROVIDER_WEBHOOK_SHARED_TOKEN")) {
      metrics.webhook_unauthorized_total += 1;
      return reply.code(401).send({ error: "UNAUTHORIZED_WEBHOOK" });
    }

    if (!hasValidWebhookSignature(request.headers as Record<string, unknown>, request.body, "PROVIDER_WEBHOOK_SIGNING_SECRET")) {
      metrics.webhook_invalid_signature_total += 1;
      return reply.code(401).send({ error: "INVALID_WEBHOOK_SIGNATURE" });
    }

    const params = webhookParamsSchema.safeParse(request.params);
    const body = webhookBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        details: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }

    const { connector } = params.data;
    const event = body.data;

    const webhookInsert = await pool.query<{ id: string }>(
      `INSERT INTO provider_webhook_events (
        id, connector, provider_event_id, provider_payment_id, event_type, payload_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (connector, provider_event_id) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        connector,
        event.providerEventId,
        event.providerPaymentId,
        event.eventType,
        JSON.stringify(event.payload ?? event),
      ],
    );

    if (!webhookInsert.rowCount) {
      return reply.send({ deduped: true });
    }

    const attemptResult = await pool.query<AttemptRow>(
      `SELECT * FROM payment_attempts
       WHERE connector = $1 AND provider_payment_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [connector, event.providerPaymentId],
    );

    if (!attemptResult.rowCount) {
      await pool.query(
        `UPDATE provider_webhook_events
         SET processing_status = 'ignored', processed_at = now()
         WHERE connector = $1 AND provider_event_id = $2`,
        [connector, event.providerEventId],
      );
      return reply.send({ deduped: false, correlated: false });
    }

    const attempt = attemptResult.rows[0];

    await pool.query("BEGIN");
    try {
      const paymentResult = await pool.query<PaymentRow>(
        `SELECT * FROM payments WHERE id = $1 FOR UPDATE`,
        [attempt.payment_id],
      );
      if (!paymentResult.rowCount) {
        await pool.query(
          `UPDATE provider_webhook_events
           SET processing_status = 'ignored', processed_at = now()
           WHERE connector = $1 AND provider_event_id = $2`,
          [connector, event.providerEventId],
        );
        await pool.query("COMMIT");
        return reply.send({ deduped: false, correlated: false });
      }

      const payment = paymentResult.rows[0];
      if (payment.status !== "processing") {
        await pool.query(
          `UPDATE provider_webhook_events
           SET payment_id = $1, processing_status = 'ignored', processed_at = now()
           WHERE connector = $2 AND provider_event_id = $3`,
          [payment.id, connector, event.providerEventId],
        );
        await pool.query("COMMIT");
        return reply.send({ deduped: false, correlated: true, ignored: true });
      }

      const transition =
        event.outcome === "succeeded"
          ? applyPaymentTransition(toDomainPayment(payment), {
              type: "provider_webhook_succeeded",
              attemptId: attempt.id,
            })
          : applyPaymentTransition(toDomainPayment(payment), {
              type: "provider_webhook_failed",
              attemptId: attempt.id,
              code: event.errorCode ?? "UNKNOWN",
              message: event.errorMessage ?? "Unknown",
            });

      if (!transition.ok) {
        await pool.query(
          `UPDATE provider_webhook_events
           SET payment_id = $1, processing_status = 'ignored', processed_at = now()
           WHERE connector = $2 AND provider_event_id = $3`,
          [payment.id, connector, event.providerEventId],
        );
        await pool.query("COMMIT");
        return reply.send({ deduped: false, correlated: true, ignored: true, reason: transition.reason });
      }

      const next = transition.payment;

      await pool.query(
        `UPDATE payments
         SET status = $1,
             latest_attempt_id = $2,
             succeeded_attempt_id = $3,
             failure_code = $4,
             failure_message = $5,
             finalized_at = CASE WHEN $1 IN ('succeeded','failed','manual_review') THEN now() ELSE finalized_at END,
             processing_deadline_at = CASE WHEN $1 = 'processing' THEN processing_deadline_at ELSE NULL END,
             updated_at = now()
         WHERE id = $6 AND status = 'processing'`,
        [
          next.status,
          next.latestAttemptId ?? attempt.id,
          next.succeededAttemptId ?? null,
          next.failureCode ?? null,
          next.failureMessage ?? null,
          payment.id,
        ],
      );

      await pool.query(
        `UPDATE payment_attempts
         SET status = $1,
             error_code = $2,
             error_message = $3,
             updated_at = now()
         WHERE id = $4`,
        [event.outcome, event.errorCode ?? null, event.errorMessage ?? null, attempt.id],
      );

      await pool.query(
        `UPDATE provider_webhook_events
         SET payment_id = $1, processing_status = 'processed', processed_at = now()
         WHERE connector = $2 AND provider_event_id = $3`,
        [payment.id, connector, event.providerEventId],
      );

      await pool.query("COMMIT");
      return reply.send({ deduped: false, correlated: true, status: next.status });
    } catch (error) {
      await pool.query("ROLLBACK");
      request.log.error({ request_id: request.id, err: error }, "webhook_failed");
      return reply.code(500).send({ error: "INTERNAL_ERROR" });
    }
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const productionConfigIssues = validateProductionConfig(process.env);
  if (productionConfigIssues.length > 0) {
    throw new Error(`Invalid production API configuration: ${productionConfigIssues.join("; ")}`);
  }

  await initSchema();
  const app = buildApp();
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "api_stopping");
    await app.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}
