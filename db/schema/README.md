# Drizzle schema

Place Drizzle table definitions here, grouped by domain where practical. Keep schema ownership aligned with the Database Design specification. Add schema only alongside a reviewed migration and tests.

## Hand-maintained SQL — `drizzle-kit generate` will never reproduce these

Verified 2026-11-25 by running `drizzle-kit generate` into a temp directory
and diffing against the committed migrations (audit 2026-11-25 C-08;
migrations 0000–0024, 85 tables): the generated SQL matches the
schema except for the items below, which live ONLY in the SQL migrations.
Do not "fix" the schema to make generate emit them — that would be wrong;
keep them in SQL and keep this note accurate.

- **CHECK constraints (declared in Drizzle since migration 0014, audit
  F-11)**: all 124 live CHECKs are declared in the schema via `check()`
  (named `<table>_<column>_check`), so `drizzle-kit generate`
  reproduces them. The migrations contain 140 `CHECK (` occurrences —
  the extra 16 are superseded/re-added duplicates, not live constraints:
  the superseded 0000 `orders.payment_status` (without `partially_paid`),
  replaced by migration 0010 (1); the three widened status CHECKs
  re-added by migration 0015 (3) and the outbox one re-added by 0017
  (1); and the eleven re-attempted/repaired CHECKs in migration 0020
  (audit C-01: 8 F-11 CHECKs + 3 widened status CHECKs) (11). Form
  differs, predicates don't: generate emits each CHECK as a named
  `CONSTRAINT "<table>_<column>_check"`, while the committed SQL has
  them inline (migration 0000) or named (0007/0010/0014). Do NOT revert
  to the pre-0014 "CHECKs are SQL-only" rule — a regeneration without
  them would drop the constraints.
- **Immutability triggers (6) + function (1)**: SQL-only by nature
  (`CREATE TRIGGER` / `CREATE OR REPLACE FUNCTION` in migration 0000).
- **`product_packages.current_version_id` and
  `licenses.current_entitlement_snapshot_id` foreign keys**: the columns
  exist in the schema (`entitlements.ts`, `licenses.ts`) but the FKs are
  SQL-only (migrations 0002 and 0014) to avoid a TypeScript
  circular-reference cycle (TS7022/TS7024) — the two tables reference
  each other in both cases. Same SQL-only precedent as
  `signing_keys.supersedes_key_id` and `leads.converted_order_id`.
  Also SQL-only for the same circular-import reason (migration 0023,
  audit C-04): `subscription_periods.invoice_id` and
  `subscription_periods.payment_transaction_id` (both ON DELETE SET
  NULL), and `subscription_events.related_invoice_id` (ON DELETE SET
  NULL) — `invoices.ts` already imports `subscriptions.ts`.
- **Index fidelity (fixed 2026-11-15, audit F3)**: the 20 `DESC` indexes and
  6 partial (`WHERE ... IS NOT NULL`) indexes ARE in the schema now and
  generate reproduces them — do not regress them.
- **Media search indexes (migration 0022, audit C-03)**: the pg_trgm
  GIN index on `media_assets.original_filename` and the GIN index on
  `media_assets.tags` ARE declared in the schema (`media.ts`, the
  trigram opclass via an `sql` fragment) and generate reproduces them
  verbatim (`USING gin ("original_filename" gin_trgm_ops)`). `pg_trgm`
  is a PostgreSQL contrib extension — see the portability note in the
  migration 0022 header (Postgres-only; the MySQL second-dialect
  direction needs its own full-text index).
- **Known generate-diff exception (pre-existing, found by the 2026-11-25
  re-run, NOT fixed here — follow-up migration owed)**: the schema
  declares `idx_sent_reminders_reference` on `sent_reminders`
  (`reminders.ts`), but no committed migration creates it and the live
  DB does not have it. Everything else in the generate diff is
  accounted for above (inline-CHECK form, SQL-only FKs/triggers, and
  `unique()` declarations, which generate emits as CONSTRAINTs rather
  than CREATE INDEX statements).
- **Migration race + CHECK-drop by prefix (audit C-09, ACCEPTED)**:
  the check-then-create unique-index steps in 0014/0015/0020 can race
  a concurrent app insert of a duplicate (the migration transaction
  then fails loudly and blocks the deploy; `CREATE UNIQUE INDEX
  CONCURRENTLY` cannot run inside the runner's transaction, and the
  migrate.mjs advisory lock already serialises deploys). The CHECK
  widenings in 0015/0017 drop by name-prefix lookup
  (`conname LIKE '<table>_status_check%'`), which would also drop a
  future same-prefix CHECK on that table. Both are accepted as-is for
  the old migrations (never rewrite an applied migration). New
  migrations MUST pin exact constraint names: migration 0020 drops
  only the exact-named `tracking_events_status_check` /
  `outbox_events_status_check` / `webhook_deliveries_status_check`.
- **Correction (audit C-06)**: migration 0016's header claims the
  `rate_limit_buckets` table follows "the same pattern as migration
  0012's media tables, which have no db/schema declaration either".
  That is wrong — `media_assets` IS declared in `db/schema/media.ts`.
  Migration 0016 itself is NOT edited (never rewrite an applied
  migration); `rate_limit_buckets` is now declared in
  `db/schema/rate-limit.ts`, and this note is the correction.
- **No UUID defaults** on either side: inserts must supply `id`.
- **No meta snapshots are committed**, so `drizzle-kit check` cannot run;
  `scripts/check-migrations.mjs` is the consistency gate instead (it verifies
  all 85 tables against the union of migrations 0000–0024, including a
  column-list compare added in audit C-08).
