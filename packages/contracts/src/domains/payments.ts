import { v } from "../common/validator.ts";

export const PAYMENT_PROVIDER_TYPES = ["manual_mfs", "manual_bank", "automated"] as const;
export type PaymentProviderType = (typeof PAYMENT_PROVIDER_TYPES)[number];

export const PAYMENT_METHOD_KINDS = ["mfs_account", "bank_account", "automated_checkout"] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export const MFS_ACCOUNT_TYPES = ["personal", "merchant", "agent"] as const;
export type MfsAccountType = (typeof MFS_ACCOUNT_TYPES)[number];

export const TRANSACTION_ID_REQUIREMENTS = ["required", "optional", "disabled"] as const;
export type TransactionIdRequirement = (typeof TRANSACTION_ID_REQUIREMENTS)[number];

export const BANK_TRANSFER_RAILS = ["npsb", "beftn", "rtgs"] as const;
export type BankTransferRail = (typeof BANK_TRANSFER_RAILS)[number];

export const PAYMENT_SUBMISSION_STATUSES = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type PaymentSubmissionStatus = (typeof PAYMENT_SUBMISSION_STATUSES)[number];

export const CreatePaymentMethodSchema = v.object({
  provider_id: v.string().uuid(),
  method_key: v
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9_-]+$/),
  display_name: v.string().trim().min(2).max(160),
  method_kind: v.enum(PAYMENT_METHOD_KINDS),
  account_type: v.enum(MFS_ACCOUNT_TYPES).nullable().optional(),
  account_label: v.string().trim().max(160).optional(),
  instructions: v.string().trim().max(1000).optional(),
  configuration: v.object({
    account_number: v.string().trim().min(4).max(60),
    account_holder_name: v.string().trim().max(160).optional(),
    bank_name: v.string().trim().max(160).optional(),
    branch_name: v.string().trim().max(160).optional(),
    routing_number: v.string().trim().max(60).optional(),
    transaction_id_requirement: v.enum(TRANSACTION_ID_REQUIREMENTS).default("required"),
  }),
  transfer_rails: v.array(v.enum(BANK_TRANSFER_RAILS)).default([]),
  is_enabled: v.boolean().default(true),
  sort_order: v.number().int().min(0).max(10000).default(0),
});

export const SubmitManualPaymentSchema = v.object({
  payment_method_id: v.string().uuid(),
  amount_minor: v.number().int().positive(),
  currency_code: v.string().trim().min(3).max(3).default("BDT"),
  // Null-tolerant (ADR-0009 decision 11): JSON null ≡ absent for every
  // optional field, so callers that send null for empties do not 422.
  sender_phone: v.string().trim().min(6).max(40).nullable().optional(),
  sender_name: v.string().trim().max(160).nullable().optional(),
  sender_bank_name: v.string().trim().max(160).nullable().optional(),
  sender_account_reference: v.string().trim().max(160).nullable().optional(),
  transfer_rail: v.enum(BANK_TRANSFER_RAILS).nullable().optional(),
  transaction_id: v.string().trim().max(160).nullable().optional(),
  payment_date_display: v.string().trim().nullable().optional(), // DD/MM/YYYY if provided by customer
  evidence_asset_id: v.string().uuid().nullable().optional(),
  customer_note: v.string().trim().max(1000).nullable().optional(),
  // ADR-0009: partial payments. Any positive amount up to the order's
  // remaining balance is accepted; allocation is oldest-unpaid-installment
  // first unless a specific installment is named here.
  installment_id: v.string().uuid().nullable().optional(),
});

export const ApprovePaymentSubmissionSchema = v.object({
  verified_amount_minor: v.number().int().positive(),
  currency_code: v.string().trim().min(3).max(3).default("BDT"),
  verification_reference: v.string().trim().min(2).max(160),
  internal_note: v.string().trim().max(2000).nullable().optional(),
  // ADR-0009: apply part of the customer's credit balance to this order,
  // on top of the verified money. 0 = none. Capped at the customer's
  // credit balance and at the order's remaining amount; never silent.
  apply_credit_minor: v.number().int().nonnegative().default(0),
});

export const RejectPaymentSubmissionSchema = v.object({
  reason_code: v
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[A-Z0-9_]+$/),
  customer_message: v.string().trim().min(5).max(1000),
  internal_note: v.string().trim().max(2000).nullable().optional(),
});

/**
 * Manual refund (audit F-03, owner decision D-4): record money handed
 * back by hand against a payment transaction (preferred) or the latest
 * refundable transaction of an order. Mirrors
 * `RecordManualRefundInput` in modules/payments/service.ts — the service
 * re-validates the plain shape, so the rules hold whichever way it is
 * called. The route (app.ts) parses the body with this schema.
 * The two ids are plain non-empty strings, NOT uuid(): transaction and
 * order ids are store-assigned identifiers (the in-memory store uses
 * synthetic ids such as "txn-refund"); the service resolves them by
 * exact match and 404s on an unknown id, so a uuid() constraint here
 * would reject valid requests.
 */
export const RecordManualRefundSchema = v
  .object({
    payment_transaction_id: v.string().trim().min(1).nullable().optional(),
    order_id: v.string().trim().min(1).nullable().optional(),
    amount_minor: v.number().int().positive(),
    currency_code: v.string().trim().regex(/^[A-Za-z]{3}$/, "currency_code must be a 3-letter code."),
    reason: v.string().trim().min(1).max(1000),
    provider_refund_id: v.string().trim().max(180).nullable().optional(),
  })
  .refine(
    (val) => Boolean(val.payment_transaction_id) !== Boolean(val.order_id),
    "Provide exactly one of payment_transaction_id or order_id."
  );

export const CreatePaymentProviderSchema = v.object({
  provider_key: v
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9_-]+$/),
  display_name: v.string().trim().min(2).max(160),
  provider_type: v.enum(PAYMENT_PROVIDER_TYPES),
  adapter_key: v.string().trim().min(2).max(100),
  status: v.enum(["enabled", "disabled"] as const).default("enabled"),
});

export const UpdatePaymentProviderSchema = v.object({
  display_name: v.string().trim().min(2).max(160).optional(),
  adapter_key: v.string().trim().min(2).max(100).optional(),
  status: v.enum(["enabled", "disabled"] as const).optional(),
});

export const UpdatePaymentMethodSchema = v.object({
  display_name: v.string().trim().min(2).max(160).optional(),
  account_label: v.string().trim().max(160).nullable().optional(),
  instructions: v.string().trim().max(1000).nullable().optional(),
  configuration: v
    .object({
      account_number: v.string().trim().min(4).max(60).optional(),
      account_holder_name: v.string().trim().max(160).nullable().optional(),
      bank_name: v.string().trim().max(160).nullable().optional(),
      branch_name: v.string().trim().max(160).nullable().optional(),
      routing_number: v.string().trim().max(60).nullable().optional(),
      transaction_id_requirement: v.enum(TRANSACTION_ID_REQUIREMENTS).optional(),
    })
    .optional(),
  transfer_rails: v.array(v.enum(BANK_TRANSFER_RAILS)).optional(),
  sort_order: v.number().int().min(0).max(10000).optional(),
});
