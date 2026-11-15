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
  sender_phone: v.string().trim().min(6).max(40).optional(),
  sender_name: v.string().trim().max(160).optional(),
  sender_bank_name: v.string().trim().max(160).optional(),
  sender_account_reference: v.string().trim().max(160).optional(),
  transfer_rail: v.enum(BANK_TRANSFER_RAILS).optional(),
  transaction_id: v.string().trim().max(160).optional(),
  payment_date_display: v.string().trim().optional(), // DD/MM/YYYY if provided by customer
  evidence_asset_id: v.string().uuid().optional(),
  customer_note: v.string().trim().max(1000).optional(),
});

export const ApprovePaymentSubmissionSchema = v.object({
  verified_amount_minor: v.number().int().positive(),
  currency_code: v.string().trim().min(3).max(3).default("BDT"),
  verification_reference: v.string().trim().min(2).max(160),
  internal_note: v.string().trim().max(2000).optional(),
});

export const RejectPaymentSubmissionSchema = v.object({
  reason_code: v
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[A-Z0-9_]+$/),
  customer_message: v.string().trim().min(5).max(1000),
  internal_note: v.string().trim().max(2000).optional(),
});

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
