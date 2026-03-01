export type PaymentStatus =
  | "created"
  | "processing"
  | "succeeded"
  | "failed"
  | "manual_review";

export type AttemptStatus = "started" | "succeeded" | "failed" | "unknown";

export type Payment = {
  id: string;
  merchantId: string;
  amount: number;   // smallest unit
  currency: string; // "INR"
  status: PaymentStatus;
  succeededAttemptId?: string | null;
  latestAttemptId?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
};

export type TransitionResult =
  | { ok: true; next: Payment; reason: string }
  | { ok: false; error: string; reason: string };

const isTerminal = (s: PaymentStatus) =>
  s === "succeeded" || s === "failed" || s === "manual_review";

export type TransitionEvent =
  | { type: "confirm_requested" }
  | { type: "provider_sync_succeeded"; attemptId: string }
  | { type: "provider_sync_failed_definite"; code: string; message: string; attemptId: string }
  | { type: "provider_sync_unknown"; attemptId: string } // timeout/5xx
  | { type: "provider_webhook_succeeded"; attemptId: string }
  | { type: "provider_webhook_failed"; code: string; message: string; attemptId: string }
  | { type: "processing_deadline_exceeded" };

export function applyPaymentTransition(
  current: Payment,
  event: TransitionEvent
): TransitionResult {
  // Safety invariant: terminal states do not regress
  if (isTerminal(current.status)) {
    return {
      ok: false,
      error: "TERMINAL_STATE",
      reason: `Cannot apply ${event.type} when payment is terminal (${current.status}).`,
    };
  }

  switch (current.status) {
    case "created": {
      switch (event.type) {
        case "provider_sync_succeeded":
          return {
            ok: true,
            reason: "Sync success finalizes payment.",
            next: {
              ...current,
              status: "succeeded",
              succeededAttemptId: event.attemptId,
              latestAttemptId: event.attemptId,
              failureCode: null,
              failureMessage: null,
            },
          };

        case "provider_sync_failed_definite":
          return {
            ok: true,
            reason: "Sync definite failure finalizes payment.",
            next: {
              ...current,
              status: "failed",
              latestAttemptId: event.attemptId,
              failureCode: event.code,
              failureMessage: event.message,
            },
          };

        case "provider_sync_unknown":
          return {
            ok: true,
            reason: "Unknown outcome moves payment to processing.",
            next: {
              ...current,
              status: "processing",
              latestAttemptId: event.attemptId,
            },
          };

        // confirm_requested is an API-level event; state change occurs based on provider result.
        case "confirm_requested":
          return { ok: true, reason: "No-op. Await provider result.", next: current };

        default:
          return {
            ok: false,
            error: "INVALID_TRANSITION",
            reason: `Event ${event.type} not allowed from created.`,
          };
      }
    }

    case "processing": {
      switch (event.type) {
        case "provider_webhook_succeeded":
          return {
            ok: true,
            reason: "Webhook success finalizes payment.",
            next: {
              ...current,
              status: "succeeded",
              succeededAttemptId: event.attemptId,
              latestAttemptId: event.attemptId,
              failureCode: null,
              failureMessage: null,
            },
          };

        case "provider_webhook_failed":
          return {
            ok: true,
            reason: "Webhook failure finalizes payment.",
            next: {
              ...current,
              status: "failed",
              latestAttemptId: event.attemptId,
              failureCode: event.code,
              failureMessage: event.message,
            },
          };

        case "processing_deadline_exceeded":
          return {
            ok: true,
            reason: "SLA exceeded; escalate for review.",
            next: {
              ...current,
              status: "manual_review",
            },
          };

        default:
          return {
            ok: false,
            error: "INVALID_TRANSITION",
            reason: `Event ${event.type} not allowed from processing.`,
          };
      }
    }

    default:
      return { ok: false, error: "UNKNOWN_STATE", reason: "Unhandled state." };
  }
}