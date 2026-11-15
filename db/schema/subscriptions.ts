import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { customers } from "./customers.ts";
import { currencies, products } from "./catalog.ts";
import { packageVersions } from "./entitlements.ts";
import { orders, orderItems } from "./orders.ts";

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey(),
    subscriptionNumber: varchar("subscription_number", { length: 60 }).notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    sourceOrderItemId: uuid("source_order_item_id").references(() => orderItems.id, {
      onDelete: "restrict",
    }),
    sourcePackageVersionId: uuid("source_package_version_id").references(
      () => packageVersions.id,
      { onDelete: "restrict" }
    ),
    status: text("status").notNull().default("pending"), // trialing | pending | active | past_due | paused | cancelled | expired
    billingKind: text("billing_kind").notNull(), // one_time | recurring | lifetime | custom
    intervalUnit: text("interval_unit"), // day | week | month | year
    intervalCount: integer("interval_count"),
    currencyCode: varchar("currency_code", { length: 3 })
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    // Added by migration 0002: the store's SubscriptionRecord carries the
    // per-period amount (copied from the source order item); previously no
    // column, so a reload lost the billing amount.
    unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull().default(0),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    nextRenewalAt: timestamp("next_renewal_at", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_subscriptions_customer_created").on(table.customerId, table.createdAt.desc()),
    index("idx_subscriptions_product_status").on(table.productId, table.status),
    index("idx_subscriptions_status_next_renewal").on(table.status, table.nextRenewalAt),
  ]
);

export const subscriptionPeriods = pgTable(
  "subscription_periods",
  {
    id: uuid("id").primaryKey(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "restrict" }),
    periodNumber: integer("period_number").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"), // pending | active | completed | void | failed
    renewalOrderId: uuid("renewal_order_id").references(() => orders.id, {
      onDelete: "restrict",
    }),
    invoiceId: uuid("invoice_id"),
    paymentTransactionId: uuid("payment_transaction_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_subscription_periods_number").on(table.subscriptionId, table.periodNumber),
    unique("uq_subscription_periods_window").on(
      table.subscriptionId,
      table.periodStart,
      table.periodEnd
    ),
  ]
);

export const subscriptionEvents = pgTable("subscription_events", {
  id: uuid("id").primaryKey(),
  subscriptionId: uuid("subscription_id")
    .notNull()
    .references(() => subscriptions.id, { onDelete: "restrict" }),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  actorType: text("actor_type").notNull(), // system | staff | customer | provider
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  relatedOrderId: uuid("related_order_id").references(() => orders.id, {
    onDelete: "restrict",
  }),
  relatedInvoiceId: uuid("related_invoice_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
