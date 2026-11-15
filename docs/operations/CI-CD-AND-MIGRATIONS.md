# CI/CD and Database Migrations Operations Runbook

## 0. Status — read this first

**No GitHub Actions run has been observed yet.** Neither `ci.yml` nor
`deploy-production.yml` has ever run on GitHub Actions (the Muse GitHub
App has no `workflows:write` permission, so these files could not even
be pushed to the branch by automation — the owner must add them).
Everything below describes what the workflows *will* do once the owner
completes the setup in §5. Do not claim CI or production deployment is
live until a real workflow run plus its smoke checks succeed.

Verified locally 2026-11-15 (not on GitHub Actions): `pnpm run
validate:repo`, `pnpm run db:check` (63 Drizzle tables vs 4 migrations:
0000–0003), `pnpm run lint`, `pnpm test` (25/25 incl. Postgres
integration vs local Postgres 16), `pnpm run typecheck`,
`pnpm run build`, and `wrangler deploy --dry-run` (exits 0 even with
the placeholder Hyperdrive IDs still in `wrangler.jsonc`).

## 1. Core Principles

1. **Forward-Only Expand-Contract Migrations**: Every schema change must be committed as a deterministic SQL migration in `db/migrations/*.sql` tracked in `db/migrations/meta/_journal.json`.
2. **Never run a schema-push/sync command in staging or production** (`ADR-0002`).
3. **Runtime vs. Migration Connection Split (`ADR-0005`)**:
   - **Runtime Worker Traffic**: Always connects through Cloudflare Hyperdrive (`env.HYPERDRIVE_NO_CACHE` and `env.HYPERDRIVE_CACHED`).
   - **Schema Migrations**: Always run in CI/CD prior to Worker deployment using the direct, non-pooled Neon PostgreSQL administrative URL (`DIRECT_DATABASE_URL`) so DDL advisory locks and transactional schema updates are not affected by Hyperdrive transaction pooling.
4. **Migration before deploy, always**: A failed migration blocks all application deployment. Never deploy application code after a failed migration step.

## 2. CI — `.github/workflows/ci.yml`

One job: **`validate-and-test`** (`Validate, typecheck, test (incl.
Postgres integration) and build`), `runs-on: ubuntu-latest`.

- **Triggers:** `pull_request` to `main`; `push` to `main` and `feat/**`.
- **Concurrency:** `group: <workflow>-<ref>`; `cancel-in-progress` is
  `true` for pull requests only — pushes to `main` are never cancelled
  mid-run.
- **Permissions:** `contents: read`. **No secrets, no production
  credential.** The only database is an ephemeral service container.
- **Steps, in order:**
  1. Checkout.
  2. Setup pnpm **10.6.1** (exact version from the `packageManager`
     field in `package.json`).
  3. Setup Node.js from **`.nvmrc` (24.22.1)**, with pnpm cache.
  4. `pnpm install --frozen-lockfile`.
  5. `node scripts/validate-repo.mjs` (also `pnpm run validate:repo`).
  6. `node scripts/check-migrations.mjs` (also `pnpm run db:check`).
  7. `pnpm run lint` (`scripts/lint-repo.mjs`).
  8. `pnpm run typecheck` — real `tsc --noEmit` in every workspace
     package (`scripts/typecheck.mjs` → `pnpm -r run typecheck`).
  9. `pnpm test` — unit tests (`scripts/run-tests.mjs` → `vitest run`).
     With `DATABASE_URL` unset, the DrizzleStore Postgres suite skips
     cleanly and reports the skip; a skip is never presented as a pass.
  10. **Postgres integration tests, NOT skipped** — `pnpm exec vitest
      run apps/api/test/drizzle-store.integration.test.ts` with
      `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stackmate_test`
      pointing at the `postgres:16` service container (health-checked
      with `pg_isready`). The suite applies every journaled migration
      to the fresh database itself before running. The database name
      **must contain `test`**: the suite refuses to apply migrations
      to any other database name.
  11. `pnpm run build` (`scripts/build-all.mjs`: real typecheck, admin
      Vite build, then `wrangler deploy --dry-run` for the API bundle
      with a local esbuild bundle fallback).
  12. `pnpm --filter @stackmate/api exec wrangler deploy --dry-run` —
      explicit API Worker bundle validation; uploads nothing.
  13. `pnpm run smoke:check` — boots the real API in memory (test env)
      and checks `/api/v1/health` and
      `/api/v1/licenses/signing-keys`. This is **not** a check against
      a deployed URL; the deployed-URL check lives in the deploy
      workflow (§3).

