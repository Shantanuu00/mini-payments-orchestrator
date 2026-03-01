"use client";

import { useMemo, useState } from "react";
import { Card } from "../components/ui/card";

type Payment = {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: "created" | "processing" | "succeeded" | "failed" | "manual_review";
};

type Attempt = {
  id: string;
  status: string;
  connector: string;
  provider_payment_id: string | null;
  created_at: string;
  updated_at: string;
  error_code: string | null;
  error_message: string | null;
};

type Delivery = {
  id: string;
  payment_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  next_retry_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
};

type ScenarioResult = {
  first: unknown;
  second: unknown;
  identical: boolean;
  attemptsBefore: number;
  attemptsAfter: number;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

const statusBadgeClass: Record<Payment["status"], string> = {
  created: "bg-zinc-700 text-zinc-100",
  processing: "bg-amber-600/20 text-amber-300",
  succeeded: "bg-emerald-600/20 text-emerald-300",
  failed: "bg-red-600/20 text-red-300",
  manual_review: "bg-fuchsia-600/20 text-fuchsia-300",
};

export default function DashboardPage() {
  const [merchantId, setMerchantId] = useState("merchant_demo");
  const [amount, setAmount] = useState(1299);
  const [currency, setCurrency] = useState("USD");

  const [paymentId, setPaymentId] = useState("");
  const [connector, setConnector] = useState("mock");
  const [idempotencyKey, setIdempotencyKey] = useState(crypto.randomUUID());

  const [webhookConnector, setWebhookConnector] = useState("mock");
  const [providerPaymentId, setProviderPaymentId] = useState("");
  const [providerEventId, setProviderEventId] = useState(`evt_${crypto.randomUUID()}`);
  const [webhookOutcome, setWebhookOutcome] = useState<"succeeded" | "failed">("succeeded");

  const [payment, setPayment] = useState<Payment | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);

  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [duplicateConfirmResult, setDuplicateConfirmResult] = useState<ScenarioResult | null>(null);
  const [lastWebhookSingleResponse, setLastWebhookSingleResponse] = useState<unknown>(null);
  const [webhookDedupeResult, setWebhookDedupeResult] = useState<{ first: unknown; second: unknown } | null>(null);

  const statusLabel = useMemo(() => payment?.status ?? "created", [payment?.status]);

  async function safeJson(response: Response) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error ? String(payload.error) : `HTTP ${response.status}`);
    }
    return payload;
  }

  async function refreshPaymentAndDeliveries(currentPaymentId: string) {
    const paymentResponse = await fetch(`${API_BASE}/payments/${currentPaymentId}`);
    const paymentData = await safeJson(paymentResponse);

    setPayment({
      id: paymentData.payment.id,
      merchantId: paymentData.payment.merchant_id,
      amount: Number(paymentData.payment.amount),
      currency: paymentData.payment.currency,
      status: paymentData.payment.status,
    });
    setAttempts((paymentData.attempts ?? []) as Attempt[]);

    const deliveriesResponse = await fetch(`${API_BASE}/deliveries?payment_id=${encodeURIComponent(currentPaymentId)}`);
    const deliveriesData = await safeJson(deliveriesResponse);
    setDeliveries((deliveriesData.deliveries ?? []) as Delivery[]);
  }

  async function createPayment() {
    setLoadingAction("create");
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId, amount, currency: currency.toUpperCase() }),
      });
      const data = await safeJson(response);
      const created = data as Payment;
      setPayment(created);
      setPaymentId(created.id);
      setAttempts([]);
      setDeliveries([]);
      setDuplicateConfirmResult(null);
      setLastWebhookSingleResponse(null);
      setWebhookDedupeResult(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create payment");
    } finally {
      setLoadingAction(null);
    }
  }

  async function refreshAll() {
    if (!paymentId) return;
    setLoadingAction("refresh");
    setErrorMessage(null);
    try {
      await refreshPaymentAndDeliveries(paymentId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to refresh payment");
    } finally {
      setLoadingAction(null);
    }
  }

  async function runDuplicateConfirmReplay() {
    if (!paymentId) return;
    setLoadingAction("duplicate-confirm");
    setErrorMessage(null);
    try {
      const attemptsBefore = attempts.length;

      const body = { merchantId, connector, idempotencyKey };
      const first = await safeJson(
        await fetch(`${API_BASE}/payments/${paymentId}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

      const second = await safeJson(
        await fetch(`${API_BASE}/payments/${paymentId}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

      await refreshPaymentAndDeliveries(paymentId);
      const attemptsAfter = (await fetch(`${API_BASE}/payments/${paymentId}`).then(safeJson)).attempts.length as number;

      setDuplicateConfirmResult({
        first,
        second,
        identical: JSON.stringify(first) === JSON.stringify(second),
        attemptsBefore,
        attemptsAfter,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Duplicate confirm demo failed");
    } finally {
      setLoadingAction(null);
    }
  }

  async function confirmWithFlakyConnector() {
    if (!paymentId) return;
    setLoadingAction("flaky-confirm");
    setErrorMessage(null);
    try {
      const response = await safeJson(
        await fetch(`${API_BASE}/payments/${paymentId}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ merchantId, connector: "flaky", idempotencyKey: `flaky_${crypto.randomUUID()}` }),
        }),
      );

      await refreshPaymentAndDeliveries(paymentId);

      if (response?.status === "processing") {
        setWebhookConnector("flaky");
        const latest = attempts[0];
        if (latest?.provider_payment_id) {
          setProviderPaymentId(latest.provider_payment_id);
        }
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Flaky confirm failed");
    } finally {
      setLoadingAction(null);
    }
  }

  async function sendWebhookOnce() {
    if (!paymentId || !providerPaymentId || !providerEventId) return;
    setLoadingAction("webhook-once");
    setErrorMessage(null);
    try {
      const payload = {
        providerEventId,
        providerPaymentId,
        eventType: `payment.${webhookOutcome}`,
        outcome: webhookOutcome,
      };
      const res = await safeJson(
        await fetch(`${API_BASE}/webhooks/${webhookConnector}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      setLastWebhookSingleResponse(res);
      await refreshPaymentAndDeliveries(paymentId);
      setProviderEventId(`evt_${crypto.randomUUID()}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Webhook demo failed");
    } finally {
      setLoadingAction(null);
    }
  }

  async function sendSameWebhookTwice() {
    if (!paymentId || !providerPaymentId || !providerEventId) return;
    setLoadingAction("webhook-dedupe");
    setErrorMessage(null);
    try {
      const payload = {
        providerEventId,
        providerPaymentId,
        eventType: `payment.${webhookOutcome}`,
        outcome: webhookOutcome,
      };
      const first = await safeJson(
        await fetch(`${API_BASE}/webhooks/${webhookConnector}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      const second = await safeJson(
        await fetch(`${API_BASE}/webhooks/${webhookConnector}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      setWebhookDedupeResult({ first, second });
      await refreshPaymentAndDeliveries(paymentId);
      setProviderEventId(`evt_${crypto.randomUUID()}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Webhook dedupe demo failed");
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl space-y-6 p-6 md:p-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50">Mini Payment Orchestrator Demo</h1>
        <p className="text-zinc-400">Recruiter demo scenarios: idempotency replay, processing/webhook resolution, webhook dedupe, and delivery visibility.</p>
      </header>

      {errorMessage ? <div className="rounded-lg border border-red-700 bg-red-950/40 px-4 py-3 text-sm text-red-300">{errorMessage}</div> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Create Payment">
          <div className="space-y-3">
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" value={merchantId} onChange={(e) => setMerchantId(e.target.value)} placeholder="merchant id" />
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} placeholder="amount" />
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="currency" />
            <button className="rounded-md bg-white px-4 py-2 font-medium text-black disabled:opacity-60" onClick={createPayment} disabled={loadingAction !== null}>
              {loadingAction === "create" ? "Creating..." : "Create Payment"}
            </button>
          </div>
        </Card>

        <Card title="Payment Context">
          <div className="space-y-3">
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" value={paymentId} onChange={(e) => setPaymentId(e.target.value)} placeholder="payment id" />
            <select className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" value={connector} onChange={(e) => setConnector(e.target.value)}>
              <option value="mock">mock</option>
              <option value="flaky">flaky</option>
            </select>
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} placeholder="idempotency key" />
            <button className="rounded-md bg-zinc-700 px-4 py-2" onClick={refreshAll} disabled={!paymentId || loadingAction !== null}>
              {loadingAction === "refresh" ? "Refreshing..." : "Refresh Payment + Deliveries"}
            </button>
          </div>
        </Card>
      </div>

      <Card title="Demo Scenarios" subtitle="Run deterministic demos and inspect reliability behavior.">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <h3 className="font-semibold">1) Duplicate Confirm Replay</h3>
            <button className="rounded-md bg-emerald-500 px-3 py-2 text-black disabled:opacity-60" onClick={runDuplicateConfirmReplay} disabled={!paymentId || loadingAction !== null}>
              {loadingAction === "duplicate-confirm" ? "Running..." : "Run Duplicate Confirm Replay"}
            </button>
            {duplicateConfirmResult ? (
              <>
                <p className={`text-sm ${duplicateConfirmResult.identical ? "text-emerald-300" : "text-red-300"}`}>
                  Responses identical: {String(duplicateConfirmResult.identical)}
                </p>
                <p className={`text-sm ${duplicateConfirmResult.attemptsBefore === duplicateConfirmResult.attemptsAfter ? "text-emerald-300" : "text-red-300"}`}>
                  Attempts unchanged: {duplicateConfirmResult.attemptsBefore} → {duplicateConfirmResult.attemptsAfter}
                </p>
                <div className="grid gap-2 md:grid-cols-2">
                  <pre className="overflow-auto rounded bg-zinc-900 p-2 text-xs">{JSON.stringify(duplicateConfirmResult.first, null, 2)}</pre>
                  <pre className="overflow-auto rounded bg-zinc-900 p-2 text-xs">{JSON.stringify(duplicateConfirmResult.second, null, 2)}</pre>
                </div>
              </>
            ) : (
              <p className="text-sm text-zinc-400">No run yet.</p>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <h3 className="font-semibold">2) Force Processing + Resolve via Webhook</h3>
            <button className="rounded-md bg-amber-500 px-3 py-2 text-black disabled:opacity-60" onClick={confirmWithFlakyConnector} disabled={!paymentId || loadingAction !== null}>
              {loadingAction === "flaky-confirm" ? "Confirming..." : "Confirm with Flaky Connector"}
            </button>
            <p className="text-sm text-zinc-300">Current status: <span className="font-semibold">{statusLabel}</span></p>
            <div className="grid gap-2">
              <select className="rounded-md border border-zinc-700 bg-zinc-900 p-2" value={webhookConnector} onChange={(e) => setWebhookConnector(e.target.value)}>
                <option value="mock">mock</option>
                <option value="flaky">flaky</option>
              </select>
              <input className="rounded-md border border-zinc-700 bg-zinc-900 p-2" value={providerPaymentId} onChange={(e) => setProviderPaymentId(e.target.value)} placeholder="provider_payment_id" />
              <input className="rounded-md border border-zinc-700 bg-zinc-900 p-2" value={providerEventId} onChange={(e) => setProviderEventId(e.target.value)} placeholder="provider_event_id" />
              <select className="rounded-md border border-zinc-700 bg-zinc-900 p-2" value={webhookOutcome} onChange={(e) => setWebhookOutcome(e.target.value as "succeeded" | "failed") }>
                <option value="succeeded">succeeded</option>
                <option value="failed">failed</option>
              </select>
              <button className="rounded-md bg-indigo-500 px-3 py-2 text-black disabled:opacity-60" onClick={sendWebhookOnce} disabled={!paymentId || !providerPaymentId || !providerEventId || loadingAction !== null}>
                {loadingAction === "webhook-once" ? "Sending..." : "Send Webhook"}
              </button>
            </div>
            <pre className="overflow-auto rounded bg-zinc-900 p-2 text-xs">{JSON.stringify(lastWebhookSingleResponse ?? { note: "No webhook sent yet" }, null, 2)}</pre>
          </div>

          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <h3 className="font-semibold">3) Webhook Dedupe Demo</h3>
            <button className="rounded-md bg-fuchsia-500 px-3 py-2 text-black disabled:opacity-60" onClick={sendSameWebhookTwice} disabled={!paymentId || !providerPaymentId || !providerEventId || loadingAction !== null}>
              {loadingAction === "webhook-dedupe" ? "Sending..." : "Send same webhook twice"}
            </button>
            <div className="grid gap-2 md:grid-cols-2">
              <pre className="overflow-auto rounded bg-zinc-900 p-2 text-xs">{JSON.stringify(webhookDedupeResult?.first ?? { note: "first response pending" }, null, 2)}</pre>
              <pre className="overflow-auto rounded bg-zinc-900 p-2 text-xs">{JSON.stringify(webhookDedupeResult?.second ?? { note: "second response pending" }, null, 2)}</pre>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Payment Details">
          {payment ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="font-semibold">{payment.id}</span>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase ${statusBadgeClass[statusLabel]}`}>{statusLabel}</span>
              </div>
              <p className="text-sm text-zinc-300">Amount: {payment.amount} {payment.currency}</p>
              <p className="text-sm text-zinc-300">Merchant: {payment.merchantId}</p>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">No payment loaded yet.</p>
          )}
        </Card>

        <Card title="Merchant Delivery Log">
          {deliveries.length === 0 ? (
            <p className="text-sm text-zinc-400">No delivery rows found for this payment.</p>
          ) : (
            <div className="space-y-2">
              {deliveries.map((d) => (
                <div key={d.id} className="rounded border border-zinc-800 bg-zinc-950/70 p-3 text-sm">
                  <p className="font-semibold">{d.event_type}</p>
                  <p>status: {d.status} · attempts: {d.attempt_count}</p>
                  <p>created: {new Date(d.created_at).toLocaleString()}</p>
                  <p>next_retry_at: {d.next_retry_at ? new Date(d.next_retry_at).toLocaleString() : "—"}</p>
                  <p>delivered_at: {d.delivered_at ? new Date(d.delivered_at).toLocaleString() : "—"}</p>
                  {d.last_error ? <p className="text-red-400">last_error: {d.last_error}</p> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Attempts Timeline (latest first)">
        {attempts.length === 0 ? (
          <p className="text-sm text-zinc-400">No attempts yet.</p>
        ) : (
          <div className="space-y-2">
            {attempts.map((attempt) => (
              <article key={attempt.id} className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3 text-sm">
                <p className="font-semibold text-zinc-100">{attempt.id}</p>
                <p>{attempt.status.toUpperCase()} · connector: {attempt.connector}</p>
                <p>provider_payment_id: {attempt.provider_payment_id ?? "—"}</p>
                <p>created: {new Date(attempt.created_at).toLocaleString()}</p>
                <p>updated: {new Date(attempt.updated_at).toLocaleString()}</p>
                {attempt.error_code ? <p className="text-red-400">{attempt.error_code}: {attempt.error_message ?? "unknown"}</p> : null}
              </article>
            ))}
          </div>
        )}
      </Card>
    </main>
  );
}
