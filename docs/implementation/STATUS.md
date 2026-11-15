# StackMate Implementation Status — HONEST RECORD

> This file replaced the ZIP's false "Stages 0–10 complete/verified" claim on
> 2026-11-15. Every status below is grounded in a command actually run on
> branch `feat/stackmate-full-implementation` (see "Verification evidence").
> Nothing here claims a pass that was not seen. Per-module labels:
> **verified** (ran and passed) / **implemented-not-verified** (code exists,
> not yet exercised live) / **partial** / **blocked** / **not implemented**.

- **Branch**: `feat/stackmate-full-implementation` (base `429124e`, PR #1 branch)
- **Last verified**: 2026-11-15 (Node v24.22.1, pnpm 10.6.1, local PostgreSQL 16.15 on `127.0.0.1:5432/stackmate_test`)
- **What changed vs the ZIP**: the production store, Better Auth, and the
  verification scripts were broken/fake in the ZIP and have been corrected —
  see `docs/implementation/RECONCILIATION.md`.

## Verification evidence (exact commands, all run 2026-11-15)

| Command | Result |
| :--- | :--- |
| `pnpm install --frozen-lockfile` | PASS (after lockfile regen; `zod@3.24.2` direct dep removed, better-auth peer now `zod@4.6.7`) |
| `pnpm typecheck` (real `tsc --noEmit`, all packages) | PASS |
| `pnpm build` (admin `tsc + vite build`; API `wrangler deploy --dry-run`) | PASS — real vite output in `apps/admin/dist/`; wrangler dry-run validated the Worker bundle with placeholder Hyperdrive IDs (bundle validation only, no deploy) |
| `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test pnpm test` (vitest) | **60/60 pass, 8 files**: DrizzleStore integration 5/5 (commit visibility, rollback, idempotency replay + 409, seed visibility, 93-grant role matrix), SHA-256 vectors 7/7, fail-closed 4/4, e2e (in-memory adapter) 7/7, Better Auth smoke 2/2, **signing keys 6/6** (generate+persist, restart persistence, rotate, revoke, env-JWK import, fail-closed), **Better Auth unified 9/9** (bootstrap provisioning, BA cookie+bearer auth, sign-up blocked, wrong password, lazy migration, suspension, sign-out, password change revokes others, role change revokes sessions), **business workflows 20/20** (Postgres-backed, DB-state assertions: auth+RBAC, product/plan, customer, order, manual payment, concurrent verification race, subscription activation, license issuance/activation/limit, renewal, expiry, suspension/revocation, external-site + HMAC auth, idempotency, outbox/webhooks, Meta Purchase, rollback). Parent re-ran the suite independently 2026-11-15 15:53 +06: first run was 59/60 (business-workflow test 6 failed on a timezone-naive `toISOString` assertion for the DATE column `payment_date` — stored value was correct; fixed in commit `f25f1ad` to compare in Asia/Dhaka), second run **60/60 pass, 8 files**. |
| `pnpm test` (no `DATABASE_URL`) | 20 pass, 40 skipped — all 4 Postgres suites skip cleanly, do not fake-pass |
| `DATABASE_URL=... node scripts/migrate.mjs` (real run, local test Postgres) | PASS — applied 0000–0004; verified `role_permissions` = 93, `sequence_counters` = 5, `signing_keys` holds one active key `sm-ed25519-2026-11` with encrypted private JWK |
| `node scripts/check-migrations.mjs` | PASS — 64 Drizzle tables verified against 5 committed SQL migrations (0000–0004) |
| `node scripts/validate-repo.mjs` | PASS |
| `node scripts/lint-repo.mjs` | PASS — 95 files |
| `node scripts/smoke-check.mjs` | PASS — `/api/v1/health` + `/api/v1/licenses/signing-keys` (test env, in-memory test adapter) |
| `drizzle-kit generate` (temp copy only, out dir `/tmp`) | PASS — generated SQL reproduces the schema except the documented SQL-only items below |
| Worker entrypoint probe (`apps/api/src/index.ts`, raw Node) | PASS — production fetch without Hyperdrive throws `HYPERDRIVE_NO_CACHE binding is required in staging/production.`; test-env fetch returns 200 (`service: "stackmate-api"`) |

## Module status

| Module | Path | Status | Evidence / note |
| :--- | :--- | :--- | :--- |
| Stage 0: ADRs, date & migration safety | `docs/decisions/ADR-0001..0006`, `scripts/validate-repo.mjs` | **Verified** | validate-repo passes; ADR-0004/0002 carry verified correction records |
| Shared contracts, money & date utilities | `packages/contracts` | **Verified** | typecheck + vite build + SHA-256 vectors; browser-safe since the `node:crypto` removal (see Known gaps) |
| Drizzle schema (64 tables) & SQL migrations (0000–0004) | `db/schema/*`, `db/migrations/*` | **Verified** | check-migrations passes; live migrate run applied all 5; `drizzle-kit generate` diff is clean except SQL-only items; migration 0004 adds `signing_keys` (single-active partial unique index, status CHECK) |
| Hyperdrive connector & Drizzle production store | `apps/api/src/platform/db/*` | **Verified** (live Postgres) | commit/rollback/idempotency/seed/grants all pass against real Postgres; advisory-lock transaction semantics; signing keys durable (see Licensing row) |
| Identity, Better Auth, 5-role RBAC & audit | `apps/api/src/modules/identity`, `audit` | **Verified** (live Postgres) | Better Auth is now the single authentication authority: staff sign-in/logout/session validation go through Better Auth sessions (Drizzle `sessions` table); suspended users fail validation even with a live session; sign-out revokes; password change revokes other sessions via the dedicated `revokeOtherSessions` endpoint; lazy migration provisions a credential account once from the legacy scrypt hash (never duplicates, wrong password never provisions); public sign-up blocked (403). Verified behaviours of better-auth 1.7.23 recorded in ADR-0007 §3 (credential `accountId === user.id`; `asResponse` error shape; `changePassword(revokeOtherSessions: true)` revokes ALL sessions; no Bearer session retrieval). Remaining seam (test-only): the in-memory session fallback when a store has no `drizzleDb` — unreachable in production/staging wiring. |
| Catalog, plans, prices, coupons | `apps/api/src/modules/catalog` | **Verified** (live Postgres) | Business-workflow suite 20/20 with DB-state assertions (product/plan creation incl. publish version) |
| Commerce / checkout / orders / attribution | `apps/api/src/modules/commerce`, `integrations` | **Verified** (live Postgres) | Same suite: admin + public-checkout orders, idempotency, HMAC site-to-site auth |
| Manual payments, R2 proofs, fulfillment | `apps/api/src/modules/payments`, `subscriptions` | **Verified** (live Postgres) | Same suite: manual payment submission, concurrent verification race (exactly one 200, one 409), subscription activation/renewal; production R2 fail-closed path is code-verified (503 without a real bucket) but no live R2 bucket exists in this environment |
| Licensing engine (Ed25519 JWS + HMAC-SHA256) | `apps/api/src/modules/licensing` | **Verified** (live Postgres) | Signing keys are durable: `signing_keys` table is the source of truth (AES-256-GCM under `ENCRYPTION_KEY_V1`, AAD per key id); boot loads active + retired keys, imports env JWK once or generates + persists one key; rotation retires + inserts in one transaction; retired keys verify, revoked keys do not; restart persistence proven (token from instance 1 verifies on instance 2). `index.ts` forwards `encryptionSecret` + `appEnv` to the store. See ADR-0007 §1 and the key-rotation runbook. |
| Meta CAPI tracking & transactional outbox | `apps/api/src/modules/tracking`, `webhooks` | **Verified** (live Postgres) | Same suite: outbox rows per event, webhook dispatch claimed/delivered, exactly one Meta Purchase event per verified purchase |
| Admin SPA (React + Vite + TS) | `apps/admin` | **Partial** | Real `vite build` passes and produces `dist/`; login uses the unified Better Auth flow; a working Sign out button was added. **Runtime UI has not been exercised in a browser** in this session; no password-change UI exists (endpoint + tests only). |
| Seed & bootstrap runners | `scripts/seed-reference.mjs`, `scripts/bootstrap-super-admin.mjs` | **Partial** | Seed path verified live via migration 0001 (roles/providers present); `bootstrap-super-admin` (HTTP POST to a running API) has **not** been run against a live server — the bootstrap *route* is verified by the unified-auth test (provisions a Better Auth identity) |
| CI / deploy workflows | `.github/workflows/ci.yml`, `deploy-production.yml`, `deploy-staging.yml` | **Partially verified** | ci.yml + deploy-production.yml are ON the branch (added via GitHub web UI, commits f0c2dab / 0c229c3, blob SHAs verified). **CI run #7 (f0c2dab) FAILED** at the last step (`smoke:check`: Node 22.14.0 cannot import .ts — type stripping needs Node ≥22.18/24); all earlier steps passed. Fix pushed (9660b15): `.nvmrc` 22.14.0 → **24.22.1** (the version all local verification used; Node 24 is current LTS). Re-run result **not yet observed** — do not claim CI green until seen. deploy-staging.yml exists locally (not yet on the branch — workflow files need the web UI). deploy-production.yml has never run (manual-only; production setup incomplete). |
| Staging deployment (Cloudflare + Neon) | `apps/api/wrangler.jsonc` `env.staging`, `.github/workflows/deploy-staging.yml` | **Implemented-not-deployed** | Staging infra EXISTS (verified 2026-11-15, commerciansbd): Neon `staging` branch br-plain-voice-b3vx916o, Hyperdrive stackmate-no-cache (30a29917…) + stackmate-cached (3ae1e99f…), R2 stackmate-private-assets. `wrangler.jsonc` `env.staging` binds them; admin SPA served as Worker static assets (same-origin — relative /api + Better Auth cookies). Workflow: verify → migrations (direct staging URL, production-branch guard) → `wrangler deploy --env staging` → live smoke checks. **Not deployed yet**: staging `staging` environment + secrets (`STAGING_DIRECT_DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, var `STACKMATE_STAGING_API_URL`) and Worker secrets (`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY_V1`, `LICENSE_VERIFIER_SECRET`, `CHECKOUT_TOKEN_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `APP_URL`, `API_URL`) are owner-side setup (see runbook §5.6). |
| Production deployment (Cloudflare) | — | **Not implemented / blocked** | No Cloudflare resources, secrets, or deploy have been touched. First setup + deploy is owner-owned per `AGENTS.md` §9. **Do not claim production readiness.** |

## Known gaps and limitations (do not hide these)

1. **No automatic subscription expiry exists.** Nothing in code transitions a subscription to `expired` — the scheduled handler only processes the outbox, and `subscriptions/service.ts` has no expiry transition. Expiry is enforced only at license-validation time from `expires_at`/`grace_until` (`apps/api/src/modules/licensing/service.ts`, `assertLicenseIsUsable`). A real expiry job/scheduler is still missing.
2. **An expired license's status is never persisted.** `assertLicenseIsUsable` sets `license.status = "expired"` immediately before throwing `LICENSE_EXPIRED`, inside `withTransaction` — so the rollback discards the flip and the DB row still reads `active`. Expiry is re-derived on every validation, never stored.
3. **Public checkout never dedupes customers by email.** `createPublicCheckoutOrder` calls `createCustomerInTx` unconditionally (`apps/api/src/modules/commerce/service.ts:122`), so every website checkout creates a new customer row even for an existing email. (Asserted in the business-workflow suite: 2 customer rows share one email.)
4. **CHECK constraints are SQL-only**: 98 CHECK constraints exist in migration
   0000 and are enforced by Postgres at runtime, but the Drizzle schema does
   not reproduce them — `drizzle-kit generate` will never emit them.
   Same for the 6 immutability triggers + 1 function (SQL-only by nature) and
   the `product_packages.current_version_id` FK (SQL-only to avoid a TS
   circular-reference cycle). See `db/schema/README.md`.
4. **12 tables are never used by any business service**: `payment_refunds`,
   `notifications`, `license_events`, `license_validation_logs`,
   `subscription_events`, `order_adjustments`, `product_releases`,
   `product_distribution_channels`, `product_integration_profiles`,
   `customer_addresses`, `verifications`, `tracking_deliveries`.
   (`accounts` is now used — Better Auth credential rows; `staff_profiles`
   is read for staff status in the DrizzleStore user load.)
5. **`duplicate_risk_Warning` keeps its capital-W typo verbatim** (store ↔ DB
   field name must match; renaming is a separate migration).
6. **No UUID defaults** on either side (schema or SQL): inserts must supply `id`.
7. **`drizzle-kit check` cannot run** — no meta snapshots are committed.
8. **Contracts must stay browser-safe**: `packages/contracts` is bundled into
   the admin SPA, so it must never import `node:*`. The `node:crypto` import
   in `commerce.ts` broke the admin build and was replaced with a
   pure-TypeScript SHA-256 (`packages/contracts/src/common/sha256.ts`),
   verified byte-identical to `node:crypto` by `apps/api/test/sha256-vectors.test.ts`.
9. **Local sandbox quirk (not a product bug)**: this VM blocks `chown` to gid
   65534 (`nogroup`), so `pnpm install` could not rewrite `pnpm-lock.yaml`
   until the lockfile's group was changed to `root:root`. CI runners are
   unaffected. `pnpm install` also prints a non-fatal EPERM for
   `node_modules/.modules.yaml` in this sandbox.
10. **No password-change UI in the admin SPA** (endpoint + tests only).
11. **Not verified in this session**: admin UI in a real browser;
    `bootstrap-super-admin` script against a live server; any GitHub Actions
    run **passing** (run #7 failed — see CI row above; re-run after the
    Node 24 fix not yet observed); any Cloudflare/Wrangler deploy
    (dry-run only). Better Auth end-to-end login against Postgres IS now verified
    (unified-auth suite, 9/9) and the bootstrap *route* is verified too.
