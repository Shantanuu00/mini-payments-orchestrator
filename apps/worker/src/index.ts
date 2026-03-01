import { applyPaymentTransition, type Payment } from "@pkg/core";
import { closePool, pool, type PaymentRow } from "@pkg/db";

const POLL_INTERVAL_MS = 30_000;

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

async function runTick(): Promise<void> {
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
    log("info", "worker_tick_no_expired_payments");
    return;
  }

  log("info", "worker_tick_found_expired_payments", { count: result.rowCount });

  for (const row of result.rows) {
    try {
      await processExpiredPayment(row);
    } catch (error) {
      log("error", "worker_payment_processing_error", {
        payment_id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function start(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  log("info", "worker_started", { poll_interval_ms: POLL_INTERVAL_MS });

  await runTick();
  const timer = setInterval(() => {
    runTick().catch((error) => {
      log("error", "worker_tick_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, POLL_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    clearInterval(timer);
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
