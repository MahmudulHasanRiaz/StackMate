-- StackMate Migration 0007: Auth + Email configuration (BetterAuth config,
-- OAuth, 2FA, SMTP) — owner order 2026-11-16.
--
-- Why this migration exists: authentication configuration lived nowhere
-- (no OAuth providers, no 2FA, no email system at all — grep smtp /
-- forgetPassword / sendResetPassword was zero). Settings now owns it, so
-- the config lives in the database and a save takes effect without a
-- redeploy (ADR-0008).
--
--   users.two_factor_enabled ... The Better Auth two-factor plugin reads
--                                 and writes `user.twoFactorEnabled`
--                                 (Drizzle adapter maps it to this
--                                 column). False until the plugin sets it
--                                 on the first successful TOTP verify.
--   two_factor .................. The plugin's own table (better-auth
--                                 1.7.23 dist/plugins/two-factor/
--                                 schema.mjs): encrypted TOTP secret +
--                                 encrypted backup codes (the plugin is
--                                 configured with storeBackupCodes:
--                                 "encrypted" — its default is plaintext
--                                 JSON), verified flag, failure counter,
--                                 lockout timestamp. One row per user.
--   auth_oauth_providers ......... One row per social provider (google,
--                                 github). Client secrets encrypted at
--                                 rest (AES-256-GCM, AAD
--                                 `auth:oauth:<provider>`), never
--                                 returned to clients.
--   auth_two_factor_policy ....... One row per scope: `global` (default
--                                 for every role) or a role key. Mode is
--                                 off | optional | required.
--   smtp_settings ................ Singleton row (id `default`):
--                                 provider-agnostic SMTP from the admin
--                                 panel. Password encrypted at rest (AAD
--                                 `auth:smtp`), never returned.
--   password_reset_tokens ........ Single-use tokens for forgot-password
--                                 and 2FA recovery. Only the SHA-256 hash
--                                 is stored; `purpose` keeps the two flows
--                                 apart so a password-reset token cannot
--                                 disable 2FA.
--
-- Expand-and-contract, no data migration: every statement is additive
-- (new tables, one new nullable-by-default column). All statements are
-- idempotent (IF NOT EXISTS / DO blocks), so re-running is safe.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "two_factor" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "verified" boolean NOT NULL DEFAULT false,
  "failed_verification_count" integer NOT NULL DEFAULT 0,
  "locked_until" timestamp with time zone,
  CONSTRAINT "two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "two_factor_user_id_unique" ON "two_factor" ("user_id");

CREATE TABLE IF NOT EXISTS "auth_oauth_providers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "client_id" text,
  "client_secret_ciphertext" text,
  "encryption_key_version" varchar(50) NOT NULL DEFAULT 'v1',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "uq_auth_oauth_providers_provider" UNIQUE ("provider")
);

CREATE TABLE IF NOT EXISTS "auth_two_factor_policy" (
  "id" uuid PRIMARY KEY NOT NULL,
  "scope" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'off',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "uq_auth_two_factor_policy_scope" UNIQUE ("scope"),
  CONSTRAINT "auth_two_factor_policy_mode_check" CHECK ("mode" IN ('off', 'optional', 'required'))
);

CREATE TABLE IF NOT EXISTS "smtp_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "host" text NOT NULL DEFAULT '',
  "port" integer NOT NULL DEFAULT 587,
  "username" text NOT NULL DEFAULT '',
  "password_ciphertext" text,
  "encryption_key_version" varchar(50) NOT NULL DEFAULT 'v1',
  "tls_mode" text NOT NULL DEFAULT 'starttls',
  "from_address" text NOT NULL DEFAULT '',
  "from_name" text NOT NULL DEFAULT 'StackMate',
  "enabled" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "smtp_settings_tls_mode_check" CHECK ("tls_mode" IN ('starttls', 'ssl', 'none'))
);

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "purpose" text NOT NULL DEFAULT 'password_reset',
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "password_reset_tokens_purpose_check" CHECK ("purpose" IN ('password_reset', 'two_factor_recovery'))
);
CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_hash" ON "password_reset_tokens" ("token_hash");
