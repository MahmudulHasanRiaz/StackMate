import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { integratedSites } from "./integrations.ts";
import { orders } from "./orders.ts";

export const trackingConfigurations = pgTable(
  "tracking_configurations",
  {
    id: uuid("id").primaryKey(),
    integratedSiteId: uuid("integrated_site_id")
      .notNull()
      .references(() => integratedSites.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("meta"),
    // Human group label shown in the Settings UI ("Main pixel").
    // NULL for groups created before migration 0006 — the UI falls
    // back to the pixel ID when no label is set.
    label: varchar("label", { length: 120 }),
    pixelId: varchar("pixel_id", { length: 80 }).notNull(),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    encryptionKeyVersion: varchar("encryption_key_version", { length: 50 }).notNull().default("v1"),
    testEventCode: varchar("test_event_code", { length: 80 }),
    enabledEvents: jsonb("enabled_events").notNull().default([]),
    consentPolicy: jsonb("consent_policy").notNull().default({}),
    status: text("status").notNull().default("enabled"), // enabled | disabled
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (table) => [
    // Migration 0006: one group per pixel per provider per site
    // (was: one config per site+provider — unique on (site, provider)).
    unique("uq_tracking_configurations_site_provider_pixel").on(
      table.integratedSiteId,
      table.provider,
      table.pixelId
    ),
  ]
);

export const trackingEvents = pgTable(
  "tracking_events",
  {
    id: uuid("id").primaryKey(),
    integratedSiteId: uuid("integrated_site_id")
      .notNull()
      .references(() => integratedSites.id, { onDelete: "restrict" }),
    eventName: varchar("event_name", { length: 80 }).notNull(),
    eventId: varchar("event_id", { length: 160 }).notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    eventSourceUrl: text("event_source_url"),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    consentState: text("consent_state").notNull(),
    consentPolicyVersion: varchar("consent_policy_version", { length: 40 }).notNull(),
    sanitizedPayload: jsonb("sanitized_payload").notNull().default({}),
    status: text("status").notNull().default("received"), // received | queued | processed | rejected
    // Added by migration 0002: the store's TrackingEventRecord carries a
    // delivery counter + timestamp (updated by the outbox dispatcher);
    // previously no columns (tracking_deliveries holds per-attempt rows).
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_tracking_events_dedup").on(table.integratedSiteId, table.eventName, table.eventId),
    index("idx_tracking_events_order_id").on(table.orderId).where(sql`"order_id" IS NOT NULL`),
  ]
);

export const trackingDeliveries = pgTable("tracking_deliveries", {
  id: uuid("id").primaryKey(),
  trackingEventId: uuid("tracking_event_id")
    .notNull()
    .references(() => trackingEvents.id, { onDelete: "cascade" }),
  destination: text("destination").notNull().default("meta_capi"),
  status: text("status").notNull().default("pending"), // pending | delivered | retrying | failed | skipped
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastHttpStatus: integer("last_http_status"),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orderAttributions = pgTable("order_attributions", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .unique()
    .references(() => orders.id, { onDelete: "cascade" }),
  utmSource: varchar("utm_source", { length: 120 }),
  utmMedium: varchar("utm_medium", { length: 120 }),
  utmCampaign: varchar("utm_campaign", { length: 120 }),
  utmContent: varchar("utm_content", { length: 120 }),
  utmTerm: varchar("utm_term", { length: 120 }),
  fbp: varchar("fbp", { length: 200 }),
  fbc: varchar("fbc", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