Known skew: CI uses `postgres:16` (matches local verification);
production Neon is Postgres 18. Acceptable for integration tests;
flag it if version-specific SQL ever appears.

## 3. Production deployment — `.github/workflows/deploy-production.yml`

**Manual only** (`workflow_dispatch`, no push trigger). Four jobs, in
strict order; each production-touching job references
`environment: production` (approval protection — see §5).

| Job | Needs | Environment | What it does |
| --- | --- | --- | --- |
| `verify` — Pre-Deployment Verification Gate | — | *(none)* | Fails fast unless the `confirm` input is exactly `production`; then `validate:repo`, `db:check`, `lint`, `typecheck`, `pnpm test` (unit tests only — no `DATABASE_URL`, integration suite runs in CI), `build`. |
| `migrate-db` — Apply Forward-Only PostgreSQL Migrations (Direct Neon URL) | `verify` | `production` | Guards `DIRECT_DATABASE_URL` (fails if unset or if it looks like a Hyperdrive URL); `db:check`; then `pnpm run db:migrate:deploy` (`node scripts/migrate.mjs --deploy`: advisory-locked, checksum-verified, transactional per migration; reads `DATABASE_MIGRATION_URL`, then `DATABASE_URL`). No destructive down-migrations exist. |
| `deploy-api` — Deploy Cloudflare Worker API (Hyperdrive + R2) | `migrate-db` | `production` | Fails if `apps/api/wrangler.jsonc` still contains `REPLACE_WITH_*` placeholder Hyperdrive IDs; `pnpm run build`; `pnpm --filter @stackmate/api run deploy` (`wrangler deploy --minify`, Worker name `stackmate-api`); live smoke check `curl -fsS ${STACKMATE_API_URL}/api/v1/health`. |
| `deploy-admin` — Deploy Admin SPA | `deploy-api` | `production` | `pnpm --filter @stackmate/admin run build`; `pnpm --filter @stackmate/api exec wrangler pages deploy ../../apps/admin/dist --project-name stackmate-admin` (see note below); live smoke check `curl -fsS ${STACKMATE_ADMIN_URL}`. |

Why the admin deploy goes through `@stackmate/api`'s wrangler:
`wrangler` is a devDependency of `@stackmate/api` only.
`@stackmate/admin` has no wrangler binary, so its own `deploy`
script fails with `Command "wrangler" not found` (verified locally).
The `../../apps/admin/dist` path is relative to `apps/api`, where
`pnpm --filter @stackmate/api exec` runs. The Pages project name
`stackmate-admin` is the name declared in `apps/admin/package.json`,
not an invented name.

**There is no staging deploy path.** No staging Cloudflare resources
and no staging Neon branch/database exist (verified 2026-11-15).
Staging needs its own Neon branch/database (never the production
branch), plus its own environment/secrets/vars — document those first,
then add the workflow; do not invent resource names.

**Known gap — admin ↔ API routing in production:** the admin SPA
calls relative `/api/v1/...` paths (`apps/admin/src/lib/api-client.ts`)
and consumes no build-time API URL variable. There is therefore no
`VITE_API_URL` (or similar) build variable in the deploy workflow —
none exists to set. How the deployed admin reaches the deployed API
(same-domain routing, proxy, or an absolute URL) is still undecided;
do not invent it here.

## 4. Rollback & Recovery Procedure

- **Application Rollback**: If a newly deployed Worker or Admin SPA exhibits errors, roll back the Cloudflare Worker deployment immediately. Because all migrations follow the **expand-contract** pattern, the previous Worker version remains compatible with the expanded schema.
- **Database Recovery**: Never run destructive down-migrations on production financial, order, subscription, or license tables. Write a forward corrective migration or restore from the pre-deployment Neon branch snapshot.

