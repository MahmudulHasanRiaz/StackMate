-- 0014 — audit fix batch (PLAN §36 / AUDIT-2026-11-19): customer dedupe
-- unique indexes (F-02), CHECK gaps on 0009-added columns (F-11),
-- licenses FK (F-14), admin users.manage grant (D-1), users.avatar_url
-- (D-5, full avatar batch).
--
-- DEPLOY SAFETY: every new constraint/index below is added ONLY when
-- the existing data already satisfies it. Each guarded step first
-- checks for violating rows; if any exist it RAISEs a NOTICE with the
-- count (and the first 10 offending values where useful) and SKIPS the
-- constraint instead of failing the deploy. The deploy then succeeds
-- with the old behaviour intact; the violating rows are a data-cleanup
-- follow-up, after which a later migration can add the skipped
-- constraint. On a clean database (fresh install, or staging after
-- cleanup) every step below applies, and the database matches
-- db/schema (which declares all of these constraints) exactly.
--
-- Why not CREATE UNIQUE INDEX CONCURRENTLY: the migration runner
-- (scripts/migrate.mjs) applies each file inside one transaction, and
-- CONCURRENTLY cannot run inside a transaction block. The DO-block
-- conditional below is the transaction-safe equivalent.
--
-- All changes are additive (new indexes / constraints / one nullable
-- column / one grant) and idempotent (IF NOT EXISTS / ON CONFLICT DO
-- NOTHING / pg_constraint + pg_class existence checks), so re-running
-- is safe. Migrations 0000–0013 are NOT edited.

-- --- F-02 (High): unique partial indexes on customers.normalized_email / normalized_phone ---
-- Staging already holds duplicate primaries from the old checkout path
-- (migration 0009 header comment), so each unique index is created
-- only when no duplicates exist for that column; otherwise the old
-- non-unique index stays and the duplicates are reported via NOTICE.
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
    RAISE NOTICE 'migration 0014: NOT creating uq_customers_normalized_email — % duplicate normalized_email values exist (first 10: %); clean them up, then add the index in a follow-up migration (audit F-02)', dup_count, dup_sample;
  ELSIF NOT EXISTS (SELECT 1 FROM "pg_class" WHERE "relname" = 'uq_customers_normalized_email' AND "relkind" = 'i') THEN
    DROP INDEX IF EXISTS "idx_customers_normalized_email";
    CREATE UNIQUE INDEX "uq_customers_normalized_email" ON "customers" ("normalized_email") WHERE "normalized_email" IS NOT NULL;
  END IF;
END $$;

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
    RAISE NOTICE 'migration 0014: NOT creating uq_customers_normalized_phone — % duplicate normalized_phone values exist (first 10: %); clean them up, then add the index in a follow-up migration (audit F-02)', dup_count, dup_sample;
  ELSIF NOT EXISTS (SELECT 1 FROM "pg_class" WHERE "relname" = 'uq_customers_normalized_phone' AND "relkind" = 'i') THEN
    DROP INDEX IF EXISTS "idx_customers_normalized_phone";
    CREATE UNIQUE INDEX "uq_customers_normalized_phone" ON "customers" ("normalized_phone") WHERE "normalized_phone" IS NOT NULL;
  END IF;
END $$;

