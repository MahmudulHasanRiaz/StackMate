-- 0020 — audit 2026-11-25 C-01 [PRIOR]: re-attempt the constraints that
-- migrations 0014/0015 may have SKIPPED on staging.
--
-- Why this migration exists: 0014/0015 add each constraint only when
-- the existing data already satisfies it; on violating data they log
-- a NOTICE and skip — but scripts/migrate.mjs still records the file
-- as applied forever, so re-running migrations never restores the
-- invariant. This migration re-attempts exactly those guarded steps
-- (same DO-block pattern, same predicates), so a database whose data
-- has since been cleaned up gains the constraints, while a database
-- that still holds violating rows keeps working and gets a fresh
-- NOTICE naming the blocker. On a clean database (fresh install, or
-- staging after cleanup) every step below applies and the database
-- matches db/schema (which declares all of these constraints).
--
-- What is re-attempted:
--   0014 F-02 ... uq_customers_normalized_email,
--                 uq_customers_normalized_phone (partial unique indexes)
--   0014 F-11 ... customers_credit_balance_minor_check,
--                 orders_activation_percent_check,
--                 orders_activation_mode_check,
--                 order_installments_status_check,
--                 support_tickets_status_check / _priority_check /
--                 _category_check, leads_status_check
--   0014 F-14 ... licenses_current_entitlement_snapshot_id_fkey
--                 (ON DELETE SET NULL, DEFERRABLE INITIALLY DEFERRED)
--   0015 F-01 ... uq_payment_transactions_provider_txn_succeeded
--                 (partial unique index)
--   0015 C-2/D-6 + 0017 Q3 ... tracking_events_status_check,
--                 outbox_events_status_check, webhook_deliveries_status_check
--                 (widened to include 'simulated'; outbox also 'skipped').
--                 These three cannot skip on data (widening is a superset
--                 change), so this migration only VERIFIES their live
--                 definition and repairs it if it is stale — it drops by
--                 EXACT constraint name only (audit C-09: never by
--                 name-prefix LIKE), and only when the live definition
--                 lacks a required value.
--
-- DEPLOY SAFETY (audit C-09, accepted): the unique-index steps still
-- check-then-create as separate statements — a concurrent app insert
-- of a duplicate between the check and the CREATE can fail this
-- migration transaction (the deploy then blocks; the old app keeps
-- serving). CREATE UNIQUE INDEX CONCURRENTLY cannot run inside the
-- runner's transaction, and the migrate.mjs advisory lock already
-- serialises deploys; the window is small and the failure is loud,
-- not silent. No CHECK is dropped by name prefix anywhere in this
-- file: every DROP names the exact constraint.
--
-- All changes are additive and idempotent (pg_constraint / pg_class
-- existence checks + data checks before every step), so re-running is
-- safe. Migrations 0000–0019 are NOT edited.

-- --- 0014 F-02: uq_customers_normalized_email ---
DO $$
DECLARE
  dup_count integer;
  dup_sample text;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT "normalized_email" FROM "customers"
    WHERE "normalized_email" IS NOT NULL
    GROUP BY "normalized_email" HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    SELECT string_agg(quote_literal(v), ', ') INTO dup_sample FROM (
      SELECT "normalized_email" AS v FROM "customers"
      WHERE "normalized_email" IS NOT NULL
      GROUP BY "normalized_email" HAVING count(*) > 1
      ORDER BY "normalized_email" LIMIT 10
    ) s;
    RAISE NOTICE 'migration 0020: NOT creating uq_customers_normalized_email — % duplicate normalized_email values still exist (first 10: %); clean them up, then re-run this migration (audit C-01 / F-02)', dup_count, dup_sample;
  ELSIF NOT EXISTS (SELECT 1 FROM "pg_class" WHERE "relname" = 'uq_customers_normalized_email' AND "relkind" = 'i') THEN
    DROP INDEX IF EXISTS "idx_customers_normalized_email";
    CREATE UNIQUE INDEX "uq_customers_normalized_email" ON "customers" ("normalized_email") WHERE "normalized_email" IS NOT NULL;
  END IF;
