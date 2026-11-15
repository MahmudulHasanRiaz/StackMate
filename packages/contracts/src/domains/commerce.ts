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
  "paid",
  "partially_refunded",
  "refunded",
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export const ORDER_SOURCES = ["admin", "website", "api", "import"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const CreateCustomerSchema = v.object({
  customer_type: v.enum(["person", "business"] as const).default("person"),
  name: v.string().trim().min(2).max(200),
  email: v.string().trim().email().optional(),
  phone: v.string().trim().min(6).max(40).optional(),
  company_name: v.string().trim().max(200).optional(),
  country_code: v.string().trim().min(2).max(2).default("BD"),
  notes: v.string().trim().max(2000).optional(),
});

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

export const AdminCreateOrderSchema = v.object({
  customer_id: v.string().uuid(),
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
});

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
  company_name: v.string().trim().max(200).nullable().optional(),
  country_code: v.string().trim().min(2).max(2).optional(),
  status: v.enum(CUSTOMER_STATUSES).optional(),
  notes: v.string().trim().max(2000).nullable().optional(),
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
