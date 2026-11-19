import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { uploadedAssets } from "./assets.ts";

export const currencies = pgTable("currencies", {
  code: varchar("code", { length: 3 }).primaryKey(),
  name: varchar("name", { length: 80 }).notNull(),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  exponent: integer("exponent").notNull().default(2),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey(),
    code: varchar("code", { length: 60 }).notNull().unique(),
    slug: varchar("slug", { length: 120 }).notNull().unique(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    productType: text("product_type").notNull(), // wordpress_plugin | wordpress_theme | licensed_software | saas_application | dedicated_deployment | digital_service | other
    fulfillmentType: text("fulfillment_type").notNull().default("software_license"), // software_license | saas_provision | digital_service | custom
    // Added by migration 0002: the store's ProductRecord carries these two
    // scalars (used by license/subscription grace math); previously they had
    // no column and would have been lost on reload.
    defaultActivationLimit: integer("default_activation_limit").notNull().default(1),
    offlineGraceHours: integer("offline_grace_hours").notNull().default(72),
    status: text("status").notNull().default("draft"), // draft | active | archived
    websiteUrl: text("website_url"),
    documentationUrl: text("documentation_url"),
    logoAssetId: uuid("logo_asset_id").references(() => uploadedAssets.id, {
      onDelete: "set null",
    }),
    providerOrgId: uuid("provider_org_id"), // Extension point for ADR-0003 future marketplace
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [index("idx_products_status_created_at").on(table.status, table.createdAt.desc())]
);

export const productDistributionChannels = pgTable(
  "product_distribution_channels",
  {
    id: uuid("id").primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    channelKey: text("channel_key").notNull(), // wordpress | hosted_saas | dedicated_deployment | api | direct_download | service_delivery
    status: text("status").notNull().default("active"),
    configuration: jsonb("configuration").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("uq_product_distribution_channel").on(table.productId, table.channelKey)]
);

export const productIntegrationProfiles = pgTable(
  "product_integration_profiles",
  {
    id: uuid("id").primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    distributionChannelId: uuid("distribution_channel_id")
      .notNull()
      .references(() => productDistributionChannels.id, { onDelete: "restrict" }),
    profileKey: varchar("profile_key", { length: 80 }).notNull(),
    protocolVersion: varchar("protocol_version", { length: 30 }).notNull().default("v1"),
    activationPolicy: jsonb("activation_policy").notNull().default({}),
    offlinePolicy: jsonb("offline_policy").notNull().default({}),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("uq_product_integration_profile").on(table.productId, table.profileKey)]
);

export const productReleases = pgTable(
  "product_releases",
  {
    id: uuid("id").primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    version: varchar("version", { length: 80 }).notNull(),
    channel: text("channel").notNull().default("stable"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("uq_product_release_version").on(table.productId, table.version, table.channel)]
);

export const productFeatures = pgTable(
  "product_features",
  {
    id: uuid("id").primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    featureKey: varchar("feature_key", { length: 120 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    valueType: text("value_type").notNull(), // boolean | limit | quota | metered
    unit: varchar("unit", { length: 50 }),
    defaultValue: jsonb("default_value"),
    validationSchema: jsonb("validation_schema"),
    status: text("status").notNull().default("active"), // active | archived
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_product_features_key").on(table.productId, table.featureKey),
    unique("uq_product_features_product_id_id").on(table.productId, table.id),
    index("idx_product_features_product_status").on(table.productId, table.status, table.name),
  ]
);
