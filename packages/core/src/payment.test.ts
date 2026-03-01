import test from "node:test";
import assert from "node:assert/strict";
import { applyPaymentTransition, type Payment } from "./payment";

const base: Payment = {
  id: "p1",
  merchantId: "m1",
  amount: 100,
  currency: "USD",
  status: "created",
};

test("created + provider_sync_unknown -> processing", () => {
  const result = applyPaymentTransition(base, {
    type: "provider_sync_unknown",
    attemptId: "a1",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.next.status, "processing");
  }
});

test("terminal state cannot regress", () => {
  const result = applyPaymentTransition(
    { ...base, status: "succeeded", succeededAttemptId: "a1" },
    { type: "provider_webhook_failed", code: "DECLINED", message: "x", attemptId: "a2" },
  );

  assert.equal(result.ok, false);
});
