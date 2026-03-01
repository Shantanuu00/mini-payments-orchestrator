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

type WebhookEvent = {
  provider_event_id: string;
  event_type: string;
  connector: string;
  provider_payment_id: string;
  received_at: string;
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
  const [webhookEventType, setWebhookEventType] = useState<"succeeded" | "failed">("succeeded");
  const [providerEventId, setProviderEventId] = useState(`evt_${crypto.randomUUID()}`);

  const [payment, setPayment] = useState<Payment | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvent[]>([]);

  const [isCreating, setIsCreating] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSimulatingWebhook, setIsSimulatingWebhook] = useState(false);

  const [lastConfirmResponse, setLastConfirmResponse] = useState<unknown>(null);
  const [lastWebhookResponse, setLastWebhookResponse] = useState<unknown>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canConfirm = Boolean(paymentId && merchantId && idempotencyKey);
  const canSimulateWebhook = Boolean(webhookConnector && providerPaymentId && providerEventId);

  const statusLabel = useMemo(() => payment?.status ?? "created", [payment?.status]);

  async function safeJson(response: Response) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error ? String(payload.error) : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  async function loadPayment() {
    if (!paymentId) return;
    setIsRefreshing(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`${API_BASE}/payments/${paymentId}`);
      const data = await safeJson(response);

      const paymentData = data.payment;
      setPayment({
        id: paymentData.id,
        merchantId: paymentData.merchant_id,
        amount: Number(paymentData.amount),
        currency: paymentData.currency,
        status: paymentData.status,
      });
      setAttempts((data.attempts ?? []) as Attempt[]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to fetch payment");
    } finally {
      setIsRefreshing(false);
    }
  }

  async function createPayment() {
    setIsCreating(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`${API_BASE}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId, amount, currency: currency.toUpperCase() }),
      });
      const data = await safeJson(response);

      setPayment(data as Payment);
      setPaymentId((data as Payment).id);
      setAttempts([]);
      setWebhookEvents([]);
      setLastConfirmResponse(null);
      setLastWebhookResponse(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create payment");
    } finally {
      setIsCreating(false);
    }
  }

  async function confirmPayment(replay = false) {
    if (!canConfirm) return;
    setIsConfirming(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`${API_BASE}/payments/${paymentId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          merchantId,
          connector,
          idempotencyKey,
        }),
      });
      const data = await safeJson(response);
      setLastConfirmResponse({ replay, ...data });
      await loadPayment();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to confirm payment");
    } finally {
      setIsConfirming(false);
    }
  }

  async function simulateWebhook() {
    if (!canSimulateWebhook) return;
    setIsSimulatingWebhook(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`${API_BASE}/webhooks/${webhookConnector}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerEventId,
          providerPaymentId,
          eventType: `payment.${webhookEventType}`,
          outcome: webhookEventType,
        }),
      });
      const data = await safeJson(response);
      setLastWebhookResponse(data);

      setWebhookEvents((current) => [
        {
          connector: webhookConnector,
          provider_event_id: providerEventId,
          provider_payment_id: providerPaymentId,
          event_type: `payment.${webhookEventType}`,
          received_at: new Date().toISOString(),
        },
        ...current,
      ]);

      setProviderEventId(`evt_${crypto.randomUUID()}`);
      await loadPayment();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to simulate webhook");
    } finally {
      setIsSimulatingWebhook(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl space-y-6 p-6 md:p-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50">Mini Payment Orchestrator</h1>
        <p className="text-zinc-400">Recruiter demo: create, confirm, replay idempotency, and simulate provider webhooks.</p>
      </header>

      {errorMessage ? (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">{errorMessage}</div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Create Payment" subtitle="Start a new payment intent">
          <div className="space-y-3">
            <label className="block text-sm text-zinc-300">
              Merchant ID
              <input
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
                value={merchantId}
                onChange={(e) => setMerchantId(e.target.value)}
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Amount (minor unit)
              <input
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
                type="number"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Currency
              <input
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </label>
            <button
              className="rounded-md bg-white px-4 py-2 font-medium text-black disabled:cursor-not-allowed disabled:opacity-60"
              onClick={createPayment}
              disabled={isCreating}
            >
              {isCreating ? "Creating..." : "Create Payment"}
            </button>
          </div>
        </Card>

        <Card title="Confirm Payment" subtitle="Demonstrate idempotent retries">
          <div className="space-y-3">
            <label className="block text-sm text-zinc-300">
              Payment ID
              <input
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
                value={paymentId}
                onChange={(e) => setPaymentId(e.target.value)}
                placeholder="uuid"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Connector
              <select
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
                value={connector}
                onChange={(e) => setConnector(e.target.value)}
              >
                <option value="mock">mock</option>
                <option value="flaky">flaky</option>
              </select>
            </label>
            <label className="block text-sm text-zinc-300">
              Idempotency Key
              <input
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md bg-emerald-500 px-4 py-2 font-medium text-black disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => confirmPayment(false)}
                disabled={!canConfirm || isConfirming}
              >
                {isConfirming ? "Confirming..." : "Confirm"}
              </button>
              <button
                className="rounded-md bg-emerald-900 px-4 py-2 font-medium text-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => confirmPayment(true)}
                disabled={!canConfirm || isConfirming}
              >
                Replay Confirm (same idempotency key)
              </button>
              <button
                className="rounded-md bg-zinc-700 px-4 py-2 text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={loadPayment}
                disabled={!paymentId || isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Payment Details" subtitle="Canonical payment state + audit trails">
        {payment ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium text-zinc-200">Payment {payment.id}</span>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase ${statusBadgeClass[statusLabel]}`}>
                {statusLabel}
              </span>
            </div>
            <div className="grid gap-2 text-sm text-zinc-300 md:grid-cols-2">
              <p>Merchant: {payment.merchantId}</p>
              <p>
                Amount: {payment.amount} {payment.currency}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">No payment selected yet. Create a payment or paste a payment ID and click Refresh.</p>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Attempts Timeline" subtitle="Latest attempt first">
          {attempts.length === 0 ? (
            <p className="text-sm text-zinc-400">No attempts yet.</p>
          ) : (
            <div className="space-y-2">
              {attempts.map((attempt) => (
                <article key={attempt.id} className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3 text-sm">
                  <p className="font-semibold text-zinc-100">{attempt.id}</p>
                  <p className="text-zinc-300">
                    {attempt.status.toUpperCase()} · connector: {attempt.connector}
                  </p>
                  <p className="text-zinc-400">provider_payment_id: {attempt.provider_payment_id ?? "—"}</p>
                  <p className="text-zinc-500">created: {new Date(attempt.created_at).toLocaleString()}</p>
                  <p className="text-zinc-500">updated: {new Date(attempt.updated_at).toLocaleString()}</p>
                  {attempt.error_code ? (
                    <p className="text-red-400">
                      {attempt.error_code}: {attempt.error_message ?? "unknown"}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </Card>

        <Card title="Webhook Events Timeline" subtitle="Demo events (latest first)">
          {webhookEvents.length === 0 ? (
            <p className="text-sm text-zinc-400">No webhook events yet. Use Simulate Webhook to add events.</p>
          ) : (
            <div className="space-y-2">
              {webhookEvents.map((event) => (
                <article key={event.provider_event_id} className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3 text-sm">
                  <p className="font-semibold text-zinc-100">{event.provider_event_id}</p>
                  <p className="text-zinc-300">{event.event_type}</p>
                  <p className="text-zinc-400">connector: {event.connector}</p>
                  <p className="text-zinc-400">provider_payment_id: {event.provider_payment_id}</p>
                  <p className="text-zinc-500">received_at: {new Date(event.received_at).toLocaleString()}</p>
                </article>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Simulate Webhook" subtitle="For demo: trigger webhook handler and refresh state">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm text-zinc-300">
            Connector
            <select
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
              value={webhookConnector}
              onChange={(e) => setWebhookConnector(e.target.value)}
            >
              <option value="mock">mock</option>
              <option value="flaky">flaky</option>
            </select>
          </label>
          <label className="block text-sm text-zinc-300">
            Event Type
            <select
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
              value={webhookEventType}
              onChange={(e) => setWebhookEventType(e.target.value as "succeeded" | "failed")}
            >
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
            </select>
          </label>
          <label className="block text-sm text-zinc-300">
            Provider Payment ID
            <input
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
              value={providerPaymentId}
              onChange={(e) => setProviderPaymentId(e.target.value)}
              placeholder="mock_<payment-id>"
            />
          </label>
          <label className="block text-sm text-zinc-300">
            Provider Event ID
            <input
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2"
              value={providerEventId}
              onChange={(e) => setProviderEventId(e.target.value)}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="rounded-md bg-indigo-500 px-4 py-2 font-medium text-black disabled:cursor-not-allowed disabled:opacity-60"
            onClick={simulateWebhook}
            disabled={!canSimulateWebhook || isSimulatingWebhook}
          >
            {isSimulatingWebhook ? "Sending..." : "Simulate Webhook"}
          </button>
          <button
            className="rounded-md bg-zinc-700 px-4 py-2 text-zinc-100"
            onClick={loadPayment}
            disabled={!paymentId || isRefreshing}
          >
            Refresh Payment
          </button>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Last Confirm Response">
          <pre className="overflow-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-200">
            {JSON.stringify(lastConfirmResponse ?? { note: "No confirm calls yet" }, null, 2)}
          </pre>
        </Card>
        <Card title="Last Webhook Response">
          <pre className="overflow-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-200">
            {JSON.stringify(lastWebhookResponse ?? { note: "No webhook calls yet" }, null, 2)}
          </pre>
        </Card>
      </div>
    </main>
  );
}
