import { randomUUID } from "node:crypto";
import { applyPaymentTransition, type Payment } from "@pkg/core";
import { closePool, pool, type PaymentRow } from "@pkg/db";

const DEADLINE_POLL_INTERVAL_MS = 30_000;
const DELIVERY_POLL_INTERVAL_MS = 10_000;
const MAX_DELIVERY_ATTEMPTS = 8;
const DELIVERY_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

type MerchantDeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

type MerchantWebhookDeliveryRow = {
  id: string;
  merchant_id: string;
  payment_id: string;
  event_type: string;
  destination_url: string;
  payload_snapshot: unknown;
  status: MerchantDeliveryStatus;
  attempt_count: number;
  next_retry_at: Date | null;
  last_attempt_at: Date | null;
  delivered_at: Date | null;
  last_error: string | null;
  created_at: Date;
};

type TerminalPaymentScanRow = PaymentRow & {
  latest_provider_payment_id: string | null;
};

function log(level: "info" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = {
    level,
    message,
    ...fields,
    timestamp: new Date().toISOString(),
  };
  const output = JSON.stringify(line);
  if (level === "error") {
    console.error(output);
    return;
  }
  console.log(output);
}

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

function isTerminalStatus(status: PaymentRow["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "manual_review";
}

function calculateNextRetryAt(attemptCount: number): Date {
  const backoff = DELIVERY_BACKOFF_MS[Math.min(attemptCount, DELIVERY_BACKOFF_MS.length - 1)];
  return new Date(Date.now() + backoff);
}

async function processExpiredPayment(row: PaymentRow): Promise<void> {
  const transition = applyPaymentTransition(toDomainPayment(row), {
    type: "processing_deadline_exceeded",
  });

  if (!transition.ok) {
    log("error", "failed_to_apply_transition", {
      payment_id: row.id,
      reason: transition.reason,
      error: transition.error,
    });
    return;
  }

  const next = transition.payment;

  const update = await pool.query(
    `UPDATE payments
     SET status = $1,
         finalized_at = CASE WHEN $1 IN ('succeeded','failed','manual_review') THEN now() ELSE finalized_at END,
         updated_at = now()
     WHERE id = $2
       AND status = 'processing'`,
    [next.status, row.id],
  );

  if (update.rowCount === 0) {
    log("info", "payment_skipped_due_to_race", { payment_id: row.id });
    return;
  }

  log("info", "payment_moved_to_manual_review", {
    payment_id: row.id,
    previous_status: row.status,
    next_status: next.status,
  });
}

async function runDeadlineTick(): Promise<void> {
  const result = await pool.query<PaymentRow>(
    `SELECT *
     FROM payments
     WHERE status = 'processing'
       AND processing_deadline_at IS NOT NULL
       AND processing_deadline_at <= now()
     ORDER BY processing_deadline_at ASC
     LIMIT 200`,
  );

  if (result.rowCount === 0) {
    log("info", "deadline_tick_no_expired_payments");
    return;
  }

  log("info", "deadline_tick_found_expired_payments", { count: result.rowCount });

  for (const row of result.rows) {
    try {
      await processExpiredPayment(row);
    } catch (error) {
      log("error", "deadline_processing_error", {
        payment_id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function ensureDeliveryJobsForTerminalPayments(merchantWebhookUrl: string): Promise<void> {
  const terminalPayments = await pool.query<TerminalPaymentScanRow>(
    `SELECT p.*, pa.provider_payment_id AS latest_provider_payment_id
     FROM payments p
     LEFT JOIN payment_attempts pa ON pa.id = p.latest_attempt_id
     WHERE p.status IN ('succeeded','failed','manual_review')
     ORDER BY p.updated_at DESC
     LIMIT 200`,
  );

  for (const payment of terminalPayments.rows) {
    if (!isTerminalStatus(payment.status)) {
      continue;
    }

    const eventType = `payment.${payment.status}`;
    const payload = {
      payment_id: payment.id,
      status: payment.status,
      amount: Number(payment.amount),
      currency: payment.currency,
      latest_attempt_id: payment.latest_attempt_id,
      succeeded_attempt_id: payment.succeeded_attempt_id,
      provider_payment_id: payment.latest_provider_payment_id,
    };

    await pool.query(
      `INSERT INTO merchant_webhook_deliveries (
        id, merchant_id, payment_id, event_type, destination_url, payload_snapshot,
        status, attempt_count, next_retry_at, created_at
       )
       SELECT $1, $2, $3, $4, $5, $6, 'pending', 0, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM merchant_webhook_deliveries
         WHERE payment_id = $3 AND event_type = $4
       )`,
      [
        randomUUID(),
        payment.merchant_id,
        payment.id,
        eventType,
        merchantWebhookUrl,
        JSON.stringify(payload),
      ],
    );
  }
}

async function fetchDueDeliveries(limit: number): Promise<MerchantWebhookDeliveryRow[]> {
  await pool.query("BEGIN");
  try {
    const result = await pool.query<MerchantWebhookDeliveryRow>(
      `SELECT *
       FROM merchant_webhook_deliveries
       WHERE status = 'pending'
         AND next_retry_at IS NOT NULL
         AND next_retry_at <= now()
       ORDER BY next_retry_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    const ids = result.rows.map((row: MerchantWebhookDeliveryRow) => row.id);
    if (ids.length > 0) {
      await pool.query(
        `UPDATE merchant_webhook_deliveries
         SET status = 'delivering',
             last_attempt_at = now()
         WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    }

    await pool.query("COMMIT");
    return result.rows;
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function deliverWebhook(delivery: MerchantWebhookDeliveryRow): Promise<void> {
  const attemptCount = delivery.attempt_count + 1;
  const payload = delivery.payload_snapshot ?? {};

  try {
    const response = await fetch(delivery.destination_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });

    if (response.ok) {
      await pool.query(
        `UPDATE merchant_webhook_deliveries
         SET status = 'delivered',
             delivered_at = now(),
             attempt_count = $1,
             next_retry_at = NULL,
             last_error = NULL
         WHERE id = $2`,
        [attemptCount, delivery.id],
      );

      log("info", "merchant_webhook_delivered", {
        delivery_id: delivery.id,
        payment_id: delivery.payment_id,
        attempt_count: attemptCount,
        result: "delivered",
      });
      return;
    }

    const responseText = await response.text().catch(() => "");
    throw new Error(`HTTP_${response.status}${responseText ? `_${responseText}` : ""}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (attemptCount >= MAX_DELIVERY_ATTEMPTS) {
      await pool.query(
        `UPDATE merchant_webhook_deliveries
         SET status = 'failed',
             attempt_count = $1,
             next_retry_at = NULL,
             last_error = $2
         WHERE id = $3`,
        [attemptCount, errorMessage, delivery.id],
      );

      log("error", "merchant_webhook_dead_lettered", {
        delivery_id: delivery.id,
        payment_id: delivery.payment_id,
        attempt_count: attemptCount,
        result: "dead",
        error: errorMessage,
      });
      return;
    }

    const nextRetryAt = calculateNextRetryAt(attemptCount - 1);

    await pool.query(
      `UPDATE merchant_webhook_deliveries
       SET status = 'pending',
           attempt_count = $1,
           next_retry_at = $2,
           last_error = $3
       WHERE id = $4`,
      [attemptCount, nextRetryAt, errorMessage, delivery.id],
    );

    log("error", "merchant_webhook_delivery_retry_scheduled", {
      delivery_id: delivery.id,
      payment_id: delivery.payment_id,
      attempt_count: attemptCount,
      result: "retry",
      next_retry_at: nextRetryAt.toISOString(),
      error: errorMessage,
    });
  }
}

async function runDeliveryTick(merchantWebhookUrl: string): Promise<void> {
  await ensureDeliveryJobsForTerminalPayments(merchantWebhookUrl);

  const due = await fetchDueDeliveries(20);
  if (due.length === 0) {
    log("info", "delivery_tick_no_due_jobs");
    return;
  }

  for (const delivery of due) {
    try {
      await deliverWebhook(delivery);
    } catch (error) {
      log("error", "delivery_tick_job_failed", {
        delivery_id: delivery.id,
        payment_id: delivery.payment_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function start(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const merchantWebhookUrl = process.env.MERCHANT_WEBHOOK_URL;
  if (!merchantWebhookUrl) {
    throw new Error("MERCHANT_WEBHOOK_URL is required");
  }

  log("info", "worker_started", {
    deadline_poll_interval_ms: DEADLINE_POLL_INTERVAL_MS,
    delivery_poll_interval_ms: DELIVERY_POLL_INTERVAL_MS,
  });

  await runDeadlineTick();
  await runDeliveryTick(merchantWebhookUrl);

  const deadlineTimer = setInterval(() => {
    runDeadlineTick().catch((error) => {
      log("error", "deadline_tick_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, DEADLINE_POLL_INTERVAL_MS);

  const deliveryTimer = setInterval(() => {
    runDeliveryTick(merchantWebhookUrl).catch((error) => {
      log("error", "delivery_tick_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, DELIVERY_POLL_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    clearInterval(deadlineTimer);
    clearInterval(deliveryTimer);
    log("info", "worker_stopping", { signal });
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

start().catch(async (error) => {
  log("error", "worker_start_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  await closePool();
  process.exit(1);
});
