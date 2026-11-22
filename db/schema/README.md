# Drizzle schema

Place Drizzle table definitions here, grouped by domain where practical. Keep schema ownership aligned with the Database Design specification. Add schema only alongside a reviewed migration and tests.

## Hand-maintained SQL — `drizzle-kit generate` will never reproduce these

Verified 2026-11-15 by running `drizzle-kit generate` into a temp directory
and diffing against the committed migrations: the generated SQL matches the
schema except for the items below, which live ONLY in the SQL migrations.
Do not "fix" the schema to make generate emit them — that would be wrong;
keep them in SQL and keep this note accurate.

- **CHECK constraints (declared in Drizzle since migration 0014, audit
  F-11)**: all 123 live CHECKs are declared in the schema via `check()`
  (named `<table>_<column>_check`), so `drizzle-kit generate`
  reproduces them. The migrations contain 127 `CHECK (` occurrences —
  the extra ones are the superseded 0000 `orders.payment_status`
  (without `partially_paid`), replaced by migration 0010, and the three
  widened status CHECKs re-added by migration 0015 (audit C-2/D-6:
  tracking_events / outbox_events / webhook_deliveries gain
  'simulated'). Form differs, predicates don't: generate emits each CHECK as a named
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
- **Index fidelity (fixed 2026-11-15, audit F3)**: the 20 `DESC` indexes and
  6 partial (`WHERE ... IS NOT NULL`) indexes ARE in the schema now and
  generate reproduces them — do not regress them.
- **No UUID defaults** on either side: inserts must supply `id`.
- **No meta snapshots are committed**, so `drizzle-kit check` cannot run;
  `scripts/check-migrations.mjs` is the consistency gate instead (it verifies
  all 81 tables against the union of migrations 0000–0015).
