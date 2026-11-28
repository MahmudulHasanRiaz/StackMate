import { v } from "../common/validator.ts";

export const SITE_ENVIRONMENTS = ["production", "staging", "development"] as const;
export const SITE_STATUSES = ["pending_verification", "active", "suspended", "revoked"] as const;
export const CREDENTIAL_TYPES = [
  "public_key",
  "bearer_secret",
  "hmac_shared_secret",
  "public_signing_key",
] as const;

export const ALLOWED_TRACKING_EVENTS = [
  "PageView",
  "ViewContent",
  "Lead",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Purchase",
] as const;

// Tracking providers (PRD §15, owner decision 2026-11-15): Meta is live
// (delivery still a stub — Batch 4); TikTok is next, others later.
// The provider is a parameter on every pixel-group call — never
// hardcoded to "meta" in the service layer.
export const TRACKING_PROVIDERS = ["meta", "tiktok"] as const;

export type TrackingEventName = (typeof ALLOWED_TRACKING_EVENTS)[number];

export const RegisterIntegratedSiteSchema = v.object({
  name: v.string().trim().min(2).max(160),
  environment: v.enum(SITE_ENVIRONMENTS).default("production"),
  primary_domain: v.string().trim().min(3).max(253),
  product_ids: v.array(v.string().uuid(), { min: 1 }),
  allowed_capabilities: v
    .array(
      v.enum([
        "catalog.read",
        "checkout.create",
        "orders.read:own",
        "orders.cancel:own",
        "tracking.events.write",
        "webhooks.test",
        "leads.create",
      ] as const)
    )
    .default(["catalog.read", "checkout.create", "tracking.events.write"]),
});

export const CreateSiteCredentialSchema = v.object({
  credential_type: v.enum(CREDENTIAL_TYPES),
  scopes: v.array(v.string().trim().min(2).max(80), { min: 1 }),
});

export const ConfigureSiteTrackingSchema = v.object({
  provider: v.enum(TRACKING_PROVIDERS),
  pixel_id: v.string().trim().min(4).max(80),
  access_token: v.string().trim().min(12).max(512),
  test_event_code: v.string().trim().max(80).optional(),
  enabled_events: v.array(v.enum(ALLOWED_TRACKING_EVENTS), { min: 1 }),
  status: v.enum(["enabled", "disabled"] as const).default("enabled"),
});

// Pixel groups (migration 0006): one group per (site, provider,
// pixel_id). A group is a labelled tracking configuration — the
// Settings UI creates one row per group. The CAPI token is write-only:
// it is encrypted at rest and never returned by any read endpoint.
export const CreateTrackingConfigSchema = v.object({
  provider: v.enum(TRACKING_PROVIDERS),
  label: v.string().trim().min(1).max(120).optional(),
  pixel_id: v.string().trim().min(4).max(80),
  access_token: v.string().trim().min(12).max(512),
  test_event_code: v.string().trim().max(80).optional(),
  enabled_events: v.array(v.enum(ALLOWED_TRACKING_EVENTS), { min: 1 }),
  status: v.enum(["enabled", "disabled"] as const).default("enabled"),
});

// Partial update: every field optional; the service rejects a body
// that changes nothing (422). Supplying access_token re-encrypts the
// token and bumps rotated_at; omitting it keeps the stored token.
export const UpdateTrackingConfigSchema = v.object({
  provider: v.enum(TRACKING_PROVIDERS).optional(),
  label: v.string().trim().min(1).max(120).nullable().optional(),
  pixel_id: v.string().trim().min(4).max(80).optional(),
  access_token: v.string().trim().min(12).max(512).optional(),
  test_event_code: v.string().trim().max(80).nullable().optional(),
  enabled_events: v.array(v.enum(ALLOWED_TRACKING_EVENTS), { min: 1 }).optional(),
  status: v.enum(["enabled", "disabled"] as const).optional(),
});

export const IngestTrackingEventSchema = v.object({
  event_name: v.enum(ALLOWED_TRACKING_EVENTS),
  event_id: v.string().trim().min(6).max(160),
  event_time: v.string().trim(),
  event_source_url: v.string().url(),
  action_source: v.enum(["website", "system_generated"] as const).default("website"),
  order_reference: v.string().trim().max(80).optional(),
  user_data: v
    .object({
      email: v.string().trim().email().optional(),
      phone: v.string().trim().max(40).optional(),
      fbp: v.string().trim().max(200).optional(),
      fbc: v.string().trim().max(200).optional(),
    })
    .optional(),
  custom_data: v
    .object({
      content_ids: v.array(v.string().trim().max(80)).optional(),
      currency: v.string().trim().min(3).max(3).optional(),
      value_minor: v.number().int().nonnegative().optional(),
    })
    .optional(),
  consent: v.object({
    status: v.enum(["granted", "denied"] as const),
    policy_version: v.string().trim().min(2).max(40),
  }),
});

