import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  boolean,
  date,
  jsonb,
  timestamp,
  unique,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { customers } from "./customers.ts";
import { uploadedAssets } from "./assets.ts";
import { currencies } from "./catalog.ts";
import { orders, orderInstallments } from "./orders.ts";

export const paymentProviders = pgTable("payment_providers", {
  id: uuid("id").primaryKey(),
  providerKey: varchar("provider_key", { length: 80 }).notNull().unique(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  providerType: text("provider_type").notNull(), // manual_mfs | manual_bank | automated
  adapterKey: varchar("adapter_key", { length: 100 }).notNull(),
  status: text("status").notNull().default("enabled"), // enabled | disabled
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  check("payment_providers_provider_type_check", sql`"provider_type" IN ('manual_mfs', 'manual_bank', 'automated')`),
  check("payment_providers_status_check", sql`"status" IN ('enabled', 'disabled')`),
]);

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuid("id").primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => paymentProviders.id, { onDelete: "restrict" }),
    methodKey: varchar("method_key", { length: 100 }).notNull(),
    displayName: varchar("display_name", { length: 160 }).notNull(),
    methodKind: text("method_kind").notNull(), // mfs_account | bank_account | automated_checkout
    accountType: text("account_type"), // personal | merchant | agent | business
    accountLabel: varchar("account_label", { length: 160 }),
    instructions: text("instructions"),
    configurationSchemaVersion: integer("configuration_schema_version").notNull().default(1),
    configuration: jsonb("configuration").notNull().default({}),
    logoAssetId: uuid("logo_asset_id").references(() => uploadedAssets.id, {
      onDelete: "set null",
    }),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_payment_methods_provider_key").on(table.providerId, table.methodKey),
    index("idx_payment_methods_provider_enabled_sort").on(
      table.providerId,
      table.isEnabled,
      table.sortOrder
    ),
    check("payment_methods_method_kind_check", sql`"method_kind" IN ('mfs_account', 'bank_account', 'automated_checkout')`),
  ]
);

export const paymentMethodTransferRails = pgTable(
  "payment_method_transfer_rails",
  {
    id: uuid("id").primaryKey(),
    paymentMethodId: uuid("payment_method_id")
      .notNull()
      .references(() => paymentMethods.id, { onDelete: "cascade" }),
    railKey: text("rail_key").notNull(), // npsb | beftn | rtgs
    displayLabel: varchar("display_label", { length: 100 }).notNull(),
    instructions: text("instructions"),
    isEnabled: boolean("is_enabled").notNull().default(true),
  },
  (table) => [
    unique("uq_payment_method_transfer_rails").on(table.paymentMethodId, table.railKey),
    check("payment_method_transfer_rails_rail_key_check", sql`"rail_key" IN ('npsb', 'beftn', 'rtgs')`),
  ]
);

export const paymentSubmissions = pgTable(
  "payment_submissions",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    paymentMethodId: uuid("payment_method_id")
      .notNull()
      .references(() => paymentMethods.id, { onDelete: "restrict" }),
    // Migration 0009: optional installment this claim is paying towards
    // (oldest-first allocation when null).
    installmentId: uuid("installment_id").references(() => orderInstallments.id, {
      onDelete: "set null",
    }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 })
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    senderName: varchar("sender_name", { length: 160 }),
    senderPhone: varchar("sender_phone", { length: 40 }),
    senderBankName: varchar("sender_bank_name", { length: 160 }),
    senderAccountReference: varchar("sender_account_reference", { length: 160 }),
    transferRailKey: varchar("transfer_rail_key", { length: 40 }),
    transactionReference: varchar("transaction_reference", { length: 160 }),
    normalizedTransactionReference: varchar("normalized_transaction_reference", { length: 160 }),
    paymentDate: date("payment_date"),
    proofAssetId: uuid("proof_asset_id").references(() => uploadedAssets.id, {
      onDelete: "restrict",
    }),
    // Added by migration 0002: the store's PaymentSubmissionRecord carries
    // duplicate_risk_Warning (note the capital W — kept verbatim from the
    // store interface); previously no column.
    duplicateRiskWarning: boolean("duplicate_risk_warning").notNull().default(false),
    status: text("status").notNull().default("submitted"), // submitted | under_review | approved | rejected | cancelled
    customerNote: text("customer_note"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_payment_submissions_order_submitted").on(table.orderId, table.submittedAt.desc()),
    index("idx_payment_submissions_status_submitted").on(table.status, table.submittedAt),
    index("idx_payment_submissions_method_norm_ref")
      .on(table.paymentMethodId, table.normalizedTransactionReference)
      .where(sql`"normalized_transaction_reference" IS NOT NULL`),
    index("idx_payment_submissions_customer_submitted").on(table.customerId, table.submittedAt.desc()),
    check("payment_submissions_amount_minor_check", sql`"amount_minor" > 0`),
    check("payment_submissions_status_check", sql`"status" IN ('submitted', 'under_review', 'approved', 'rejected', 'cancelled')`),
  ]
);

