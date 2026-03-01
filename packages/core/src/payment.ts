export type PaymentStatus =
  | "created"
  | "processing"
  | "succeeded"
  | "failed"
  | "manual_review";

export type Payment = {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  latestAttemptId?: string | null;
  succeededAttemptId?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
};

export type TransitionEvent =
  | { type: "provider_sync_succeeded"; attemptId: string }
  | {
      type: "provider_sync_failed_definite";
      attemptId: string;
      code: string;
      message: string;
    }
  | { type: "provider_sync_unknown"; attemptId: string }
  | { type: "provider_webhook_succeeded"; attemptId: string }
  | {
      type: "provider_webhook_failed";
      attemptId: string;
      code: string;
      message: string;
    }
  | { type: "processing_deadline_exceeded" };

export type TransitionResult =
  | { ok: true; payment: Payment }
  | { ok: false; error: "TERMINAL_STATE" | "INVALID_TRANSITION"; reason: string };

const isTerminal = (status: PaymentStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "manual_review";

export function applyPaymentTransition(
  payment: Payment,
  event: TransitionEvent,
): TransitionResult {
  if (isTerminal(payment.status)) {
    return {
      ok: false,
      error: "TERMINAL_STATE",
      reason: `Cannot transition from terminal state ${payment.status}.`,
    };
  }

  if (payment.status === "created") {
    switch (event.type) {
      case "provider_sync_succeeded":
        return {
          ok: true,
          payment: {
            ...payment,
            status: "succeeded",
            latestAttemptId: event.attemptId,
            succeededAttemptId: event.attemptId,
            failureCode: null,
            failureMessage: null,
          },
        };
      case "provider_sync_failed_definite":
        return {
          ok: true,
          payment: {
            ...payment,
            status: "failed",
            latestAttemptId: event.attemptId,
            failureCode: event.code,
            failureMessage: event.message,
          },
        };
      case "provider_sync_unknown":
        return {
          ok: true,
          payment: {
            ...payment,
            status: "processing",
            latestAttemptId: event.attemptId,
          },
        };
      default:
        return {
          ok: false,
          error: "INVALID_TRANSITION",
          reason: `Event ${event.type} is not allowed from created.`,
        };
    }
  }

  if (payment.status === "processing") {
    switch (event.type) {
      case "provider_webhook_succeeded":
        return {
          ok: true,
          payment: {
            ...payment,
            status: "succeeded",
            latestAttemptId: event.attemptId,
            succeededAttemptId: event.attemptId,
            failureCode: null,
            failureMessage: null,
          },
        };
      case "provider_webhook_failed":
        return {
          ok: true,
          payment: {
            ...payment,
            status: "failed",
            latestAttemptId: event.attemptId,
            failureCode: event.code,
            failureMessage: event.message,
          },
        };
      case "processing_deadline_exceeded":
        return {
          ok: true,
          payment: {
            ...payment,
            status: "manual_review",
          },
        };
      default:
        return {
          ok: false,
          error: "INVALID_TRANSITION",
          reason: `Event ${event.type} is not allowed from processing.`,
        };
    }
  }

  return {
    ok: false,
    error: "INVALID_TRANSITION",
    reason: `Unknown current status ${payment.status}.`,
  };
}
