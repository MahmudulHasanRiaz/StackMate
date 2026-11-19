# Drizzle schema

Place Drizzle table definitions here, grouped by domain where practical. Keep schema ownership aligned with the Database Design specification. Add schema only alongside a reviewed migration and tests.

## Hand-maintained SQL — `drizzle-kit generate` will never reproduce these

Verified 2026-11-15 by running `drizzle-kit generate` into a temp directory
and diffing against the committed migrations: the generated SQL matches the
schema except for the items below, which live ONLY in the SQL migrations.
Do not "fix" the schema to make generate emit them — that would be wrong;
keep them in SQL and keep this note accurate.

- **CHECK constraints (98 in migration 0000)**: present in SQL, enforced by
  Postgres at runtime, absent from the Drizzle schema. If you add a CHECK
  in SQL, add it in SQL only and note it here; if you add one in Drizzle,
  generate will emit it but the reverse is not true.
- **Immutability triggers (6) + function (1)**: SQL-only by nature
  (`CREATE TRIGGER` / `CREATE OR REPLACE FUNCTION` in migration 0000).
- **`product_packages.current_version_id` foreign key**: the column exists in
  the schema (`entitlements.ts`) but the FK is SQL-only (migration 0002) to
  avoid a TypeScript circular-reference cycle between the entitlements and
  catalog schema modules.
- **Index fidelity (fixed 2026-11-15, audit F3)**: the 20 `DESC` indexes and
  6 partial (`WHERE ... IS NOT NULL`) indexes ARE in the schema now and
  generate reproduces them — do not regress them.
- **No UUID defaults** on either side: inserts must supply `id`.
- **No meta snapshots are committed**, so `drizzle-kit check` cannot run;
  `scripts/check-migrations.mjs` is the consistency gate instead (it verifies
  all 63 tables against the union of migrations 0000–0003).
