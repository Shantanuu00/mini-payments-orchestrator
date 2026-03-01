import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/mini_payments",
});

export async function initSchema(): Promise<void> {
  const schemaPath = join(__dirname, "..", "schema.sql");
  const sql = await readFile(schemaPath, "utf8");
  await pool.query(sql);
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export type DbPaymentStatus = "created" | "processing" | "succeeded" | "failed" | "manual_review";
export type DbAttemptStatus = "started" | "succeeded" | "failed" | "unknown";

export type PaymentRow = {
  id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  status: DbPaymentStatus;
  created_at: Date;
  updated_at: Date;
  finalized_at: Date | null;
  processing_deadline_at: Date | null;
  latest_attempt_id: string | null;
  succeeded_attempt_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
};

export type AttemptRow = {
  id: string;
  payment_id: string;
  merchant_id: string;
  connector: string;
  operation: string;
  status: DbAttemptStatus;
  created_at: Date;
  updated_at: Date;
  request_id: string | null;
  idempotency_key: string | null;
  provider_event_id: string | null;
  provider_payment_id: string | null;
  error_code: string | null;
  error_message: string | null;
  request_snapshot: unknown;
  response_snapshot: unknown;
};