END $$;

-- --- 0014 F-02: uq_customers_normalized_phone ---
DO $$
DECLARE
  dup_count integer;
  dup_sample text;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT "normalized_phone" FROM "customers"
    WHERE "normalized_phone" IS NOT NULL
    GROUP BY "normalized_phone" HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    SELECT string_agg(quote_literal(v), ', ') INTO dup_sample FROM (
      SELECT "normalized_phone" AS v FROM "customers"
      WHERE "normalized_phone" IS NOT NULL
      GROUP BY "normalized_phone" HAVING count(*) > 1
      ORDER BY "normalized_phone" LIMIT 10
    ) s;
    RAISE NOTICE 'migration 0020: NOT creating uq_customers_normalized_phone — % duplicate normalized_phone values still exist (first 10: %); clean them up, then re-run this migration (audit C-01 / F-02)', dup_count, dup_sample;
  ELSIF NOT EXISTS (SELECT 1 FROM "pg_class" WHERE "relname" = 'uq_customers_normalized_phone' AND "relkind" = 'i') THEN
    DROP INDEX IF EXISTS "idx_customers_normalized_phone";
    CREATE UNIQUE INDEX "uq_customers_normalized_phone" ON "customers" ("normalized_phone") WHERE "normalized_phone" IS NOT NULL;
  END IF;
END $$;

-- --- 0014 F-11: customers_credit_balance_minor_check ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "customers" WHERE "credit_balance_minor" < 0) THEN
    RAISE NOTICE 'migration 0020: skipping customers_credit_balance_minor_check — % rows still have negative credit_balance_minor', (SELECT count(*) FROM "customers" WHERE "credit_balance_minor" < 0);
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'customers_credit_balance_minor_check' AND "conrelid" = '"customers"'::regclass
  ) THEN
    ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_balance_minor_check" CHECK ("credit_balance_minor" >= 0);
  END IF;
END $$;

-- --- 0014 F-11: orders_activation_percent_check ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "activation_percent" IS NOT NULL AND ("activation_percent" < 1 OR "activation_percent" > 100)) THEN
    RAISE NOTICE 'migration 0020: skipping orders_activation_percent_check — % rows still have activation_percent outside 1–100', (SELECT count(*) FROM "orders" WHERE "activation_percent" IS NOT NULL AND ("activation_percent" < 1 OR "activation_percent" > 100));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'orders_activation_percent_check' AND "conrelid" = '"orders"'::regclass
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_activation_percent_check" CHECK ("activation_percent" IS NULL OR ("activation_percent" >= 1 AND "activation_percent" <= 100));
  END IF;
END $$;

