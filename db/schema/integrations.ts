import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
  primaryKey,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { products } from "./catalog.ts";

export const integratedSites = pgTable("integrated_sites", {
  id: uuid("id").primaryKey(),
  siteKey: varchar("site_key", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  environment: text("environment").notNull().default("production"), // production | staging | development
  status: text("status").notNull().default("pending_verification"), // pending_verification | active | suspended | revoked
  apiVersion: varchar("api_version", { length: 30 }).notNull().default("v1"),
  allowedCapabilities: jsonb("allowed_capabilities").notNull().default([]),
  createdByUserId: text("created_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
},
(table) => [
  check("integrated_sites_environment_check", sql`"environment" IN ('production', 'staging', 'development')`),
  check("integrated_sites_status_check", sql`"status" IN ('pending_verification', 'active', 'suspended', 'revoked')`),
]);

export const siteDomains = pgTable("site_domains", {
  id: uuid("id").primaryKey(),
  integratedSiteId: uuid("integrated_site_id")
    .notNull()
    .references(() => integratedSites.id, { onDelete: "cascade" }),
  domain: varchar("domain", { length: 253 }).notNull().unique(),
  verificationMethod: text("verification_method").notNull().default("dns_txt"), // dns_txt | http_file | manual_review
  verificationChallenge: varchar("verification_challenge", { length: 120 }).notNull(),
  verificationStatus: text("verification_status").notNull().default("pending"), // pending | verified | failed
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  check("site_domains_verification_method_check", sql`"verification_method" IN ('dns_txt', 'http_file', 'manual_review')`),
  check("site_domains_verification_status_check", sql`"verification_status" IN ('pending', 'verified', 'failed')`),
]);

export const siteProducts = pgTable(
  "site_products",
  {
    integratedSiteId: uuid("integrated_site_id")
      .notNull()
      .references(() => integratedSites.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"), // active | revoked
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.integratedSiteId, table.productId] }),
    check("site_products_status_check", sql`"status" IN ('active', 'revoked')`),
  ]
);

export const siteCredentials = pgTable("site_credentials", {
  id: uuid("id").primaryKey(),
  integratedSiteId: uuid("integrated_site_id")
    .notNull()
    .references(() => integratedSites.id, { onDelete: "cascade" }),
  keyId: varchar("key_id", { length: 100 }).notNull().unique(),
  credentialType: text("credential_type").notNull(), // public_key | bearer_secret | hmac_shared_secret | public_signing_key
  secretHash: text("secret_hash"),
  secretCiphertext: text("secret_ciphertext"),
  publicKeyMaterial: text("public_key_material"),
  encryptionKeyVersion: varchar("encryption_key_version", { length: 50 }),
  scopes: jsonb("scopes").notNull().default([]),
  status: text("status").notNull().default("active"), // active | rotated | revoked | expired
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
},
(table) => [
  check("site_credentials_credential_type_check", sql`"credential_type" IN ('public_key', 'bearer_secret', 'hmac_shared_secret', 'public_signing_key')`),
  check("site_credentials_status_check", sql`"status" IN ('active', 'rotated', 'revoked', 'expired')`),
]);

export const requestNonces = pgTable(
  "request_nonces",
  {
    id: uuid("id").primaryKey(),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => siteCredentials.id, { onDelete: "cascade" }),
    nonce: varchar("nonce", { length: 160 }).notNull(),
    requestTimestamp: timestamp("request_timestamp", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_request_nonces_cred_nonce").on(table.credentialId, table.nonce),
    index("idx_request_nonces_expires_at").on(table.expiresAt),
  ]
);
