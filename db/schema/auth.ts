import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, varchar, integer, check } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  // Better Auth two-factor plugin (Auth + Email batch, 2026-11-16):
  // the plugin reads/writes `user.twoFactorEnabled`; the Drizzle
  // adapter maps it to this column. Set true by the plugin itself on
  // the first successful TOTP verification (verify-totp), false on
  // disable. Never set it by hand — it is the plugin's state.
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  // Staff password hash (scrypt, `scrypt:<salt>:<derived>`) for the custom
  // staff sign-in in apps/api/src/modules/identity/service.ts. Added by
  // migration 0002. NULL for users created by Better Auth, which keeps its
  // own password in the `accounts` table — such users cannot use staff
  // password sign-in until a password is set through the identity service.
  passwordHash: text("password_hash"),
  image: text("image"),
  // Migration 0014 (audit D-5, full avatar batch): the R2 object key of
  // the staff member's custom avatar (NULL = Gravatar default). Written
  // by the API avatar-upload endpoint; read by the SPA Avatar component.
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const staffProfiles = pgTable("staff_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  status: text("status").notNull().default("active"), // active | suspended
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  check("staff_profiles_status_check", sql`"status" IN ('active', 'suspended')`),
]);

/**
 * Better Auth two-factor plugin table (Auth + Email batch, 2026-11-16).
 *
 * Shape mirrors the plugin's own schema (better-auth 1.7.23
 * dist/plugins/two-factor/schema.mjs): `secret` is stored ENCRYPTED
 * by the plugin itself (decryptTOTPSecret with BETTER_AUTH_SECRET),
 * `backupCodes` is stored ENCRYPTED because the plugin is configured
 * with `backupCodeOptions: { storeBackupCodes: "encrypted" }` — the
 * plugin's DEFAULT is plaintext JSON, so that option is load-bearing.
 * `verified` flips true on the first successful TOTP verification;
 * the plugin sets `users.two_factor_enabled` at the same time.
 * The Drizzle adapter resolves model `twoFactor` via
 * `config.schema["twoFactor"]` (see better-auth.ts).
 */
export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  verified: boolean("verified").notNull().default(false),
  failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});