-- --- F-11 (Medium): CHECK gaps on 0009-added columns ---
-- Each constraint is added only when no existing row violates it;
-- otherwise it is skipped with a NOTICE (see the header note).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "customers" WHERE "credit_balance_minor" < 0) THEN
    RAISE NOTICE 'migration 0014: skipping customers_credit_balance_minor_check — % rows have negative credit_balance_minor', (SELECT count(*) FROM "customers" WHERE "credit_balance_minor" < 0);
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'customers_credit_balance_minor_check' AND "conrelid" = '"customers"'::regclass
  ) THEN
    ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_balance_minor_check" CHECK ("credit_balance_minor" >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "activation_percent" IS NOT NULL AND ("activation_percent" < 1 OR "activation_percent" > 100)) THEN
    RAISE NOTICE 'migration 0014: skipping orders_activation_percent_check — % rows have activation_percent outside 1–100', (SELECT count(*) FROM "orders" WHERE "activation_percent" IS NOT NULL AND ("activation_percent" < 1 OR "activation_percent" > 100));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'orders_activation_percent_check' AND "conrelid" = '"orders"'::regclass
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_activation_percent_check" CHECK ("activation_percent" IS NULL OR ("activation_percent" >= 1 AND "activation_percent" <= 100));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "activation_mode" NOT IN ('on_full_payment', 'on_percent', 'on_date')) THEN
    RAISE NOTICE 'migration 0014: skipping orders_activation_mode_check — % rows have an unknown activation_mode', (SELECT count(*) FROM "orders" WHERE "activation_mode" NOT IN ('on_full_payment', 'on_percent', 'on_date'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'orders_activation_mode_check' AND "conrelid" = '"orders"'::regclass
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_activation_mode_check" CHECK ("activation_mode" IN ('on_full_payment', 'on_percent', 'on_date'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "order_installments" WHERE "status" NOT IN ('pending', 'partially_paid', 'paid', 'overdue')) THEN
    RAISE NOTICE 'migration 0014: skipping order_installments_status_check — % rows have an unknown installment status', (SELECT count(*) FROM "order_installments" WHERE "status" NOT IN ('pending', 'partially_paid', 'paid', 'overdue'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'order_installments_status_check' AND "conrelid" = '"order_installments"'::regclass
  ) THEN
    ALTER TABLE "order_installments" ADD CONSTRAINT "order_installments_status_check" CHECK ("status" IN ('pending', 'partially_paid', 'paid', 'overdue'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support_tickets" WHERE "status" NOT IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed')) THEN
    RAISE NOTICE 'migration 0014: skipping support_tickets_status_check — % rows have an unknown ticket status', (SELECT count(*) FROM "support_tickets" WHERE "status" NOT IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'support_tickets_status_check' AND "conrelid" = '"support_tickets"'::regclass
  ) THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_status_check" CHECK ("status" IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support_tickets" WHERE "priority" NOT IN ('low', 'medium', 'high', 'urgent')) THEN
    RAISE NOTICE 'migration 0014: skipping support_tickets_priority_check — % rows have an unknown ticket priority', (SELECT count(*) FROM "support_tickets" WHERE "priority" NOT IN ('low', 'medium', 'high', 'urgent'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'support_tickets_priority_check' AND "conrelid" = '"support_tickets"'::regclass
  ) THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_priority_check" CHECK ("priority" IN ('low', 'medium', 'high', 'urgent'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support_tickets" WHERE "category" NOT IN ('billing', 'technical', 'license', 'order', 'other')) THEN
    RAISE NOTICE 'migration 0014: skipping support_tickets_category_check — % rows have an unknown ticket category', (SELECT count(*) FROM "support_tickets" WHERE "category" NOT IN ('billing', 'technical', 'license', 'order', 'other'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'support_tickets_category_check' AND "conrelid" = '"support_tickets"'::regclass
  ) THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_category_check" CHECK ("category" IN ('billing', 'technical', 'license', 'order', 'other'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "leads" WHERE "status" NOT IN ('new', 'contacted', 'qualified', 'converted', 'lost')) THEN
    RAISE NOTICE 'migration 0014: skipping leads_status_check — % rows have an unknown lead status', (SELECT count(*) FROM "leads" WHERE "status" NOT IN ('new', 'contacted', 'qualified', 'converted', 'lost'));
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'leads_status_check' AND "conrelid" = '"leads"'::regclass
  ) THEN
    ALTER TABLE "leads" ADD CONSTRAINT "leads_status_check" CHECK ("status" IN ('new', 'contacted', 'qualified', 'converted', 'lost'));
  END IF;
END $$;

-- --- F-14 (Low): licenses.current_entitlement_snapshot_id foreign key ---
-- ON DELETE SET NULL: deleting a snapshot must not delete (or block
-- deleting) the license that points at it. Added only when no license
-- currently points at a missing snapshot; otherwise skipped with a
-- NOTICE (the finding's suggested action, after an orphan scan).
-- DEFERRABLE INITIALLY DEFERRED: the FK is circular with
-- license_entitlement_snapshots.license_id, and the store persists a
-- new license and its snapshot in one transaction (license row first)
-- so the check must wait until COMMIT, when both rows exist. A plain
-- FK breaks license issuance and every test that seeds a license.
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count FROM "licenses" l
  WHERE l."current_entitlement_snapshot_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "license_entitlement_snapshots" s WHERE s."id" = l."current_entitlement_snapshot_id");
  IF orphan_count > 0 THEN
    RAISE NOTICE 'migration 0014: NOT adding licenses_current_entitlement_snapshot_id_fkey — % licenses point at missing snapshots; clean them up first (audit F-14)', orphan_count;
  ELSIF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'licenses_current_entitlement_snapshot_id_fkey' AND "conrelid" = '"licenses"'::regclass
  ) THEN
    ALTER TABLE "licenses" ADD CONSTRAINT "licenses_current_entitlement_snapshot_id_fkey"
      FOREIGN KEY ("current_entitlement_snapshot_id") REFERENCES "license_entitlement_snapshots" ("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- --- D-1 (owner decision 2026-11-19, AUDIT §6): grant the admin role users.manage ---
-- The admin role was deliberately seeded without it (migration 0003:
-- "everything except users.manage"; db/seeds/seed-reference.ts filter).
-- The decision grants it, so admin can see and use Staff & Roles.
-- Idempotent: ON CONFLICT DO NOTHING on the role_permissions PK.
-- db/seeds/seed-reference.ts is updated in the same batch so fresh
-- installs (in-memory store) agree.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT '00000000-0000-4000-8000-000000000202'::uuid, "id" FROM "permissions"
WHERE "key" = 'users.manage'
ON CONFLICT DO NOTHING;

-- --- D-5 (owner decision 2026-11-19, AUDIT §6): users.avatar_url (full avatar batch) ---
-- One column only: the R2 object key of the staff member's custom
-- avatar (NULL = Gravatar default). The API upload endpoint + serving
-- and the SPA profile UI are built by the sibling fix agents in the
-- same batch; this migration only adds the storage.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text;
