import { v } from "../common/validator.ts";

export const PRODUCT_TYPES = [
  "wordpress_plugin",
  "wordpress_theme",
  "licensed_software",
  "saas_application",
  "dedicated_deployment",
  "digital_service",
  "other",
] as const;

export type ProductType = (typeof PRODUCT_TYPES)[number];

export const FULFILLMENT_TYPES = [
  "software_license",
  "saas_provision",
  "digital_service",
  "custom",
] as const;

export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const DISTRIBUTION_CHANNELS = [
  "wordpress",
  "hosted_saas",
  "dedicated_deployment",
  "api",
  "direct_download",
  "service_delivery",
] as const;
export type DistributionChannelKey = (typeof DISTRIBUTION_CHANNELS)[number];

export const FEATURE_VALUE_TYPES = ["boolean", "limit", "quota", "metered"] as const;
export type FeatureValueType = (typeof FEATURE_VALUE_TYPES)[number];

export type TypedEntitlementValue =
  | { value_type: "boolean"; value: boolean }
  | { value_type: "limit"; value: number | null; unlimited?: boolean; unit?: string }
  | {
      value_type: "quota";
      value: number | null;
      unlimited?: boolean;
      unit?: string;
      period?: "day" | "month" | "year";
    }
  | {
      value_type: "metered";
      value: number | null;
      unlimited?: boolean;
      unit?: string;
      period?: "day" | "month" | "year";
      overage_policy?: "block" | "allow_and_log";
    };

/**
 * Validates that an entitlement value strictly conforms to its declared FeatureValueType.
 * Rejects negative limits/quotas and requires explicit {"unlimited": true} instead of magic numbers.
 */
export function validateFeatureEntitlementValue(
  expectedType: FeatureValueType,
  raw: unknown
): TypedEntitlementValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Entitlement value must be a structured object.");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.value_type !== expectedType) {
    throw new Error(
      `Entitlement value_type '${String(obj.value_type)}' does not match feature type '${expectedType}'.`
    );
  }

  if (expectedType === "boolean") {
    if (typeof obj.value !== "boolean") {
      throw new Error("Boolean feature requires a boolean 'value'.");
    }
    return { value_type: "boolean", value: obj.value };
  }

  const isUnlimited = obj.unlimited === true;
  if (isUnlimited) {
    if (obj.value !== null && obj.value !== undefined) {
      throw new Error("When 'unlimited' is true, numeric 'value' must be null or omitted.");
    }
  } else {
    if (typeof obj.value !== "number" || !Number.isSafeInteger(obj.value) || obj.value < 0) {
      throw new Error(
        `${expectedType} feature requires a non-negative integer 'value' or explicit {"unlimited": true}.`
      );
    }
  }

  const unit = typeof obj.unit === "string" && obj.unit.trim() ? obj.unit.trim() : undefined;
  if (expectedType === "limit") {
    return {
      value_type: "limit",
      value: isUnlimited ? null : (obj.value as number),
      ...(isUnlimited ? { unlimited: true } : {}),
      ...(unit ? { unit } : {}),
    };
  }

  const period =
    obj.period === "day" || obj.period === "month" || obj.period === "year" ? obj.period : "month";

  if (expectedType === "quota") {
    return {
      value_type: "quota",
      value: isUnlimited ? null : (obj.value as number),
      ...(isUnlimited ? { unlimited: true } : {}),
      ...(unit ? { unit } : {}),
      period,
    };
  }

  const overagePolicy = obj.overage_policy === "allow_and_log" ? "allow_and_log" : "block";
  return {
    value_type: "metered",
    value: isUnlimited ? null : (obj.value as number),
    ...(isUnlimited ? { unlimited: true } : {}),
    ...(unit ? { unit } : {}),
    period,
    overage_policy: overagePolicy,
  };
}

export const CreateProductSchema = v.object({
  code: v
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[A-Z0-9_-]+$/, "Product code must contain uppercase letters, digits, hyphens, or underscores."),
  slug: v
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, "Product slug must be lowercase kebab-case."),
  name: v.string().trim().min(2).max(200),
  description: v.string().trim().max(4000).optional(),
  product_type: v.enum(PRODUCT_TYPES),
  fulfillment_type: v.enum(FULFILLMENT_TYPES).default("software_license"),
  distribution_channels: v.array(v.enum(DISTRIBUTION_CHANNELS), { min: 1 }).optional(),
  website_url: v.string().url().optional(),
  documentation_url: v.string().url().optional(),
  // E-13 (PRD §5.1): logo is an R2 object reference — the id of an
  // uploaded asset (FK products.logo_asset_id → uploaded_assets.id).
  // Validated against the asset table in the catalog service; the SPA
  // picks it with the media picker.
  logo_asset_id: v.string().uuid().optional(),
  default_activation_limit: v.number().int().min(1).max(10000).default(1),
  offline_grace_hours: v.number().int().min(0).max(720).default(72),
});

