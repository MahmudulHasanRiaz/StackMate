-- 0021 — audit 2026-11-25 C-02 (+ C-06 reset_at index): missing indexes
-- on FK columns used by the direct-SQL paths (Better Auth, media,
-- auth-config) and on FKs checked by parent deletes.
--
-- Most business reads go through the in-memory full load, so these
-- gaps are invisible today — but the paths that DO hit SQL directly
-- (Better Auth lookups via drizzleDb, media list, auth-config reads)
-- and every ON DELETE RESTRICT parent delete (which must scan the
-- child table) pay sequential scans. The gaps become load-bearing the
-- moment any list moves to targeted SQL (audit B-01/B-05).
--
-- Priority order (audit C-02): sessions.user_id,
-- accounts (provider_id, account_id), verifications (identifier,
-- value), license_events (license_id, created_at DESC) first, then
-- the rest. Every index is also declared in db/schema (same name,
-- same columns) so drizzle-kit generate reproduces it — see
-- db/schema/README.md.
--
-- Also adds the C-06 index on rate_limit_buckets.reset_at (the
-- expiry cleanup in audit B-12 scans it; without the index the prune
-- is a sequential scan over one row per bucket key forever).
--
-- All changes are additive and idempotent (CREATE INDEX IF NOT
-- EXISTS), so re-running is safe. Migrations 0000–0020 are NOT edited.

-- --- Priority: Better Auth lookups ---
CREATE INDEX IF NOT EXISTS "idx_sessions_user_id" ON "sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_accounts_provider_account" ON "accounts" ("provider_id", "account_id");
CREATE INDEX IF NOT EXISTS "idx_verifications_identifier_value" ON "verifications" ("identifier", "value");

-- --- Priority: license event history (newest first) ---
CREATE INDEX IF NOT EXISTS "idx_license_events_license_created" ON "license_events" ("license_id", "created_at" DESC);

-- --- Remaining FK indexes (audit C-02 list) ---
CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_user_id" ON "password_reset_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_webhook_endpoints_site_id" ON "webhook_endpoints" ("integrated_site_id");
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_endpoint_event" ON "webhook_deliveries" ("webhook_endpoint_id", "event_id");
CREATE INDEX IF NOT EXISTS "idx_invoice_items_invoice_id" ON "invoice_items" ("invoice_id");
CREATE INDEX IF NOT EXISTS "idx_payment_verification_logs_submission_id" ON "payment_verification_logs" ("payment_submission_id");
CREATE INDEX IF NOT EXISTS "idx_payment_refunds_transaction_id" ON "payment_refunds" ("payment_transaction_id");
CREATE INDEX IF NOT EXISTS "idx_tracking_deliveries_event_id" ON "tracking_deliveries" ("tracking_event_id");
CREATE INDEX IF NOT EXISTS "idx_subscription_events_subscription_id" ON "subscription_events" ("subscription_id");
CREATE INDEX IF NOT EXISTS "idx_site_domains_site_id" ON "site_domains" ("integrated_site_id");
CREATE INDEX IF NOT EXISTS "idx_site_credentials_site_id" ON "site_credentials" ("integrated_site_id");
CREATE INDEX IF NOT EXISTS "idx_product_releases_product_id" ON "product_releases" ("product_id");
CREATE INDEX IF NOT EXISTS "idx_invoices_order_id" ON "invoices" ("order_id");

-- --- C-06: rate_limit_buckets expiry scan ---
CREATE INDEX IF NOT EXISTS "idx_rate_limit_buckets_reset_at" ON "rate_limit_buckets" ("reset_at");
