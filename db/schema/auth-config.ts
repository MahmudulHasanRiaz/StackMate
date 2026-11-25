import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";

/**
 * Authentication + email configuration (Auth + Email batch, 2026-11-16).
 *
 * Three config tables + one token table, all DB-driven so a Settings save
 * takes effect without a redeploy (ADR-0008):
 *  - auth_oauth_providers: one row per social provider (google, github).
 *    Client secrets are encrypted at rest (AES-256-GCM under
 *    ENCRYPTION_KEY_V1, AAD `auth:oauth:<provider>`) and NEVER returned
 *    to clients — the API returns only `has_client_secret`.
 *  - auth_two_factor_policy: one row per scope — `global` (the default
 *    for every role) or a role key (super_admin, admin, …). Mode is
 *    off | optional | required; unset scope reads as `off`.
 *  - smtp_settings: a SINGLETON row (id `default`) holding the
 *    provider-agnostic SMTP settings from the admin panel. The password
 *    is encrypted at rest (AAD `auth:smtp`), never returned.
 *  - password_reset_tokens: single-use tokens for forgot-password and
 *    2FA recovery. Only the SHA-256 hash is stored; the raw token is
 *    emailed once and never persisted. `purpose` separates the two
 *    flows so a password-reset token cannot disable 2FA (and vice
 *    versa) — email compromise alone must never defeat 2FA.
 */
export const authOAuthProviders = pgTable(
  "auth_oauth_providers",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(), // google | github (see service — never invent one)
    enabled: boolean("enabled").notNull().default(false),
    clientId: text("client_id"),
    clientSecretCiphertext: text("client_secret_ciphertext"),
    encryptionKeyVersion: varchar("encryption_key_version", { length: 50 })
      .notNull()
      .default("v1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("uq_auth_oauth_providers_provider").on(table.provider)]
);

export const authTwoFactorPolicy = pgTable(
  "auth_two_factor_policy",
  {
    id: uuid("id").primaryKey(),
    // `global` = default for every role; otherwise a role key
    // (super_admin, admin, finance_manager, license_manager,
    // marketing_manager, product_manager, support_staff, read_only).
    scope: text("scope").notNull(),
    // off | optional | required
    mode: text("mode").notNull().default("off"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_auth_two_factor_policy_scope").on(table.scope),
    check("auth_two_factor_policy_mode_check", sql`"mode" IN ('off', 'optional', 'required')`),
  ]
);

export const smtpSettings = pgTable("smtp_settings", {
  // Singleton: exactly one row, id `default`.
  id: text("id").primaryKey(),
  host: text("host").notNull().default(""),
  port: integer("port").notNull().default(587),
  username: text("username").notNull().default(""),
  passwordCiphertext: text("password_ciphertext"),
  encryptionKeyVersion: varchar("encryption_key_version", { length: 50 })
    .notNull()
    .default("v1"),
  // starttls | ssl | none
  tlsMode: text("tls_mode").notNull().default("starttls"),
  fromAddress: text("from_address").notNull().default(""),
  fromName: text("from_name").notNull().default("StackMate"),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  check("smtp_settings_tls_mode_check", sql`"tls_mode" IN ('starttls', 'ssl', 'none')`),
]);

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // SHA-256 hex of the raw token — the raw token is emailed once and
  // never stored. Lookup is by hash, so a DB read alone cannot use it.
  tokenHash: text("token_hash").notNull(),
  // password_reset | two_factor_recovery
  purpose: text("purpose").notNull().default("password_reset"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  // Migration 0021 (audit C-02): the auth service looks a token row
  // up by user (reset / 2FA-recovery invalidation on password change).
  index("idx_password_reset_tokens_user_id").on(table.userId),
  // Index exists in SQL (migration 0007) — declared here so
  // drizzle-kit generate reproduces it (found during the 0014
  // generate verification; previously the only index generate missed).
  index("idx_password_reset_tokens_hash").on(table.tokenHash),
  check("password_reset_tokens_purpose_check", sql`"purpose" IN ('password_reset', 'two_factor_recovery')`),
]);
