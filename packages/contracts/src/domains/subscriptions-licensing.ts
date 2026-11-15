import { v } from "../common/validator.ts";
import type { TypedEntitlementValue } from "./catalog.ts";

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "pending",
  "active",
  "past_due",
  "paused",
  "cancelled",
  "expired",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const LICENSE_STATUSES = ["pending", "active", "expired", "suspended", "revoked"] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export const ACTIVATION_STATUSES = ["active", "deactivated", "blocked"] as const;
export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number];

export const ACTIVATION_ENVIRONMENTS = ["production", "staging", "development", "other"] as const;
export type ActivationEnvironment = (typeof ACTIVATION_ENVIRONMENTS)[number];

export const ActivateLicenseRequestSchema = v.object({
  license_key: v.string().trim().min(12).max(128),
  product_code: v.string().trim().min(2).max(60),
  integration_profile: v.string().trim().min(2).max(80).default("default"),
  installation_id: v.string().trim().min(6).max(200),
  site_url: v.string().url().optional(),
  environment: v.enum(ACTIVATION_ENVIRONMENTS).default("production"),
  product_version: v.string().trim().max(60).optional(),
  client_version: v.string().trim().max(60).optional(),
});

export const ValidateLicenseRequestSchema = v.object({
  license_key: v.string().trim().min(12).max(128),
  product_code: v.string().trim().min(2).max(60),
  integration_profile: v.string().trim().min(2).max(80).default("default"),
  installation_id: v.string().trim().min(6).max(200),
  site_url: v.string().url().optional(),
  environment: v.enum(ACTIVATION_ENVIRONMENTS).default("production"),
  product_version: v.string().trim().max(60).optional(),
});

export const DeactivateLicenseRequestSchema = v.object({
  license_key: v.string().trim().min(12).max(128),
  product_code: v.string().trim().min(2).max(60),
  integration_profile: v.string().trim().min(2).max(80).default("default"),
  installation_id: v.string().trim().min(6).max(200),
  reason: v.string().trim().max(200).optional(),
});

export const AdminManualGrantLicenseSchema = v.object({
  customer_id: v.string().uuid(),
  product_id: v.string().uuid(),
  activation_limit: v.number().int().min(1).max(10000).default(1),
  expires_at: v.string().trim().nullable().optional(),
  reason: v.string().trim().min(3).max(500),
  entitlements: v.record(v.unknown()),
});

export interface EntitlementTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  entitlement_version: number;
  product_code: string;
  license_status: LicenseStatus;
  grace_until: string | null;
  activation_usage: {
    active_count: number;
    activation_limit: number;
  };
  entitlements: Record<string, TypedEntitlementValue>;
}

/**
 * Normalizes a domain or URL to a lowercase ASCII hostname without scheme, port, or path.
 */
export function normalizeInstallationDomain(urlOrDomain: string): string {
  const trimmed = urlOrDomain.trim().toLowerCase();
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  const host = parsed.hostname.replace(/^www\./, "").replace(/\.$/, "");
  if (!host || host.length > 253) {
    throw new Error(`Invalid domain in '${urlOrDomain}'.`);
  }
  return host;
}
