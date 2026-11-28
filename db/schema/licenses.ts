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
import { products, productIntegrationProfiles } from "./catalog.ts";
import { orderItems } from "./orders.ts";
import { subscriptions, subscriptionPeriods } from "./subscriptions.ts";

export const signingKeyMetadata = pgTable("signing_key_metadata", {
  id: uuid("id").primaryKey(),
  keyId: varchar("key_id", { length: 80 }).notNull().unique(),
  algorithm: varchar("algorithm", { length: 24 }).notNull().default("EdDSA"),
  publicKeyJwk: jsonb("public_key_jwk").notNull(),
  status: text("status").notNull().default("active"), // active | retiring | retired | revoked
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  check("signing_key_metadata_status_check", sql`"status" IN ('active', 'retiring', 'retired', 'revoked')`),
]);

export const licenses = pgTable(
  "licenses",
  {
    id: uuid("id").primaryKey(),
    licenseNumber: varchar("license_number", { length: 60 }).notNull().unique(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    // NOTE (migration 0002): integration_profile_id was NOT NULL in 0000,
    // but the service model (LicenseRecord) never carries an integration
    // profile — license issuance sets no value, so persisting a license
    // could never satisfy the constraint. 0002 relaxes it to nullable;
    // license validation resolves its profile from the request instead.
    integrationProfileId: uuid("integration_profile_id").references(
      () => productIntegrationProfiles.id,
      { onDelete: "restrict" }
    ),
    sourceOrderItemId: uuid("source_order_item_id").references(() => orderItems.id, {
      onDelete: "restrict",
    }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "restrict",
    }),
    licenseKeyHash: text("license_key_hash").notNull().unique(),
    licenseKeyHint: varchar("license_key_hint", { length: 24 }).notNull(),
    status: text("status").notNull().default("pending"), // pending | active | expired | suspended | revoked
    activationLimit: integer("activation_limit").notNull().default(1),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    // NOTE (migration 0014, audit F-14): the FK to
    // license_entitlement_snapshots lives ONLY in migration 0014 SQL
    // (licenses_current_entitlement_snapshot_id_fkey, ON DELETE SET
    // NULL). It is NOT declared here with .references():
    // licenses and licenseEntitlementSnapshots reference each other,
    // and a column-level .references() closure makes TypeScript's
    // inference circular (TS7022/TS7024) — same SQL-only precedent as
    // productPackages.current_version_id (entitlements.ts),
    // signingKeys.supersedes_key_id, and leads.converted_order_id.
    // See also the SQL-only CHECKs/triggers note in db/schema/README.md.
    currentEntitlementSnapshotId: uuid("current_entitlement_snapshot_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_licenses_customer_created").on(table.customerId, table.createdAt.desc()),
    index("idx_licenses_product_status_expires").on(table.productId, table.status, table.expiresAt),
    index("idx_licenses_subscription_id").on(table.subscriptionId).where(sql`"subscription_id" IS NOT NULL`),
    check("licenses_status_check", sql`"status" IN ('pending', 'active', 'expired', 'suspended', 'revoked')`),
    check("licenses_activation_limit_check", sql`"activation_limit" >= 1`),
  ]
);

export const licenseEntitlementSnapshots = pgTable(
  "license_entitlement_snapshots",
  {
    id: uuid("id").primaryKey(),
    licenseId: uuid("license_id")
      .notNull()
      .references(() => licenses.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    sourceType: text("source_type").notNull(), // order_item | subscription_period | manual_grant | admin_adjustment
    sourceOrderItemId: uuid("source_order_item_id").references(() => orderItems.id, {
      onDelete: "restrict",
    }),
    sourceSubscriptionPeriodId: uuid("source_subscription_period_id").references(
      () => subscriptionPeriods.id,
      { onDelete: "restrict" }
    ),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
    snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_license_entitlement_snapshot_ver").on(table.licenseId, table.versionNumber),
    check("license_entitlement_snapshots_source_type_check", sql`"source_type" IN ('order_item', 'subscription_period', 'manual_grant', 'admin_adjustment')`),
    check("license_entitlement_snapshots_version_number_check", sql`"version_number" >= 1`),
  ]
);

export const licenseEntitlementSnapshotItems = pgTable(
  "license_entitlement_snapshot_items",
  {
    id: uuid("id").primaryKey(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => licenseEntitlementSnapshots.id, { onDelete: "restrict" }),
    featureKeySnapshot: varchar("feature_key_snapshot", { length: 120 }).notNull(),
    valueTypeSnapshot: text("value_type_snapshot").notNull(),
    entitlementValue: jsonb("entitlement_value").notNull(),
    unitSnapshot: varchar("unit_snapshot", { length: 50 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_license_snapshot_item_feature").on(table.snapshotId, table.featureKeySnapshot),
  ]
);

export const licenseActivations = pgTable(
  "license_activations",
  {
    id: uuid("id").primaryKey(),
    licenseId: uuid("license_id")
      .notNull()
      .references(() => licenses.id, { onDelete: "restrict" }),
    installationIdHash: varchar("installation_id_hash", { length: 128 }).notNull(),
    domainNormalized: varchar("domain_normalized", { length: 253 }),
    environment: text("environment").notNull().default("production"), // production | staging | development | other
    status: text("status").notNull().default("active"), // active | deactivated | blocked
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_license_activations_installation").on(table.licenseId, table.installationIdHash),
    index("idx_license_activations_license_status").on(table.licenseId, table.status),
    check("license_activations_environment_check", sql`"environment" IN ('production', 'staging', 'development', 'other')`),
    check("license_activations_status_check", sql`"status" IN ('active', 'deactivated', 'blocked')`),
  ]
);

export const licenseEvents = pgTable("license_events", {
  id: uuid("id").primaryKey(),
  licenseId: uuid("license_id")
    .notNull()
    .references(() => licenses.id, { onDelete: "restrict" }),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  actorType: text("actor_type").notNull(), // system | staff | client
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  activationId: uuid("activation_id").references(() => licenseActivations.id, {
    onDelete: "set null",
  }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  // Migration 0021 (audit C-02): event history is read per license,
  // newest first; license deletes scan the child table.
  index("idx_license_events_license_created").on(table.licenseId, table.createdAt.desc()),
  check("license_events_actor_type_check", sql`"actor_type" IN ('system', 'staff', 'client')`),
]);

export const licenseValidationLogs = pgTable("license_validation_logs", {
  id: uuid("id").primaryKey(),
  licenseId: uuid("license_id").references(() => licenses.id, { onDelete: "set null" }),
  integrationProfileId: uuid("integration_profile_id").references(
    () => productIntegrationProfiles.id,
    { onDelete: "set null" }
  ),
  activationId: uuid("activation_id").references(() => licenseActivations.id, {
    onDelete: "set null",
  }),
  outcome: text("outcome").notNull(), // valid | rejected
  errorCode: varchar("error_code", { length: 80 }),
  requestId: varchar("request_id", { length: 100 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  check("license_validation_logs_outcome_check", sql`"outcome" IN ('valid', 'rejected')`),
]);
