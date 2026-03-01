import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { createHash, randomUUID } from "node:crypto";
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

  app.addHook("onRequest", async (request) => {
    request.log.info({ request_id: request.id, method: request.method, url: request.url }, "request_received");
  });

  app.get("/health", async () => ({ ok: true }));

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

  app.post("/webhooks/:connector", async (request, reply) => {
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
  await initSchema();
  const app = buildApp();
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
}