-- --- 0014 F-11: orders_activation_mode_check ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "activation_mode" NOT IN ('on_full_payment', 'on_percent', 'on_date')) THEN
    RAISE NOTICE 'migration 0020: skipping orders_activation_mode_check — % rows still have an unknown activation_mode', (SELECT count(*) FROM "orders" WHERE "activation_mode" NOT IN ('on_full_payment', 'on_percent', 'on_date'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'orders_activation_mode_check' AND "conrelid" = '"orders"'::regclass
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_activation_mode_check" CHECK ("activation_mode" IN ('on_full_payment', 'on_percent', 'on_date'));
  END IF;
END $$;

-- --- 0014 F-11: order_installments_status_check ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "order_installments" WHERE "status" NOT IN ('pending', 'partially_paid', 'paid', 'overdue')) THEN
    RAISE NOTICE 'migration 0020: skipping order_installments_status_check — % rows still have an unknown installment status', (SELECT count(*) FROM "order_installments" WHERE "status" NOT IN ('pending', 'partially_paid', 'paid', 'overdue'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'order_installments_status_check' AND "conrelid" = '"order_installments"'::regclass
  ) THEN
    ALTER TABLE "order_installments" ADD CONSTRAINT "order_installments_status_check" CHECK ("status" IN ('pending', 'partially_paid', 'paid', 'overdue'));
  END IF;
END $$;

-- --- 0014 F-11: support_tickets_status_check ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support_tickets" WHERE "status" NOT IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed')) THEN
    RAISE NOTICE 'migration 0020: skipping support_tickets_status_check — % rows still have an unknown ticket status', (SELECT count(*) FROM "support_tickets" WHERE "status" NOT IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'support_tickets_status_check' AND "conrelid" = '"support_tickets"'::regclass
  ) THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_status_check" CHECK ("status" IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'));
  END IF;
END $$;

-- --- 0014 F-11: support_tickets_priority_check ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support_tickets" WHERE "priority" NOT IN ('low', 'medium', 'high', 'urgent')) THEN
    RAISE NOTICE 'migration 0020: skipping support_tickets_priority_check — % rows still have an unknown ticket priority', (SELECT count(*) FROM "support_tickets" WHERE "priority" NOT IN ('low', 'medium', 'high', 'urgent'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'support_tickets_priority_check' AND "conrelid" = '"support_tickets"'::regclass
  ) THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_priority_check" CHECK ("priority" IN ('low', 'medium', 'high', 'urgent'));
  END IF;
END $$;

-- --- 0014 F-11: support_tickets_category_check ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support_tickets" WHERE "category" NOT IN ('billing', 'technical', 'license', 'order', 'other')) THEN
    RAISE NOTICE 'migration 0020: skipping support_tickets_category_check — % rows still have an unknown ticket category', (SELECT count(*) FROM "support_tickets" WHERE "category" NOT IN ('billing', 'technical', 'license', 'order', 'other'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'support_tickets_category_check' AND "conrelid" = '"support_tickets"'::regclass
  ) THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_category_check" CHECK ("category" IN ('billing', 'technical', 'license', 'order', 'other'));
  END IF;
END $$;

-- --- 0014 F-11: leads_status_check ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "leads" WHERE "status" NOT IN ('new', 'contacted', 'qualified', 'converted', 'lost')) THEN
    RAISE NOTICE 'migration 0020: skipping leads_status_check — % rows still have an unknown lead status', (SELECT count(*) FROM "leads" WHERE "status" NOT IN ('new', 'contacted', 'qualified', 'converted', 'lost'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'leads_status_check' AND "conrelid" = '"leads"'::regclass
  ) THEN
    ALTER TABLE "leads" ADD CONSTRAINT "leads_status_check" CHECK ("status" IN ('new', 'contacted', 'qualified', 'converted', 'lost'));
  END IF;
END $$;

-- --- 0014 F-14: licenses_current_entitlement_snapshot_id_fkey ---
-- ON DELETE SET NULL, DEFERRABLE INITIALLY DEFERRED (circular with
-- license_entitlement_snapshots.license_id — see db/schema/licenses.ts).
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count FROM "licenses" l
  WHERE l."current_entitlement_snapshot_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "license_entitlement_snapshots" s WHERE s."id" = l."current_entitlement_snapshot_id");
  IF orphan_count > 0 THEN
    RAISE NOTICE 'migration 0020: NOT adding licenses_current_entitlement_snapshot_id_fkey — % licenses still point at missing snapshots; clean them up first (audit C-01 / F-14)', orphan_count;
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'licenses_current_entitlement_snapshot_id_fkey' AND "conrelid" = '"licenses"'::regclass
  ) THEN
    ALTER TABLE "licenses" ADD CONSTRAINT "licenses_current_entitlement_snapshot_id_fkey"
      FOREIGN KEY ("current_entitlement_snapshot_id") REFERENCES "license_entitlement_snapshots" ("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- --- 0015 F-01: uq_payment_transactions_provider_txn_succeeded ---
DO $$
DECLARE
  dup_count integer;
  dup_sample text;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT "provider_id", "provider_transaction_id" FROM "payment_transactions"
    WHERE "status" = 'succeeded' AND "provider_transaction_id" IS NOT NULL
    GROUP BY "provider_id", "provider_transaction_id" HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    SELECT string_agg(quote_literal(v), ', ') INTO dup_sample FROM (
      SELECT "provider_id"::text || '/' || "provider_transaction_id" AS v FROM "payment_transactions"
      WHERE "status" = 'succeeded' AND "provider_transaction_id" IS NOT NULL
      GROUP BY "provider_id", "provider_transaction_id" HAVING count(*) > 1
      ORDER BY "provider_id", "provider_transaction_id" LIMIT 10
    ) s;
    RAISE NOTICE 'migration 0020: NOT creating uq_payment_transactions_provider_txn_succeeded — % duplicate succeeded (provider_id, provider_transaction_id) pairs still exist (first 10: %); clean them up, then re-run this migration (audit C-01 / F-01)', dup_count, dup_sample;
  ELSIF NOT EXISTS (SELECT 1 FROM "pg_class" WHERE "relname" = 'uq_payment_transactions_provider_txn_succeeded' AND "relkind" = 'i') THEN
    CREATE UNIQUE INDEX "uq_payment_transactions_provider_txn_succeeded" ON "payment_transactions" ("provider_id", "provider_transaction_id") WHERE "status" = 'succeeded' AND "provider_transaction_id" IS NOT NULL;
  END IF;
END $$;

-- --- 0015 C-2/D-6 + 0017 Q3: verify/repair the three widened status CHECKs ---
-- Each block reads the live definition of the exact-named constraint:
-- correct already → no-op; stale (a required value missing) → drop by
-- EXACT name and re-add the full widened list; absent → add it.
-- Widening is a superset change, so no existing row can violate the
-- new CHECK and the repair cannot fail on data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'tracking_events_status_check' AND "conrelid" = '"tracking_events"'::regclass
      AND "contype" = 'c' AND pg_get_constraintdef(oid) LIKE '%simulated%'
  ) THEN
    RAISE NOTICE 'migration 0020: tracking_events_status_check already includes simulated — no-op';
  ELSE
    ALTER TABLE "tracking_events" DROP CONSTRAINT IF EXISTS "tracking_events_status_check";
    ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_status_check"
      CHECK ("status" IN ('received', 'queued', 'processed', 'rejected', 'simulated'));
    RAISE NOTICE 'migration 0020: tracking_events_status_check (re)created with simulated';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'outbox_events_status_check' AND "conrelid" = '"outbox_events"'::regclass
      AND "contype" = 'c' AND pg_get_constraintdef(oid) LIKE '%simulated%' AND pg_get_constraintdef(oid) LIKE '%skipped%'
  ) THEN
    RAISE NOTICE 'migration 0020: outbox_events_status_check already includes simulated + skipped — no-op';
  ELSE
    ALTER TABLE "outbox_events" DROP CONSTRAINT IF EXISTS "outbox_events_status_check";
    ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_status_check"
      CHECK ("status" IN ('pending', 'processing', 'delivered', 'dead_letter', 'simulated', 'skipped'));
    RAISE NOTICE 'migration 0020: outbox_events_status_check (re)created with simulated + skipped';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'webhook_deliveries_status_check' AND "conrelid" = '"webhook_deliveries"'::regclass
      AND "contype" = 'c' AND pg_get_constraintdef(oid) LIKE '%simulated%'
  ) THEN
    RAISE NOTICE 'migration 0020: webhook_deliveries_status_check already includes simulated — no-op';
  ELSE
    ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_status_check";
    ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_status_check"
      CHECK ("status" IN ('pending', 'delivered', 'retrying', 'failed', 'simulated'));
    RAISE NOTICE 'migration 0020: webhook_deliveries_status_check (re)created with simulated';
  END IF;
END $$;
