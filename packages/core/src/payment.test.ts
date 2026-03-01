import test from "node:test";
import assert from "node:assert/strict";
import { applyPaymentTransition, type Payment } from "./payment.js";

const base: Payment = {
  id: "00000000-0000-0000-0000-000000000001",
  merchantId: "merchant_1",
  amount: 100,
  currency: "USD",
  status: "created",
};

test("created -> processing on provider_sync_unknown", () => {
  const result = applyPaymentTransition(base, {
    type: "provider_sync_unknown",
    attemptId: "00000000-0000-0000-0000-000000000100",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payment.status, "processing");
  }
});

test("terminal states do not transition", () => {
  const result = applyPaymentTransition(
    {
      ...base,
      status: "succeeded",
      succeededAttemptId: "00000000-0000-0000-0000-000000000100",
    },
    {
      type: "provider_webhook_failed",
      attemptId: "00000000-0000-0000-0000-000000000101",
      code: "DECLINED",
      message: "Declined",
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "TERMINAL_STATE");
  }
});