export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, {
      onDelete: "restrict",
    }),
    paymentSubmissionId: uuid("payment_submission_id")
      .unique()
      .references(() => paymentSubmissions.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => paymentProviders.id, { onDelete: "restrict" }),
    providerTransactionId: varchar("provider_transaction_id", { length: 180 }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 })
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    status: text("status").notNull().default("succeeded"), // succeeded | pending | failed | partially_refunded | refunded
    paidAt: timestamp("paid_at", { withTimezone: true }),
    verifiedByUserId: text("verified_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    verificationSource: text("verification_source").notNull().default("manual_staff"), // manual_staff | provider_webhook | provider_query | import
    providerMetadata: jsonb("provider_metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_payment_transactions_order_created").on(table.orderId, table.createdAt.desc()),
    index("idx_payment_transactions_provider_txn")
      .on(table.providerId, table.providerTransactionId)
      .where(sql`"provider_transaction_id" IS NOT NULL`),
    // Migration 0015 (audit F-01, defense-in-depth): a succeeded provider
    // transaction may credit money only once — the partial unique index
    // makes the invariant hold even if two approvals race. The
    // non-unique idx above is kept: it covers all non-NULL provider
    // transactions, not just succeeded ones.
    uniqueIndex("uq_payment_transactions_provider_txn_succeeded")
      .on(table.providerId, table.providerTransactionId)
      .where(sql`"status" = 'succeeded' AND "provider_transaction_id" IS NOT NULL`),
    index("idx_payment_transactions_status_paid").on(table.status, table.paidAt.desc()),
    check("payment_transactions_amount_minor_check", sql`"amount_minor" > 0`),
    check("payment_transactions_status_check", sql`"status" IN ('succeeded', 'pending', 'failed', 'partially_refunded', 'refunded')`),
    check("payment_transactions_verification_source_check", sql`"verification_source" IN ('manual_staff', 'provider_webhook', 'provider_query', 'import')`),
  ]
);

export const paymentVerificationLogs = pgTable("payment_verification_logs", {
  id: uuid("id").primaryKey(),
  paymentSubmissionId: uuid("payment_submission_id")
    .notNull()
    .references(() => paymentSubmissions.id, { onDelete: "restrict" }),
  actorUserId: text("actor_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  decision: text("decision").notNull(), // approved | rejected | requested_information | reopened
  reasonCode: varchar("reason_code", { length: 80 }),
  customerMessage: text("customer_message"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  // Migration 0021 (audit C-02): verification history is read per
  // payment submission.
  index("idx_payment_verification_logs_submission_id").on(table.paymentSubmissionId),
  check("payment_verification_logs_decision_check", sql`"decision" IN ('approved', 'rejected', 'requested_information', 'reopened')`),
]);

export const paymentRefunds = pgTable("payment_refunds", {
  id: uuid("id").primaryKey(),
  paymentTransactionId: uuid("payment_transaction_id")
    .notNull()
    .references(() => paymentTransactions.id, { onDelete: "restrict" }),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currencyCode: varchar("currency_code", { length: 3 })
    .notNull()
    .references(() => currencies.code, { onDelete: "restrict" }),
  status: text("status").notNull().default("requested"), // requested | pending | succeeded | failed | cancelled
  reason: text("reason").notNull(),
  providerRefundId: varchar("provider_refund_id", { length: 180 }),
  requestedByUserId: text("requested_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  processedByUserId: text("processed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  // Migration 0021 (audit C-02): refunds are read per payment
  // transaction (order detail, P&L); transaction deletes scan here.
  index("idx_payment_refunds_transaction_id").on(table.paymentTransactionId),
  check("payment_refunds_amount_minor_check", sql`"amount_minor" > 0`),
  check("payment_refunds_status_check", sql`"status" IN ('requested', 'pending', 'succeeded', 'failed', 'cancelled')`),
]);
