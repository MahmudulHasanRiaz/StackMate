# Project scripts

Reserved for repeatable local development, validation, database maintenance, and release scripts. Scripts must be safe by default, documented, and must not embed credentials.

All scripts are real runners — the ZIP's fake verification scripts (Babel
transpile-only "typecheck", copy-only "build", transpile-and-run-one-file
"tests") were replaced on 2026-11-15. Never edit a script to hide a failure.

| Script | What it really does |
| :--- | :--- |
| `scripts/typecheck.mjs` | Real `tsc --noEmit` per workspace package (`pnpm -r run typecheck`); fails on type errors |
| `scripts/build-all.mjs` | Real admin `tsc + vite build` and API `wrangler deploy --dry-run` (bundle validation; never claims a deploy). Falls back to a local esbuild bundle check only if wrangler cannot run offline, and says so |
| `scripts/run-tests.mjs` | Real `vitest run` over `apps/api/test` (and any new tests) |
| `scripts/check-migrations.mjs` | Verifies all 63 Drizzle tables against the UNION of all committed migrations (0000–0003); enforces ordered/unique journal entries, no orphan `.sql` files |
| `scripts/validate-repo.mjs` | Repository structure, ADR index, required specs |
| `scripts/lint-repo.mjs` | Static code & security lint across the repo |
| `scripts/migrate.mjs` | Applies pending migrations in journal order to `DATABASE_MIGRATION_URL` / `DATABASE_URL`; `--dry-run` lists them. Records applied migrations in `__stackmate_migrations`. Resolves `pg` through the API package (bare `import("pg")` does not resolve from the repo root under pnpm) |
| `scripts/seed-reference.mjs` | Idempotent reference-data seed (migration 0001) against `DATABASE_MIGRATION_URL` / `DATABASE_URL` |
| `scripts/bootstrap-super-admin.mjs` | Creates the super admin via HTTP POST to a running API (env vars only, never committed credentials) |
| `scripts/smoke-check.mjs` | Boots the real TS API source (Node 24 type stripping) and checks `/api/v1/health` + signing-keys in the test env |
