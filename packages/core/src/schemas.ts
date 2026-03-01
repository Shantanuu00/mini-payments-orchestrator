import { z } from "zod";

export const paymentStatusSchema = z.enum([
  "created",
  "processing",
  "succeeded",
  "failed",
  "manual_review",
]);

export const createPaymentSchema = z.object({
  merchantId: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().length(3).toUpperCase(),
});

export const confirmPaymentSchema = z.object({
  paymentId: z.string().uuid(),
  merchantId: z.string().min(1),
  connector: z.literal("mock").default("mock"),
  idempotencyKey: z.string().min(1),
});

export const getPaymentParamsSchema = z.object({
  paymentId: z.string().uuid(),
});

export const webhookSchema = z.object({
  connector: z.literal("mock"),
  providerEventId: z.string().min(1),
  paymentId: z.string().uuid(),
  attemptId: z.string().uuid(),
  outcome: z.enum(["succeeded", "failed"]),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentSchema>;
export type WebhookInput = z.infer<typeof webhookSchema>;
