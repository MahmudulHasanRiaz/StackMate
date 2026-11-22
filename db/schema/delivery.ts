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
  check,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { customers } from "./customers.ts";
import { integratedSites } from "./integrations.ts";

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    eventKey: varchar("event_key", { length: 120 }).notNull().unique(),
    aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"), // pending | processing | delivered | dead_letter | simulated (migration 0015, audit C-2/D-6)
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 120 }),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_outbox_events_status_available").on(table.status, table.availableAt),
    index("idx_outbox_events_aggregate").on(table.aggregateType, table.aggregateId, table.createdAt),
    check("outbox_events_status_check", sql`"status" IN ('pending', 'processing', 'delivered', 'dead_letter', 'simulated')`),
  ]
);

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey(),
  integratedSiteId: uuid("integrated_site_id").references(() => integratedSites.id, {
    onDelete: "cascade",
  }),
  url: text("url").notNull(),
  description: varchar("description", { length: 160 }).notNull(),
  subscribedEvents: jsonb("subscribed_events").notNull().default([]),
  status: text("status").notNull().default("active"), // active | disabled | revoked
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  check("webhook_endpoints_status_check", sql`"status" IN ('active', 'disabled', 'revoked')`),
]);

export const webhookEndpointSecrets = pgTable("webhook_endpoint_secrets", {
  id: uuid("id").primaryKey(),
  webhookEndpointId: uuid("webhook_endpoint_id")
    .notNull()
    .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
  keyId: varchar("key_id", { length: 100 }).notNull().unique(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  keyVersion: varchar("key_version", { length: 50 }).notNull().default("v1"),
  status: text("status").notNull().default("active"), // active | retiring | revoked
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
},
(table) => [
  check("webhook_endpoint_secrets_status_check", sql`"status" IN ('active', 'retiring', 'revoked')`),
]);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    webhookEndpointId: uuid("webhook_endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => outboxEvents.id, { onDelete: "cascade" }),
    deliveryId: varchar("delivery_id", { length: 80 }).notNull(),
    status: text("status").notNull().default("pending"), // pending | delivered | retrying | failed | simulated (migration 0015, audit C-2/D-6)
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastHttpStatus: integer("last_http_status"),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_webhook_deliveries_endpoint_delivery").on(table.webhookEndpointId, table.deliveryId),
    check("webhook_deliveries_status_check", sql`"status" IN ('pending', 'delivered', 'retrying', 'failed', 'simulated')`),
  ]
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").primaryKey(),
    scopeKey: varchar("scope_key", { length: 160 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    responseStatus: integer("response_status"),
    responseReference: varchar("response_reference", { length: 160 }),
    // Added by migration 0002: the store's IdempotencyRecord carries the full
    // replay response body. Migration 0000 only had response_reference
    // (varchar 160), which cannot hold real response bodies — without this
    // column executeIdempotent replays could not return the original body.
    responseBody: jsonb("response_body"),
    status: text("status").notNull().default("processing"), // processing | completed | failed
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_idempotency_records_scope_key").on(table.scopeKey, table.idempotencyKey),
    check("idempotency_records_status_check", sql`"status" IN ('processing', 'completed', 'failed')`),
  ]
);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  notificationType: varchar("notification_type", { length: 100 }).notNull(),
  channel: text("channel").notNull().default("email"), // email | in_app
  templateKey: varchar("template_key", { length: 100 }).notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("pending"), // pending | sent | failed | cancelled
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
},
(table) => [
  check("notifications_channel_check", sql`"channel" IN ('email', 'in_app')`),
  check("notifications_status_check", sql`"status" IN ('pending', 'sent', 'failed', 'cancelled')`),
]);
