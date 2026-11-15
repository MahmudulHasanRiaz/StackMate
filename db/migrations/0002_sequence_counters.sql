-- StackMate Migration 0002: Sequence counters + store-model persistence columns
--
-- Why this migration exists: the API services program against the
-- StackMateDataStore state model, and several fields that services actively
-- read/write had NO column in migration 0000, so a PostgreSQL-backed store
-- could not persist them losslessly (they would silently vanish on reload):
--
--   sequence_counters table ......... services increment counters in-tx to
--                                     mint CUST-/ORD-/INV-/SUB-/LIC- numbers
--   users.password_hash ............. staff scrypt sign-in (identity service)
--   products.default_activation_limit / offline_grace_hours
--                                     license/subscription grace math
--   product_packages.current_version_id ... set on package publish
--   package_version_features.unit_snapshot (sibling snapshot tables have it)
--   package_prices.used_in_orders ... set when a price is used in an order
--   payment_submissions.duplicate_risk_warning
--   subscriptions.unit_amount_minor . copied from the source order item
--   tracking_events.delivery_attempts / delivered_at (outbox dispatcher)
--   idempotency_records.response_body   0000 only had response_reference
--                                     (varchar 160), which cannot hold real
--                                     replay bodies
--   licenses.integration_profile_id . was NOT NULL, but the service model
--                                     (LicenseRecord) never carries a profile,
--                                     so no license insert could satisfy it;
--                                     relaxed to nullable (expand-and-contract)
--
-- All changes are additive (new table / new nullable-or-defaulted columns /
-- one relaxed constraint) and idempotent, so re-running is safe. Migration
-- 0000/0001 are NOT edited. The Drizzle schema files mirror these columns.
-- DrizzleStore works on a database WITHOUT this migration too (it detects
-- the missing objects and falls back to defaults / in-memory counters), but
-- full fidelity — durable counters, staff passwords, idempotency replay of
-- large bodies, license issuance — requires 0002 to be applied.

CREATE TABLE IF NOT EXISTS "sequence_counters" (
  "counter_key" varchar(40) PRIMARY KEY NOT NULL,
  "counter_value" bigint NOT NULL CHECK ("counter_value" >= 0),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Base values match the in-memory store's initial counters.
INSERT INTO "sequence_counters" ("counter_key", "counter_value")
VALUES
  ('customer', 1000),
  ('order', 10000),
  ('invoice', 20000),
  ('subscription', 30000),
  ('license', 40000)
ON CONFLICT ("counter_key") DO NOTHING;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "default_activation_limit" integer NOT NULL DEFAULT 1 CHECK ("default_activation_limit" >= 1);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "offline_grace_hours" integer NOT NULL DEFAULT 72 CHECK ("offline_grace_hours" >= 0);

ALTER TABLE "product_packages" ADD COLUMN IF NOT EXISTS "current_version_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_product_packages_current_version'
  ) THEN
    ALTER TABLE "product_packages"
      ADD CONSTRAINT "fk_product_packages_current_version"
      FOREIGN KEY ("current_version_id") REFERENCES "package_versions" ("id") ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE "package_version_features" ADD COLUMN IF NOT EXISTS "unit_snapshot" varchar(50);

ALTER TABLE "package_prices" ADD COLUMN IF NOT EXISTS "used_in_orders" boolean NOT NULL DEFAULT false;

ALTER TABLE "payment_submissions" ADD COLUMN IF NOT EXISTS "duplicate_risk_warning" boolean NOT NULL DEFAULT false;

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "unit_amount_minor" bigint NOT NULL DEFAULT 0 CHECK ("unit_amount_minor" >= 0);

ALTER TABLE "tracking_events" ADD COLUMN IF NOT EXISTS "delivery_attempts" integer NOT NULL DEFAULT 0 CHECK ("delivery_attempts" >= 0);
ALTER TABLE "tracking_events" ADD COLUMN IF NOT EXISTS "delivered_at" timestamptz;

ALTER TABLE "idempotency_records" ADD COLUMN IF NOT EXISTS "response_body" jsonb;

-- License issuance never supplies an integration profile (the service model
-- has no such field); the NOT NULL constraint made every license insert
-- fail. Relax it; validation resolves its profile from the request.
ALTER TABLE "licenses" ALTER COLUMN "integration_profile_id" DROP NOT NULL;
