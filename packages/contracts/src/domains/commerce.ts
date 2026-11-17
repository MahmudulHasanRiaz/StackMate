import { sha256Hex } from "../common/sha256.ts";
import { v } from "../common/validator.ts";
import { INTERVAL_UNITS, PRICE_KINDS } from "./catalog.ts";

export const ORDER_STATUSES = [
  "draft",
  "awaiting_payment",
  "processing",
  "completed",
  "cancelled",
  "failed",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_PAYMENT_STATUSES = [
  "unpaid",
  "pending_verification",
  "partially_paid",
  "paid",
  "partially_refunded",
  "refunded",
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export const ORDER_SOURCES = ["admin", "website", "api", "import"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

// Contact rule (ADR-0009): a customer needs AT LEAST ONE of email/phone.
// Enforced here at the schema boundary (both create and inline-create in
// orders) and again in the service, which also runs the dedupe resolver.
export const CreateCustomerSchema = v
  .object({
    customer_type: v.enum(["person", "business"] as const).default("person"),
    name: v.string().trim().min(2).max(200),
    email: v.string().trim().email().optional(),
    phone: v.string().trim().min(6).max(40).optional(),
    whatsapp: v.string().trim().min(6).max(40).optional(),
    company_name: v.string().trim().max(200).optional(),
    country_code: v.string().trim().min(2).max(2).default("BD"),
    notes: v.string().trim().max(2000).optional(),
  })
  .refine(
    (val) => Boolean(val.email?.trim() || val.phone?.trim()),
    "At least one of email or phone is required."
  );

export const CheckoutOrderItemInputSchema = v.object({
  product_slug: v.string().trim().min(2).max(120),
  package_version_id: v.string().uuid(),
  price_id: v.string().uuid(),
  quantity: v.number().int().min(1).max(100).default(1),
});

export const PublicCreateCheckoutOrderSchema = v.object({
  items: v.array(CheckoutOrderItemInputSchema, { min: 1, max: 10 }),
  customer: v.object({
    name: v.string().trim().min(2).max(200),
    email: v.string().trim().email().optional(),
    phone: v.string().trim().min(6).max(40).optional(),
    company_name: v.string().trim().max(200).optional(),
  }),
  billing_address: v
    .object({
      country_code: v.string().trim().min(2).max(2).default("BD"),
      address_line_1: v.string().trim().max(250).optional(),
      city: v.string().trim().max(120).optional(),
      postal_code: v.string().trim().max(40).optional(),
    })
    .optional(),
  discount_code: v.string().trim().max(80).nullable().optional(),
  customer_note: v.string().trim().max(1000).nullable().optional(),
  attribution: v
    .object({
      utm_source: v.string().trim().max(120).optional(),
      utm_medium: v.string().trim().max(120).optional(),
      utm_campaign: v.string().trim().max(120).optional(),
      utm_content: v.string().trim().max(120).optional(),
      utm_term: v.string().trim().max(120).optional(),
      fbp: v.string().trim().max(200).optional(),
      fbc: v.string().trim().max(200).optional(),
    })
    .optional(),
});

export const AdminCustomFeatureItemSchema = v.object({
  product_feature_id: v.string().uuid(),
  entitlement_value: v.unknown(),
});

/**
 * Payment plan for an order (ADR-0009). The plan is built into
 * order_installments rows at order creation; due dates are DD/MM/YYYY
 * display strings at the boundary and stored as dates.
 *  - full: one installment for the whole total, due on `due_date`
 *    (default: today).
 *  - advance_rest: an advance (amount or percent of the total) due on
 *    `due_date`, the rest due on `rest_due_date`.
 *  - equal_installments: N equal parts, every `interval_days` from
 *    `start_date`; the remainder minor units land on the last part.
 */
export const PaymentPlanSchema = v
  .object({
    kind: v.enum(["full", "advance_rest", "equal_installments"] as const).default("full"),
    due_date: v.string().trim().optional(),
    advance_amount_minor: v.number().int().positive().optional(),
    advance_percent: v.number().int().min(1).max(99).optional(),
    rest_due_date: v.string().trim().optional(),
    installment_count: v.number().int().min(2).max(24).optional(),
    interval_days: v.number().int().min(1).max(365).optional(),
    start_date: v.string().trim().optional(),
  })
  .refine(
    (val) =>
      val.kind !== "advance_rest" ||
      (Boolean(val.advance_amount_minor ?? val.advance_percent) && Boolean(val.rest_due_date)),
    "advance_rest needs an advance amount or percent and a rest due date."
  )
  .refine(
    (val) =>
      val.kind !== "equal_installments" ||
      (Boolean(val.installment_count) && Boolean(val.interval_days)),
    "equal_installments needs an installment count and an interval in days."
  );

export const ACTIVATION_MODES = ["on_full_payment", "on_percent", "on_date"] as const;
export type ActivationMode = (typeof ACTIVATION_MODES)[number];

export const AdminCreateOrderSchema = v
  .object({
    customer_id: v.string().uuid().optional(),
    // Inline customer creation (same validation + dedupe as POST /customers).
    // Exactly one of customer_id / new_customer must be present.
    new_customer: CreateCustomerSchema.optional(),
    product_id: v.string().uuid(),
    item_kind: v.enum(["package", "custom", "one_time_product", "other"] as const).default("package"),
    package_version_id: v.string().uuid().nullable().optional(),
    package_price_id: v.string().uuid().nullable().optional(),
    custom_offer: v
      .object({
        label: v.string().trim().min(2).max(160),
        price_kind: v.enum(PRICE_KINDS),
        unit_amount_minor: v.number().int().nonnegative(),
        currency_code: v.string().trim().min(3).max(3).default("BDT"),
        interval_unit: v.enum(INTERVAL_UNITS).nullable().optional(),
        interval_count: v.number().int().positive().nullable().optional(),
        activation_limit: v.number().int().min(1).max(10000).default(1),
        features: v.array(AdminCustomFeatureItemSchema, { min: 1 }),
      })
      .optional(),
    quantity: v.number().int().min(1).max(100).default(1),
    discount_minor: v.number().int().nonnegative().default(0),
    tax_minor: v.number().int().nonnegative().default(0),
    customer_note: v.string().trim().max(1000).optional(),
    internal_note: v.string().trim().max(2000).optional(),
    payment_method_id: v.string().uuid().nullable().optional(),
    payment_plan: PaymentPlanSchema.optional(),
    // License activation policy (ADR-0009). on_percent needs
    // activation_percent (1–100); on_date needs activation_date.
    activation_mode: v.enum(ACTIVATION_MODES).default("on_full_payment"),
    activation_percent: v.number().int().min(1).max(100).nullable().optional(),
    activation_date: v.string().trim().nullable().optional(),
    suspend_on_missed_schedule: v.boolean().default(false),
    grace_days: v.number().int().min(0).max(90).default(3),
    // Lead this order converts (marks the lead converted on creation).
    lead_id: v.string().uuid().nullable().optional(),
  })
  .refine(
    (val) => Boolean(val.customer_id) !== Boolean(val.new_customer),
    "Provide exactly one of customer_id or new_customer."
  )
  .refine(
    (val) =>
      val.activation_mode !== "on_percent" ||
      (typeof val.activation_percent === "number" && val.activation_percent >= 1),
    "on_percent activation needs activation_percent (1–100)."
  )
  .refine(
    (val) =>
      val.activation_mode !== "on_date" || Boolean(val.activation_date?.trim()),
    "on_date activation needs activation_date."
  );

export interface SnapshotItemToHash {
  feature_key: string;
  value_type: string;
  entitlement_value: unknown;
  unit?: string | null;
}

export const CUSTOMER_STATUSES = ["active", "inactive", "blocked"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const UpdateCustomerSchema = v.object({
  name: v.string().trim().min(2).max(200).optional(),
  email: v.string().trim().email().nullable().optional(),
  phone: v.string().trim().min(6).max(40).nullable().optional(),
  whatsapp: v.string().trim().min(6).max(40).nullable().optional(),
  company_name: v.string().trim().max(200).nullable().optional(),
  country_code: v.string().trim().min(2).max(2).optional(),
  status: v.enum(CUSTOMER_STATUSES).optional(),
  notes: v.string().trim().max(2000).nullable().optional(),
});

/** Billing/shipping address for a customer (table exists since 0000). */
export const CreateCustomerAddressSchema = v.object({
  address_type: v.enum(["billing", "shipping", "other"] as const).default("billing"),
  contact_name: v.string().trim().max(200).optional(),
  phone: v.string().trim().min(6).max(40).optional(),
  address_line_1: v.string().trim().max(250).optional(),
  address_line_2: v.string().trim().max(250).optional(),
  city: v.string().trim().max(120).optional(),
  state_or_region: v.string().trim().max(120).optional(),
  postal_code: v.string().trim().max(40).optional(),
  country_code: v.string().trim().min(2).max(2).default("BD"),
  is_default: v.boolean().default(false),
});

export const UpdateCustomerAddressSchema = v.object({
  address_type: v.enum(["billing", "shipping", "other"] as const).optional(),
  contact_name: v.string().trim().max(200).nullable().optional(),
  phone: v.string().trim().min(6).max(40).nullable().optional(),
  address_line_1: v.string().trim().max(250).nullable().optional(),
  address_line_2: v.string().trim().max(250).nullable().optional(),
  city: v.string().trim().max(120).nullable().optional(),
  state_or_region: v.string().trim().max(120).nullable().optional(),
  postal_code: v.string().trim().max(40).nullable().optional(),
  country_code: v.string().trim().min(2).max(2).optional(),
  is_default: v.boolean().optional(),
});

/** Staff report filed on a customer (ADR-0009). */
export const CreateCustomerReportSchema = v.object({
  type: v.enum(["note", "concern"] as const).default("note"),
  detail: v.string().trim().min(2).max(4000),
});

/**
 * Split a secondary contact into its own customer (ADR-0009). The phone
 * that arrived with that email moves with it as the new profile's main
 * phone; the admin may pick a different phone. When omitted, the service
 * uses the phone from the latest order placed with that email, else none.
 */
export const SplitCustomerContactSchema = v.object({
  contact_kind: v.enum(["email", "phone"] as const),
  value: v.string().trim().min(1).max(320),
  new_customer_name: v.string().trim().min(2).max(200).optional(),
  phone: v.string().trim().min(6).max(40).nullable().optional(),
});

/** Admin edits to one installment (due date / notes; audit-logged). */
export const UpdateInstallmentSchema = v.object({
  due_date: v.string().trim().optional(),
  notes: v.string().trim().max(1000).nullable().optional(),
});

/**
 * Computes a deterministic SHA-256 hex digest of an entitlement set for immutable snapshots.
 */
export function computeCanonicalSnapshotHash(items: ReadonlyArray<SnapshotItemToHash>): string {
  const sorted = [...items].sort((a, b) => a.feature_key.localeCompare(b.feature_key));
  const canonical = sorted.map((item) => ({
    feature_key: item.feature_key,
    value_type: item.value_type,
    entitlement_value: item.entitlement_value,
    unit: item.unit ?? null,
  }));
  return sha256Hex(JSON.stringify(canonical));
}
