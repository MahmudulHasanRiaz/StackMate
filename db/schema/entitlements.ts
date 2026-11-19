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
  foreignKey,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { currencies, products, productFeatures } from "./catalog.ts";

export const productPackages = pgTable(
  "product_packages",
  {
    id: uuid("id").primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    packageKey: varchar("package_key", { length: 100 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"), // draft | active | archived
    // Added by migration 0002: the store's ProductPackageRecord carries the
    // currently published version id (set on publish); previously no column.
    // NOTE: the FK to package_versions lives ONLY in migration 0002 SQL
    // (fk_product_packages_current_version, ON DELETE SET NULL). It is NOT
    // declared here with .references(): productPackages and packageVersions
    // reference each other, and a column-level .references() closure makes
    // TypeScript's inference circular (TS7022/TS7024). DrizzleStore inserts
    // the package with NULL first and backfills after the version row
    // exists (same-tx cycle). See also the SQL-only CHECKs/triggers note in
    // db/schema/README.md.
    currentVersionId: uuid("current_version_id"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_product_packages_key").on(table.productId, table.packageKey),
    unique("uq_product_packages_product_id_id").on(table.productId, table.id),
  ]
);

export const packageVersions = pgTable(
  "package_versions",
  {
    id: uuid("id").primaryKey(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => productPackages.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    status: text("status").notNull().default("draft"), // draft | published | retired
    changeSummary: text("change_summary"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_package_versions_pkg_ver").on(table.packageId, table.versionNumber),
    unique("uq_package_versions_product_id_id").on(table.productId, table.id),
    foreignKey({
      columns: [table.productId, table.packageId],
      foreignColumns: [productPackages.productId, productPackages.id],
      name: "fk_package_versions_same_product",
    }).onDelete("restrict"),
  ]
);

export const packageVersionFeatures = pgTable(
  "package_version_features",
  {
    id: uuid("id").primaryKey(),
    packageVersionId: uuid("package_version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    productFeatureId: uuid("product_feature_id")
      .notNull()
      .references(() => productFeatures.id, { onDelete: "restrict" }),
    featureKeySnapshot: varchar("feature_key_snapshot", { length: 120 }).notNull(),
    valueTypeSnapshot: text("value_type_snapshot").notNull(),
    entitlementValue: jsonb("entitlement_value").notNull(),
    // Added by migration 0002: the store's PackageVersionFeatureGrant carries
    // unit_snapshot (the sibling snapshot tables already had this column).
    unitSnapshot: varchar("unit_snapshot", { length: 50 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_package_version_features").on(table.packageVersionId, table.productFeatureId),
    foreignKey({
      columns: [table.productId, table.packageVersionId],
      foreignColumns: [packageVersions.productId, packageVersions.id],
      name: "fk_pvf_version_same_product",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.productId, table.productFeatureId],
      foreignColumns: [productFeatures.productId, productFeatures.id],
      name: "fk_pvf_feature_same_product",
    }).onDelete("restrict"),
  ]
);

export const packagePrices = pgTable(
  "package_prices",
  {
    id: uuid("id").primaryKey(),
    packageVersionId: uuid("package_version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "restrict" }),
    priceKey: varchar("price_key", { length: 100 }).notNull(),
    priceKind: text("price_kind").notNull(), // free | one_time | recurring | lifetime
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 })
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    intervalUnit: text("interval_unit"), // day | week | month | year
    intervalCount: integer("interval_count"),
    trialDays: integer("trial_days").notNull().default(0),
    setupFeeMinor: bigint("setup_fee_minor", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("active"), // active | inactive | retired
    // Added by migration 0002: the store's PackagePriceRecord tracks whether
    // the price was ever used in an order; previously no column.
    usedInOrders: boolean("used_in_orders").notNull().default(false),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_package_prices_ver_key").on(table.packageVersionId, table.priceKey),
    index("idx_package_prices_ver_status").on(table.packageVersionId, table.status),
  ]
);
