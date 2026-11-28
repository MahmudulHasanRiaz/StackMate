-- 0023 — audit 2026-11-25 C-04: FKs for the FK-less subscription
-- pointer columns (orphan scan first, ON DELETE SET NULL).
--
-- subscription_periods.invoice_id / .payment_transaction_id and
-- subscription_events.related_invoice_id are bare uuid columns with
-- no REFERENCES (migration 0000; db/schema agrees — no .references(),
-- so this is a real gap, not drift). A period/event can point at an
-- invoice or payment transaction that does not exist (or was deleted);
-- renewal/invoice reconciliation then reads a dangling pointer.
--
-- ON DELETE SET NULL matches the neighbouring nullable links (the
-- same columns are nullable pointers, not ownership links): deleting
-- an invoice/payment must never delete — or block deleting — the
-- subscription history that references it.
--
-- Each FK is added only when no orphan rows exist for that column;
-- otherwise it is SKIPPED with a NOTICE (same DO-block pattern as
-- migration 0014) and the orphan count is reported — the live orphan
-- scan is audit LV-06. A later migration can add a skipped FK after
-- the orphans are cleaned up.
--
-- The FKs live ONLY in this migration's SQL, NOT in db/schema: the
-- Drizzle declarations would need subscriptions.ts to import
-- invoices.ts / payments.ts, but invoices.ts already imports
-- subscriptions.ts — a column-level .references() closure makes
-- TypeScript's inference circular (TS7022/TS7024). Same SQL-only
-- precedent as licenses.current_entitlement_snapshot_id (migration
-- 0014), product_packages.current_version_id, signing_keys.
-- supersedes_key_id, and leads.converted_order_id — see the NOTE
-- comments on the columns in db/schema/subscriptions.ts and
-- db/schema/README.md.
--
-- All changes are additive and idempotent (pg_constraint existence
-- checks + orphan checks before every step), so re-running is safe.
-- Migrations 0000–0022 are NOT edited.

-- --- subscription_periods.invoice_id -> invoices(id) ---
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count FROM "subscription_periods" p
  WHERE p."invoice_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "invoices" i WHERE i."id" = p."invoice_id");
  IF orphan_count > 0 THEN
    RAISE NOTICE 'migration 0023: NOT adding subscription_periods_invoice_id_fkey — % subscription_periods rows point at missing invoices; clean them up first (audit C-04 / LV-06)', orphan_count;
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'subscription_periods_invoice_id_fkey' AND "conrelid" = '"subscription_periods"'::regclass
  ) THEN
    ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_invoice_id_fkey"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE SET NULL;
  END IF;
END $$;

-- --- subscription_periods.payment_transaction_id -> payment_transactions(id) ---
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count FROM "subscription_periods" p
  WHERE p."payment_transaction_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "payment_transactions" t WHERE t."id" = p."payment_transaction_id");
  IF orphan_count > 0 THEN
    RAISE NOTICE 'migration 0023: NOT adding subscription_periods_payment_transaction_id_fkey — % subscription_periods rows point at missing payment transactions; clean them up first (audit C-04 / LV-06)', orphan_count;
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'subscription_periods_payment_transaction_id_fkey' AND "conrelid" = '"subscription_periods"'::regclass
  ) THEN
    ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_payment_transaction_id_fkey"
      FOREIGN KEY ("payment_transaction_id") REFERENCES "payment_transactions" ("id") ON DELETE SET NULL;
  END IF;
END $$;

-- --- subscription_events.related_invoice_id -> invoices(id) ---
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count FROM "subscription_events" e
  WHERE e."related_invoice_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "invoices" i WHERE i."id" = e."related_invoice_id");
  IF orphan_count > 0 THEN
    RAISE NOTICE 'migration 0023: NOT adding subscription_events_related_invoice_id_fkey — % subscription_events rows point at missing invoices; clean them up first (audit C-04 / LV-06)', orphan_count;
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'subscription_events_related_invoice_id_fkey' AND "conrelid" = '"subscription_events"'::regclass
  ) THEN
    ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_related_invoice_id_fkey"
      FOREIGN KEY ("related_invoice_id") REFERENCES "invoices" ("id") ON DELETE SET NULL;
  END IF;
END $$;