export const RegisterWebhookEndpointSchema = v.object({
  integrated_site_id: v.string().uuid().nullable().optional(),
  url: v.string().url(),
  description: v.string().trim().min(2).max(160),
  subscribed_events: v.array(v.string().trim().min(3).max(80), { min: 1 }),
});

export const SITE_CAPABILITIES = [
  "catalog.read",
  "checkout.create",
  "orders.read:own",
  "orders.cancel:own",
  "tracking.events.write",
  "webhooks.test",
  "leads.create",
] as const;

export const UpdateIntegratedSiteSchema = v.object({
  name: v.string().trim().min(2).max(160).optional(),
  environment: v.enum(SITE_ENVIRONMENTS).optional(),
  api_version: v.string().trim().min(1).max(30).optional(),
  allowed_capabilities: v.array(v.enum(SITE_CAPABILITIES)).optional(),
});

export const DOMAIN_VERIFICATION_METHODS = ["dns_txt", "http_file", "manual_review"] as const;

export const RegisterSiteDomainSchema = v.object({
  domain: v.string().trim().min(3).max(253),
  verification_method: v.enum(DOMAIN_VERIFICATION_METHODS).default("dns_txt"),
  is_primary: v.boolean().default(false),
});

export const VerifySiteDomainSchema = v.object({
  method: v.enum(DOMAIN_VERIFICATION_METHODS),
  reviewer_note: v.string().trim().min(2).max(1000).optional(),
});

export const CreateRoleSchema = v.object({
  key: v
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, "Role key must start with a lowercase letter and use snake_case."),
  name: v.string().trim().min(2).max(160),
  description: v.string().trim().max(500).optional(),
  // L-13: capped at 64 — the permission catalogue has 31 keys; 64
  // leaves room for growth and an unbounded array cannot be submitted.
  permissions: v.array(v.string().trim().min(2).max(80), { max: 64 }).default([]),
});

export const UpdateRoleSchema = v.object({
  name: v.string().trim().min(2).max(160).optional(),
  description: v.string().trim().max(500).nullable().optional(),
  // L-13: capped like the create schema — the catalogue has 31 keys;
  // 64 leaves room for growth and an unbounded array cannot be submitted.
  permissions: v.array(v.string().trim().min(2).max(80), { max: 64 }).optional(),
});

export const CreateStaffInvitationSchema = v.object({
  name: v.string().trim().min(2).max(200),
  email: v.string().trim().email(),
  role_keys: v.array(v.string().trim().min(2).max(80), { min: 1 }),
});

export const AcceptStaffInvitationSchema = v.object({
  token: v.string().trim().min(32).max(200),
  name: v.string().trim().min(2).max(200),
  // F-05: length-only is no longer the whole policy — a common /
  // breached password is rejected here too (same check as the
  // server-side assertPasswordNotCommon in identity/service.ts).
  password: v
    .string()
    .min(10)
    .max(200)
    .refine(
      (pw) => !isCommonPassword(pw),
      "This password is too common or has appeared in data breaches. Choose a different password."
    ),
});

/**
 * Common / breached passwords (audit F-05, offline list — no new
 * dependency, no network call). The ≥10 length floor is unchanged and
 * no character-class rules are added; this only rejects passwords
 * that appear in well-known breach corpora (RockYou / HaveIBeenPwned
 * top entries) or are a listed base word with trailing digits
 * ("Password1234", "admin2024"). Matching is case-insensitive.
 * The identity service reuses this exact list server-side so the
 * schema and the service can never drift apart.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password", "password1", "password123", "password1234", "password12345",
  "passw0rd", "passwd", "pass123", "pass1234",
  "123456", "12345678", "123456789", "1234567890", "12345", "1234567",
  "123123", "123321", "111111", "11111111", "000000", "00000000",
  "qwerty", "qwerty123", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbnm",
  "abc123", "abc1234", "abcd1234", "1qaz2wsx", "1q2w3e4r", "qazwsx",
  "letmein", "welcome", "welcome1", "welcome123", "login", "admin",
  "admin123", "admin1234", "administrator", "root", "toor",
  "monkey", "dragon", "master", "sunshine", "princess", "football",
  "shadow", "superman", "michael", "charlie", "jordan", "tigger",
  "secret", "changeme", "change-me", "default", "test", "test123",
  "test1234", "demo", "demo123", "user", "user123",
  "stackmate", "stackmate123", "riaz", "mahmudul",
  "iloveyou", "trustno1", "hello123", "freedom", "whatever",
]);

export function isCommonPassword(password: string): boolean {
  const normalized = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) return true;
  // Listed base word + trailing digits ("password2024", "admin99").
  const base = normalized.replace(/\d+$/, "");
  return base.length >= 3 && base !== normalized && COMMON_PASSWORDS.has(base);
}
