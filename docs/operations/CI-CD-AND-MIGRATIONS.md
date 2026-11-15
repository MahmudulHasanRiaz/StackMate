# CI/CD and Database Migrations Operations Runbook

## 0. Status — read this first

**CI is green** (run #20, commit `16b5b59`, 2026-11-15 ~16:29 +06,
1m 8s — all steps passed; runs #11–#20 all passed). The first
smoke-check failure (run #7, Node 22.14.0 cannot import `.ts`) was
fixed by `.nvmrc` → 24.22.1 (commit `9660b15`).
`deploy-production.yml` has never run (manual-only, and production
setup in §5 is not complete).

**Staging deploy is by direct Cloudflare Git connection, not by
Actions.** A dedicated `staging` branch (created from feat head
`16b5b59`, 2026-11-15) is tracked by Worker
`stackmate-api-staging` at
`https://stackmate-api-staging.ad-dawah.workers.dev` (production
branch = `staging`, auto-deploy on push; build command `pnpm
install --frozen-lockfile && pnpm run db:migrate:deploy && pnpm run
build`, deploy command `npx wrangler deploy --env staging --config
apps/api/wrangler.jsonc`, Node 24.22.1, `DATABASE_MIGRATION_URL`
build secret = direct staging Neon URL). `deploy-staging.yml` is
kept as the manual Actions alternative; it is not on `main`, so the
Actions UI shows "Workflow does not exist" — that is expected, not
an error. GitHub `staging` environment secrets were verified present
2026-11-15 16:44 (`STAGING_DIRECT_DATABASE_URL`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). The first staging
build is triggered by a push to the `staging` branch; Worker runtime
secrets + `STACKMATE_STAGING_API_URL` (§5.6) are set after the
Worker URL is known, then a redeploy is triggered. Staging has
**not** served live traffic yet.

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

**Staging deploy path — `.github/workflows/deploy-staging.yml`**
(see §3.5).** The production workflow still has no staging path, by
design: staging is a separate workflow with its own `staging`
environment, its own Neon branch, and its own Hyperdrive bindings.

**Admin ↔ API routing — DECIDED for staging, still open for
production:** the admin SPA calls relative `/api/v1/...` paths
(`apps/admin/src/lib/api-client.ts`) and consumes no build-time API
URL variable. There is therefore no `VITE_API_URL` (or similar) build
variable in either deploy workflow — none exists to set. For
**staging**, the admin SPA is served as static assets from the same
Worker (`apps/api/wrangler.jsonc` `env.staging.assets`, directory
`../../apps/admin/dist`, SPA fallback), so relative calls and Better
Auth cookies stay same-origin. For **production**, how the deployed
admin reaches the deployed API (same-domain routing, proxy, or an
absolute URL) is still undecided; do not invent it here.

### 3.5 Staging deployment — direct Cloudflare Git connection (current path)

The staging Worker is connected directly to the GitHub repo in the
Cloudflare dashboard (no PAT, no Actions trigger): repository
`MahmudulHasanRiaz/StackMate`, dedicated branch `staging` (created
from feat head `16b5b59`; `main` untouched), production branch =
`staging`, auto-deploy on push. Build command: `pnpm install
--frozen-lockfile && pnpm run db:migrate:deploy && pnpm run build`
(migrations run before the app builds, against the direct staging
Neon URL from the `DATABASE_MIGRATION_URL` build secret).
Deploy command: `npx wrangler deploy --env staging --config
apps/api/wrangler.jsonc`. Worker URL:
`https://stackmate-api-staging.ad-dawah.workers.dev`.

`.github/workflows/deploy-staging.yml` below is the manual Actions
alternative (kept for a future API-triggered run); it is not the
current path.

**Manual only** (`workflow_dispatch`, no push trigger). Three jobs, in
strict order; the staging-touching jobs reference
`environment: staging` (approval protection — see §5.6).

| Job | Needs | Environment | What it does |
| --- | --- | --- | --- |
| `verify` — Pre-Deployment Verification Gate | — | *(none)* | Fails fast unless the `confirm` input is exactly `staging`; then `validate:repo`, `db:check`, `lint`, `typecheck`, `pnpm test` (unit tests only), `build`. |
| `migrate-staging` — Apply Forward-Only PostgreSQL Migrations (Direct Staging Neon URL) | `verify` | `staging` | Guards `STAGING_DIRECT_DATABASE_URL` (fails if unset, if it looks like a Hyperdrive URL, or if it points at the **production** branch `br-soft-brook-b3v47kp6`); `db:check`; then `pnpm run db:migrate:deploy` against the staging branch. |
| `deploy-api-staging` — Deploy Cloudflare Worker API (staging env) + Admin SPA assets | `migrate-staging` | `staging` | `pnpm run build`; `wrangler deploy --env staging` (Worker `stackmate-api-staging`, staging Hyperdrive + R2, admin SPA as static assets); live smoke checks `curl -fsS ${STACKMATE_STAGING_API_URL}/api/v1/health` and `curl -fsS ${STACKMATE_STAGING_API_URL}`. |

Staging resources (verified 2026-11-15, commerciansbd account):
Neon StackMate project `frosty-surf-68878874`, branch `staging`
`br-plain-voice-b3vx916o` (child of production, auto-delete Never),
own `neondb` on pooled host
`ep-round-queen-b3nfs18o-pooler.c-4.ap-southeast-1.aws.neon.tech`
(port 5432, user `neondb_owner`); Hyperdrive `stackmate-no-cache`
`30a29917780c4aff91b9a198b63eb387` (caching disabled) and
`stackmate-cached` `3ae1e99fbd6d4fcea9a0cb35de71ae4c` (max_age 60s, swr
15s), both pointing at the staging `neondb`; R2 bucket
`stackmate-private-assets` (Standard, Asia Pacific, Public Access
Disabled). The production branch (`br-soft-brook-b3v47kp6`) is
untouched and must never be used for staging.

## 4. Rollback & Recovery Procedure

- **Application Rollback**: If a newly deployed Worker or Admin SPA exhibits errors, roll back the Cloudflare Worker deployment immediately. Because all migrations follow the **expand-contract** pattern, the previous Worker version remains compatible with the expanded schema.
- **Database Recovery**: Never run destructive down-migrations on production financial, order, subscription, or license tables. Write a forward corrective migration or restore from the pre-deployment Neon branch snapshot.

## 5. Owner setup — required before the first deploy

All of this is owner action (Cloudflare/Neon accounts are the owner's;
use the **commerciansbd** account, not a personal account). Nothing
below is a secret to commit — secrets/vars live in GitHub Settings
only.

### 5.1 Cloudflare (dashboard, commerciansbd account)

Verified 2026-11-15: the account currently has **no production**
`stackmate-api` Worker, **no production** Hyperdrive configs, and the
R2 bucket `stackmate-private-assets` exists only because it was
created for **staging** (§3.5) — production Hyperdrive configs still
do not exist and must be created.

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

### 5.6 Staging setup — required before the first staging deploy

Staging infrastructure (§3.5) already exists. What remains is
owner-side (dashboard / GitHub Settings) setup:

1. **Worker secrets** (Cloudflare dashboard → Workers & Pages →
   `stackmate-api-staging` → Settings → Variables → Secrets; values
   are generated in the dashboard and never written here or in chat):
   `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY_V1`,
   `LICENSE_VERIFIER_SECRET`, `CHECKOUT_TOKEN_SECRET`. The first
   `wrangler deploy --env staging` run creates the Worker; the URL
   secrets below can only be set after the Worker URL is known, so
   expect **two passes**: deploy once, set the URL secrets, re-run
   the workflow.
2. **Worker URL variables** (same page, plain variables, not
   secrets): `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `APP_URL`,
   `API_URL` — all equal to the deployed staging Worker URL, e.g.
   `https://stackmate-api-staging.<subdomain>.workers.dev` (no
   trailing slash). `TRUSTED_ORIGINS` is a comma-separated list;
   for staging it is just the Worker URL itself (admin is
   same-origin).
3. **GitHub — repo Settings → Environments → `staging`**: create
   the environment, add the owner as a required reviewer.
4. **Staging environment secrets** (same page → Secrets):
   - `STAGING_DIRECT_DATABASE_URL` — **direct (non-pooled)**
     connection string for the **staging** Neon branch
     (`br-plain-voice-b3vx916o`). Never the pooled (`-pooler`)
     host, never a Hyperdrive URL, never the production branch.
   - `CLOUDFLARE_API_TOKEN` — API token with minimum required
     permissions (Workers deploy for this account).
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID
     (`4b86a3e96cec5a2f9f841c7a3cbbb5cf`).
5. **Staging environment variables** (same page → Variables):
   - `STACKMATE_STAGING_API_URL` — deployed staging API base URL,
     e.g. `https://stackmate-api-staging.<subdomain>.workers.dev`
     (no trailing slash). Used by the live smoke checks.
6. **First staging deploy (current path — direct Cloudflare Git
   connection)**: push to the `staging` branch; Cloudflare
   auto-builds (migrations → build → deploy). Then set the Worker
   URL secrets (§5.6 steps 1–2 — the Worker URL is
   `https://stackmate-api-staging.ad-dawah.workers.dev`) and trigger
   a redeploy from the Cloudflare dashboard. Verify: migrations
   0000–0004 applied to the staging branch, Worker deploy succeeded,
   and both live smoke checks passed (`/api/v1/health` and `/`). The
   deploy is complete only then. (The Actions alternative:
   Actions → **Deploy Staging** → Run workflow → type `staging` in
   the `confirm` input → approve the `staging` environment prompt —
   but the workflow file is not on `main`, so it can only be
   triggered via API dispatch for ref `staging`, not from the UI.)
