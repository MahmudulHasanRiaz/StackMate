-- 0015 — audit fix follow-up (AUDIT-2026-11-19, C-2/D-6 + F-01):
-- widen the three status CHECKs to include 'simulated', and add a
-- defense-in-depth partial unique index on payment_transactions.
--
-- C-2/D-6 (BLOCKER for staging): the domain agent's service records
-- simulated webhooks/CAPI as status "simulated", but the CHECKs below
-- excluded it, so the Drizzle store could not persist those rows (the
-- UPDATE violated the CHECK). The widened lists cover exactly the rows
-- the service writes via markSimulated: tracking_events (tracking
-- meta_capi.dispatch), webhook_deliveries (simulated 200), and
-- outbox_events (terminal simulated mark). tracking_deliveries is NOT
-- touched — the service never writes 'simulated' there.
--
-- DEPLOY SAFETY: widening an IN list is a superset change — every value
-- the old CHECK accepted is still accepted, so no existing row can
-- violate the new CHECK and the drop + re-add below cannot fail on
-- data. The drop is done by name-prefix lookup (pg_constraint) so it
-- works whether the constraint came from migration 0000 (Postgres
-- auto-name `<table>_<column>_check`) or from drizzle-kit generate
-- (explicit name). The F-01 index is guarded with the same DO-block +
-- NOTICE pattern as migration 0014: if duplicate succeeded
-- (provider_id, provider_transaction_id) pairs already exist, the
-- index is SKIPPED with a NOTICE (deploy succeeds; duplicates are a
-- data-cleanup follow-up), otherwise it is created.
--
-- All changes are additive and idempotent (name-prefix drop + re-add /
-- pg_class existence check), so re-running is safe. Migrations
-- 0000–0014 are NOT edited.

-- --- C-2/D-6: widen tracking_events_status_check ---
-- Old: ('received', 'queued', 'processed', 'rejected')
-- New: + 'simulated'
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN SELECT "conname" FROM "pg_constraint"
    WHERE "conrelid" = '"tracking_events"'::regclass AND "contype" = 'c'
      AND "conname" LIKE 'tracking_events_status_check%'
  LOOP
    EXECUTE format('ALTER TABLE "tracking_events" DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_status_check"
  CHECK ("status" IN ('received', 'queued', 'processed', 'rejected', 'simulated'));

-- --- C-2/D-6: widen outbox_events_status_check ---
-- Old: ('pending', 'processing', 'delivered', 'dead_letter')
-- New: + 'simulated'
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN SELECT "conname" FROM "pg_constraint"
    WHERE "conrelid" = '"outbox_events"'::regclass AND "contype" = 'c'
      AND "conname" LIKE 'outbox_events_status_check%'
  LOOP
    EXECUTE format('ALTER TABLE "outbox_events" DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_status_check"
  CHECK ("status" IN ('pending', 'processing', 'delivered', 'dead_letter', 'simulated'));

-- --- C-2/D-6: widen webhook_deliveries_status_check ---
-- Old: ('pending', 'delivered', 'retrying', 'failed')
-- New: + 'simulated'
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN SELECT "conname" FROM "pg_constraint"
    WHERE "conrelid" = '"webhook_deliveries"'::regclass AND "contype" = 'c'
      AND "conname" LIKE 'webhook_deliveries_status_check%'
  LOOP
    EXECUTE format('ALTER TABLE "webhook_deliveries" DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_status_check"
  CHECK ("status" IN ('pending', 'delivered', 'retrying', 'failed', 'simulated'));

-- --- F-01 (High, defense-in-depth): partial unique index on payment_transactions ---
-- The service layer already guards duplicate approval of the same
-- provider transaction (audit F-01); this index makes the invariant
-- hold even if two approvals race. Partial on status = 'succeeded'
-- (only a succeeded transaction credits money) and
-- provider_transaction_id IS NOT NULL (manual payments carry no
-- provider id). The pre-existing non-unique
-- idx_payment_transactions_provider_txn is KEPT — it covers all
-- non-NULL provider transactions, not just succeeded ones.
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
    RAISE NOTICE 'migration 0015: NOT creating uq_payment_transactions_provider_txn_succeeded — % duplicate succeeded (provider_id, provider_transaction_id) pairs exist (first 10: %); clean them up, then add the index in a follow-up migration (audit F-01)', dup_count, dup_sample;
  ELSIF NOT EXISTS (SELECT 1 FROM "pg_class" WHERE "relname" = 'uq_payment_transactions_provider_txn_succeeded' AND "relkind" = 'i') THEN
    CREATE UNIQUE INDEX "uq_payment_transactions_provider_txn_succeeded" ON "payment_transactions" ("provider_id", "provider_transaction_id") WHERE "status" = 'succeeded' AND "provider_transaction_id" IS NOT NULL;
  END IF;
END $$;
