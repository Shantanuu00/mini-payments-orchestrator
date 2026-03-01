"use client";

import { useState } from "react";
import { Card } from "../components/ui/card";

type Payment = {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: string;
};

type Attempt = {
  id: string;
  status: string;
  connector: string;
  created_at: string;
  error_code: string | null;
  error_message: string | null;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

export default function DashboardPage() {
  const [merchantId, setMerchantId] = useState("merchant_demo");
  const [amount, setAmount] = useState(1299);
  const [currency, setCurrency] = useState("USD");
  const [paymentId, setPaymentId] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(crypto.randomUUID());
  const [payment, setPayment] = useState<Payment | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);

  async function createPayment() {
    const response = await fetch(`${API_BASE}/v1/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amount, currency }),
    });
    const data = await response.json();
    setPayment(data);
    setPaymentId(data.id);
    setAttempts([]);
  }

  async function confirmPayment() {
    if (!paymentId) return;
    await fetch(`${API_BASE}/v1/payments/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId, merchantId, connector: "mock", idempotencyKey }),
    });
    await loadPayment();
  }

  async function loadPayment() {
    if (!paymentId) return;
    const response = await fetch(`${API_BASE}/v1/payments/${paymentId}`);
    const data = await response.json();
    setPayment({
      id: data.payment.id,
      merchantId: data.payment.merchant_id,
      amount: Number(data.payment.amount),
      currency: data.payment.currency,
      status: data.payment.status,
    });
    setAttempts(data.attempts ?? []);
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl p-8">
      <h1 className="mb-8 text-3xl font-bold tracking-tight">Mini Payment Orchestrator</h1>
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Create Payment">
          <div className="space-y-3">
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" value={merchantId} onChange={(e) => setMerchantId(e.target.value)} />
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            <button className="rounded-md bg-white px-4 py-2 font-medium text-black" onClick={createPayment}>Create</button>
          </div>
        </Card>

        <Card title="Confirm + Fetch">
          <div className="space-y-3">
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" placeholder="payment id" value={paymentId} onChange={(e) => setPaymentId(e.target.value)} />
            <input className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2" value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} />
            <div className="flex gap-2">
              <button className="rounded-md bg-emerald-500 px-4 py-2 font-medium text-black" onClick={confirmPayment}>Confirm</button>
              <button className="rounded-md bg-zinc-700 px-4 py-2" onClick={loadPayment}>Refresh</button>
            </div>
          </div>
        </Card>
      </div>

      {payment && (
        <Card title="Payment Snapshot">
          <pre className="overflow-auto rounded-md bg-zinc-950 p-3 text-sm">{JSON.stringify(payment, null, 2)}</pre>
        </Card>
      )}

      <Card title="Timeline (Attempts)">
        <div className="space-y-2">
          {attempts.length === 0 ? (
            <p className="text-zinc-400">No attempts yet.</p>
          ) : (
            attempts.map((attempt) => (
              <div key={attempt.id} className="rounded-md border border-zinc-800 p-3">
                <p className="font-medium">{attempt.status.toUpperCase()} · {attempt.connector}</p>
                <p className="text-xs text-zinc-400">{new Date(attempt.created_at).toLocaleString()}</p>
                {attempt.error_code && <p className="text-sm text-red-400">{attempt.error_code}: {attempt.error_message}</p>}
              </div>
            ))
          )}
        </div>
      </Card>
    </main>
  );
}