export const UpdateProductSchema = v.object({
  name: v.string().trim().min(2).max(200).optional(),
  description: v.string().trim().max(4000).nullable().optional(),
  website_url: v.string().url().nullable().optional(),
  documentation_url: v.string().url().nullable().optional(),
  // E-13: nullable — an explicit null clears the logo.
  logo_asset_id: v.string().uuid().nullable().optional(),
});

export const CreateProductFeatureSchema = v.object({
  feature_key: v
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(120)
    .regex(/^[a-z][a-z0-9_.]*$/, "feature_key must start with a lowercase letter and use snake_case or dotted notation."),
  name: v.string().trim().min(2).max(160),
  description: v.string().trim().max(2000).optional(),
  value_type: v.enum(FEATURE_VALUE_TYPES),
  unit: v.string().trim().max(50).optional(),
  default_value: v.unknown().optional(),
});

/**
 * Bulk feature create — envelope only. Each row is validated
 * individually against CreateProductFeatureSchema by the service
 * (safeParse per row), so one bad row is reported per-row instead of
 * failing the whole request. Cap 100 rows per request.
 */
export const BulkCreateProductFeaturesSchema = v.object({
  features: v.array(v.unknown(), { min: 1, max: 100 }),
});

export const PackageFeatureGrantInputSchema = v.object({
  product_feature_id: v.string().uuid(),
  entitlement_value: v.unknown(),
});

export const CreateProductPackageSchema = v.object({
  package_key: v
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9_-]+$/),
  name: v.string().trim().min(2).max(160),
  description: v.string().trim().max(2000).optional(),
  features: v.array(PackageFeatureGrantInputSchema, { min: 0 }).default([]),
  change_summary: v.string().trim().max(500).optional(),
});

export const PRICE_KINDS = ["free", "one_time", "recurring", "lifetime"] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

export const INTERVAL_UNITS = ["day", "week", "month", "year"] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export const CreatePackagePriceSchema = v
  .object({
    price_key: v
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(100)
      .regex(/^[a-z0-9_-]+$/),
    price_kind: v.enum(PRICE_KINDS),
    amount_minor: v.number().int().nonnegative(),
    currency_code: v.string().trim().min(3).max(3).default("BDT"),
    interval_unit: v.enum(INTERVAL_UNITS).nullable().optional(),
    interval_count: v.number().int().positive().nullable().optional(),
    trial_days: v.number().int().nonnegative().default(0),
    setup_fee_minor: v.number().int().nonnegative().default(0),
  })
  .refine((val) => {
    if (val.price_kind === "free") {
      return val.amount_minor === 0 && val.setup_fee_minor === 0 && !val.interval_unit && !val.interval_count;
    }
    if (val.price_kind === "recurring") {
      return Boolean(val.interval_unit) && typeof val.interval_count === "number" && val.interval_count > 0;
    }
    if (val.price_kind === "one_time" || val.price_kind === "lifetime") {
      return !val.interval_unit && !val.interval_count;
    }
    return true;
  }, "Price interval configuration does not match price_kind rules (Database Design §10.4).");

/**
 * Feature key and value_type are deliberately NOT updatable (API Spec §9.2):
 * a feature used by a published package or license snapshot must not be
 * silently renamed or retyped.
 */
export const UpdateProductFeatureSchema = v.object({
  name: v.string().trim().min(2).max(160).optional(),
  description: v.string().trim().max(2000).nullable().optional(),
  unit: v.string().trim().max(50).nullable().optional(),
  default_value: v.unknown().optional(),
});

export const UpdateProductPackageSchema = v.object({
  name: v.string().trim().min(2).max(160).optional(),
  description: v.string().trim().max(2000).nullable().optional(),
});

export const UpdatePackagePriceSchema = v.object({
  amount_minor: v.number().int().nonnegative().optional(),
  currency_code: v.string().trim().min(3).max(3).optional(),
  interval_unit: v.enum(INTERVAL_UNITS).nullable().optional(),
  interval_count: v.number().int().positive().nullable().optional(),
  trial_days: v.number().int().nonnegative().optional(),
  setup_fee_minor: v.number().int().nonnegative().optional(),
});