## 5. Owner setup — required before the first deploy

All of this is owner action (Cloudflare/Neon accounts are the owner's;
use the **commerciansbd** account, not a personal account). Nothing
below is a secret to commit — secrets/vars live in GitHub Settings
only.

### 5.1 Cloudflare (dashboard, commerciansbd account)

Verified 2026-11-15: the account currently has **no** `stackmate-api`
Worker, **no** Hyperdrive configs at all, and **no** R2 bucket
`stackmate-private-assets` — all of these must be created.

1. Create two Hyperdrive configs pointing at the production Neon
   database (direct Neon host; see §5.2):
   - `HYPERDRIVE_NO_CACHE` — caching disabled (auth, sessions, RBAC,
     orders, manual payment verification, subscriptions, licenses,
     outbox writes/reads).
   - `HYPERDRIVE_CACHED` — query caching enabled (`max_age=60s`,
     `swr=15s`) strictly for staleness-tolerant public catalog reads
     and historical analytics summaries.
2. Replace the `REPLACE_WITH_PRODUCTION_HYPERDRIVE_*_ID` placeholders
   in `apps/api/wrangler.jsonc` with the real Hyperdrive config IDs
   (the deploy workflow fails closed while placeholders remain).
3. Create the R2 bucket `stackmate-private-assets` (plus its preview
   bucket `stackmate-private-assets-preview`, as declared in
   `wrangler.jsonc`).
4. The Worker `stackmate-api` and the Pages project `stackmate-admin`
   are created by the first successful `wrangler deploy` /
   `wrangler pages deploy` runs; verify they exist after the first
   deploy.

### 5.2 Neon (Commercians org)

Verified 2026-11-15: a StackMate project exists
(`frosty-surf-68878874`, AWS `ap-southeast-1` Singapore, Free,
Postgres 18, created 2026-11-15) with **only** a `production` default
branch (`br-soft-brook-b3v47kp6`) and the `neondb` database — no
staging/test branch or database yet. Staging must use a **separate**
Neon branch/database, never the production branch.

- `DIRECT_DATABASE_URL` = the **direct (non-pooled)** connection
  string for the production branch/database. Never the pooled
  (`-pooler`) host, never a Hyperdrive URL.

### 5.3 GitHub — repo Settings → Environments → `production`

1. Create the environment named **`production`**.
2. Under **Required reviewers**, add the owner (and any approver).
   Each of the `migrate-db`, `deploy-api`, and `deploy-admin` jobs
   requests approval against this environment.
3. Add these **environment secrets** (Settings → Environments →
   `production` → Secrets):
   - `DIRECT_DATABASE_URL` — direct non-pooled Neon production
     connection string (§5.2). Migrations only; never used by the
     Worker at runtime.
   - `CLOUDFLARE_API_TOKEN` — API token with minimum required
     permissions (Workers + Pages deploy for this account).
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.
4. Add these **environment variables** (same page → Variables):
   - `STACKMATE_API_URL` — deployed API base URL, e.g.
     `https://stackmate-api.<subdomain>.workers.dev` (no trailing
     slash). Used by the live API smoke check.
   - `STACKMATE_ADMIN_URL` — deployed Admin base URL, e.g.
     `https://stackmate-admin.pages.dev` (no trailing slash). Used by
     the live Admin smoke check.
5. Optional but recommended: repo Settings → Branches → protect
   `main` with the CI `validate-and-test` job as a required check.

### 5.4 First deploy

1. Add the workflow files to the repo (see §0 — automation cannot
   push `.github/workflows/*` files itself).
2. Confirm CI is green on the branch/PR.
3. Actions → **Deploy Production** → Run workflow → type
   `production` in the `confirm` input → approve each `production`
   environment prompt.
4. Verify: migrations applied, Worker and Pages deploys succeeded,
   and both live smoke checks passed. The deploy is complete only
   then.
