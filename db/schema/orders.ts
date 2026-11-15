import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { customers } from "./customers.ts";
import { currencies, products } from "./catalog.ts";
import { productPackages, packageVersions, packagePrices } from "./entitlements.ts";
import { integratedSites } from "./integrations.ts";

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey(),
    orderNumber: varchar("order_number", { length: 50 }).notNull().unique(),
    publicReference: varchar("public_reference", { length: 80 }).notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    source: text("source").notNull().default("admin"), // admin | website | api | import
    integratedSiteId: uuid("integrated_site_id").references(() => integratedSites.id, {
      onDelete: "restrict",
    }),
    status: text("status").notNull().default("awaiting_payment"), // draft | awaiting_payment | processing | completed | cancelled | failed
    paymentStatus: text("payment_status").notNull().default("unpaid"), // unpaid | pending_verification | paid | partially_refunded | refunded
    currencyCode: varchar("currency_code", { length: 3 })
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    subtotalMinor: bigint("subtotal_minor", { mode: "number" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "number" }).notNull().default(0),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull().default(0),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
    customerNote: text("customer_note"),
    internalNote: text("internal_note"),
    metadata: jsonb("metadata").notNull().default({}),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_orders_customer_created").on(table.customerId, table.createdAt.desc()),
    index("idx_orders_status_created").on(table.status, table.createdAt.desc()),
    index("idx_orders_payment_status_created").on(table.paymentStatus, table.createdAt.desc()),
    index("idx_orders_site_created").on(table.integratedSiteId, table.createdAt.desc()),
  ]
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    packageId: uuid("package_id").references(() => productPackages.id, {
      onDelete: "restrict",
    }),
    packageVersionId: uuid("package_version_id").references(() => packageVersions.id, {
      onDelete: "restrict",
    }),
    packagePriceId: uuid("package_price_id").references(() => packagePrices.id, {
      onDelete: "restrict",
    }),
    itemKind: text("item_kind").notNull().default("package"), // package | custom | one_time_product | other
    fulfillmentTypeSnapshot: text("fulfillment_type_snapshot")
      .notNull()
      .default("software_license"), // software_license | saas_provision | digital_service | custom
    productNameSnapshot: varchar("product_name_snapshot", { length: 200 }).notNull(),
    packageNameSnapshot: varchar("package_name_snapshot", { length: 200 }),
    packageVersionSnapshot: integer("package_version_snapshot"),
    priceKindSnapshot: text("price_kind_snapshot").notNull().default("recurring"),
    intervalUnitSnapshot: text("interval_unit_snapshot"),
    intervalCountSnapshot: integer("interval_count_snapshot"),
    activationLimitSnapshot: integer("activation_limit_snapshot").notNull().default(1),
    quantity: integer("quantity").notNull().default(1),
    unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
    lineSubtotalMinor: bigint("line_subtotal_minor", { mode: "number" }).notNull(),
    lineDiscountMinor: bigint("line_discount_minor", { mode: "number" }).notNull().default(0),
    lineTaxMinor: bigint("line_tax_minor", { mode: "number" }).notNull().default(0),
    lineTotalMinor: bigint("line_total_minor", { mode: "number" }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 })
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_order_items_order_id").on(table.orderId),
    index("idx_order_items_product_created").on(table.productId, table.createdAt.desc()),
  ]
);

export const orderItemEntitlementSnapshots = pgTable("order_item_entitlement_snapshots", {
  id: uuid("id").primaryKey(),
  orderItemId: uuid("order_item_id")
    .notNull()
    .unique()
    .references(() => orderItems.id, { onDelete: "restrict" }),
  sourceType: text("source_type").notNull(), // package_version | custom_offer | complimentary | manual_adjustment
  sourcePackageVersionId: uuid("source_package_version_id").references(
    () => packageVersions.id,
    { onDelete: "restrict" }
  ),
  schemaVersion: integer("schema_version").notNull().default(1),
  snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orderItemEntitlementSnapshotItems = pgTable(
  "order_item_entitlement_snapshot_items",
  {
    id: uuid("id").primaryKey(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => orderItemEntitlementSnapshots.id, { onDelete: "restrict" }),
    featureKeySnapshot: varchar("feature_key_snapshot", { length: 120 }).notNull(),
    valueTypeSnapshot: text("value_type_snapshot").notNull(),
    entitlementValue: jsonb("entitlement_value").notNull(),
    unitSnapshot: varchar("unit_snapshot", { length: 50 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_order_item_snapshot_feature").on(table.snapshotId, table.featureKeySnapshot),
  ]
);

export const orderAdjustments = pgTable("order_adjustments", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "restrict" }),
  orderItemId: uuid("order_item_id").references(() => orderItems.id, {
    onDelete: "restrict",
  }),
  adjustmentType: text("adjustment_type").notNull(), // discount | tax | fee | credit | other
  labelSnapshot: varchar("label_snapshot", { length: 160 }).notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currencyCode: varchar("currency_code", { length: 3 })
    .notNull()
    .references(() => currencies.code, { onDelete: "restrict" }),
  calculationMetadata: jsonb("calculation_metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
