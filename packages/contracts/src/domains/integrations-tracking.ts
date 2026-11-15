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
      ] as const)
    )
    .default(["catalog.read", "checkout.create", "tracking.events.write"]),
});

export const CreateSiteCredentialSchema = v.object({
  credential_type: v.enum(CREDENTIAL_TYPES),
  scopes: v.array(v.string().trim().min(2).max(80), { min: 1 }),
});

export const ConfigureSiteTrackingSchema = v.object({
  provider: v.literal("meta"),
  pixel_id: v.string().trim().min(4).max(80),
  access_token: v.string().trim().min(12).max(512),
  test_event_code: v.string().trim().max(80).optional(),
  enabled_events: v.array(v.enum(ALLOWED_TRACKING_EVENTS), { min: 1 }),
  status: v.enum(["enabled", "disabled"] as const).default("enabled"),
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
