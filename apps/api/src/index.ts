import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import {
  applyPaymentTransition,
  confirmPaymentSchema,
  createPaymentSchema,
  getPaymentParamsSchema,
  webhookSchema,
} from "@pkg/core";
import { initSchema, pool, type AttemptRow, type PaymentRow } from "@pkg/db";

function isTerminal(status: PaymentRow["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "manual_review";
}

type ConfirmResponse = {
  paymentId: string;
  status: string;
  attemptId: string | null;
  reason: string;
};

async function mockConnector(paymentId: string): Promise<{ attemptStatus: "succeeded" | "failed" | "unknown"; code?: string; message?: string; providerPaymentId: string }> {
  const score = paymentId.charCodeAt(0) % 3;
  if (score === 0) return { attemptStatus: "succeeded", providerPaymentId: `mock_${paymentId}` };
  if (score === 1) return { attemptStatus: "failed", code: "DECLINED", message: "Card declined", providerPaymentId: `mock_${paymentId}` };
  return { attemptStatus: "unknown", code: "TIMEOUT", message: "Gateway timeout", providerPaymentId: `mock_${paymentId}` };
}

async function getPayment(paymentId: string): Promise<PaymentRow | undefined> {
  const result = await pool.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [paymentId]);
  return result.rows[0];
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

  app.get("/health", async () => ({ ok: true }));

  app.post("/v1/payments", async (request, reply) => {
    const parsed = createPaymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    const id = randomUUID();
    const now = new Date();
    const { merchantId, amount, currency } = parsed.data;

    await pool.query(
      `INSERT INTO payments (id, merchant_id, amount, currency, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'created', $5, $5)`,
      [id, merchantId, amount, currency, now],
    );

    app.log.info({ paymentId: id, merchantId }, "payment_created");
    return reply.code(201).send({ id, merchantId, amount, currency, status: "created", createdAt: now.toISOString() });
  });

  app.post("/v1/payments/confirm", async (request, reply) => {
    const parsed = confirmPaymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }
    const { merchantId, paymentId, idempotencyKey, connector } = parsed.data;

    const payment = await getPayment(paymentId);
    if (!payment || payment.merchant_id !== merchantId) {
      return reply.code(404).send({ error: "PAYMENT_NOT_FOUND" });
    }

    if (payment.last_confirm_idempotency_key === idempotencyKey && payment.last_confirm_response) {
      return reply.send(payment.last_confirm_response);
    }

    if (isTerminal(payment.status)) {
      const response: ConfirmResponse = { paymentId, status: payment.status, attemptId: payment.latest_attempt_id, reason: "Terminal payment cannot be reconfirmed" };
      await pool.query(
        `UPDATE payments SET last_confirm_idempotency_key = $1, last_confirm_response = $2, updated_at = now() WHERE id = $3`,
        [idempotencyKey, JSON.stringify(response), paymentId],
      );
      return reply.send(response);
    }

    const attemptId = randomUUID();
    const connectorResult = await mockConnector(paymentId);

    await pool.query(
      `INSERT INTO payment_attempts (id, payment_id, merchant_id, connector, status, idempotency_key, provider_payment_id, error_code, error_message, request_snapshot, response_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
        JSON.stringify(parsed.data),
        JSON.stringify(connectorResult),
      ],
    );

    const transition =
      connectorResult.attemptStatus === "succeeded"
        ? applyPaymentTransition(
            { id: payment.id, merchantId: payment.merchant_id, amount: Number(payment.amount), currency: payment.currency, status: payment.status, latestAttemptId: payment.latest_attempt_id, succeededAttemptId: payment.succeeded_attempt_id, failureCode: payment.failure_code, failureMessage: payment.failure_message },
            { type: "provider_sync_succeeded", attemptId },
          )
        : connectorResult.attemptStatus === "failed"
          ? applyPaymentTransition(
              { id: payment.id, merchantId: payment.merchant_id, amount: Number(payment.amount), currency: payment.currency, status: payment.status, latestAttemptId: payment.latest_attempt_id, succeededAttemptId: payment.succeeded_attempt_id, failureCode: payment.failure_code, failureMessage: payment.failure_message },
              { type: "provider_sync_failed_definite", attemptId, code: connectorResult.code ?? "UNKNOWN", message: connectorResult.message ?? "Unknown" },
            )
          : applyPaymentTransition(
              { id: payment.id, merchantId: payment.merchant_id, amount: Number(payment.amount), currency: payment.currency, status: payment.status, latestAttemptId: payment.latest_attempt_id, succeededAttemptId: payment.succeeded_attempt_id, failureCode: payment.failure_code, failureMessage: payment.failure_message },
              { type: "provider_sync_unknown", attemptId },
            );

    if (!transition.ok) {
      return reply.code(409).send({ error: transition.error, reason: transition.reason });
    }

    const next = transition.next;
    const response: ConfirmResponse = { paymentId, status: next.status, attemptId, reason: transition.reason };
    const deadline = next.status === "processing" ? new Date(Date.now() + 5 * 60 * 1000) : null;

    await pool.query(
      `UPDATE payments
       SET status = $1,
           latest_attempt_id = $2,
           succeeded_attempt_id = $3,
           failure_code = $4,
           failure_message = $5,
           finalized_at = CASE WHEN $1 IN ('succeeded','failed','manual_review') THEN now() ELSE finalized_at END,
           processing_deadline_at = $6,
           last_confirm_idempotency_key = $7,
           last_confirm_response = $8,
           updated_at = now()
       WHERE id = $9`,
      [
        next.status,
        next.latestAttemptId ?? null,
        next.succeededAttemptId ?? null,
        next.failureCode ?? null,
        next.failureMessage ?? null,
        deadline,
        idempotencyKey,
        JSON.stringify(response),
        paymentId,
      ],
    );

    return reply.send(response);
  });

  app.get("/v1/payments/:paymentId", async (request, reply) => {
    const parsed = getPaymentParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    const payment = await getPayment(parsed.data.paymentId);
    if (!payment) {
      return reply.code(404).send({ error: "PAYMENT_NOT_FOUND" });
    }

    const attempts = await pool.query<AttemptRow>(
      "SELECT * FROM payment_attempts WHERE payment_id = $1 ORDER BY created_at DESC",
      [payment.id],
    );

    return reply.send({ payment, attempts: attempts.rows });
  });

  app.post("/v1/webhooks/provider", async (request, reply) => {
    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    const event = parsed.data;
    const existing = await pool.query(
      "SELECT id FROM payment_attempts WHERE connector = $1 AND provider_event_id = $2",
      [event.connector, event.providerEventId],
    );
    if (existing.rowCount) {
      return reply.send({ deduped: true });
    }

    await pool.query(
      `UPDATE payment_attempts SET provider_event_id = $1, updated_at = now() WHERE id = $2`,
      [event.providerEventId, event.attemptId],
    );

    return reply.send({ deduped: false });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  await initSchema();
  const app = buildApp();
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
}
