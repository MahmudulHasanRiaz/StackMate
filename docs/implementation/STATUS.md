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
| `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test pnpm test` (vitest) | **25/25 pass**: DrizzleStore integration 5/5 (commit visibility, rollback, idempotency replay + 409, seed visibility, 93-grant role matrix), SHA-256 vectors 7/7, fail-closed 4/4, e2e (in-memory adapter) 7/7, Better Auth smoke 2/2 |
| `pnpm test` (no `DATABASE_URL`) | 20 pass, 5 skipped — integration suite skips cleanly, does not fake-pass |
| `DATABASE_URL=... node scripts/migrate.mjs` (real run, local test Postgres) | PASS — applied 0000–0003; verified `role_permissions` = 93, `sequence_counters` = 5 |
| `node scripts/check-migrations.mjs` | PASS — 63 Drizzle tables verified against 4 committed SQL migrations (0000–0003) |
| `node scripts/validate-repo.mjs` | PASS |
| `node scripts/lint-repo.mjs` | PASS — 90 files |
| `node scripts/smoke-check.mjs` | PASS — `/api/v1/health` + `/api/v1/licenses/signing-keys` (test env, in-memory test adapter) |
| `drizzle-kit generate` (temp copy only, out dir `/tmp`) | PASS — generated SQL reproduces the schema except the documented SQL-only items below |
| Worker entrypoint probe (`apps/api/src/index.ts`, raw Node) | PASS — production fetch without Hyperdrive throws `HYPERDRIVE_NO_CACHE binding is required in staging/production.`; test-env fetch returns 200 (`service: "stackmate-api"`) |

## Module status

| Module | Path | Status | Evidence / note |
| :--- | :--- | :--- | :--- |
| Stage 0: ADRs, date & migration safety | `docs/decisions/ADR-0001..0006`, `scripts/validate-repo.mjs` | **Verified** | validate-repo passes; ADR-0004/0002 carry verified correction records |
| Shared contracts, money & date utilities | `packages/contracts` | **Verified** | typecheck + vite build + SHA-256 vectors; browser-safe since the `node:crypto` removal (see Known gaps) |
| Drizzle schema (63 tables) & SQL migrations (0000–0003) | `db/schema/*`, `db/migrations/*` | **Verified** | check-migrations passes; live migrate run applied all 4; `drizzle-kit generate` diff is clean except SQL-only items |
| Hyperdrive connector & Drizzle production store | `apps/api/src/platform/db/*` | **Verified** (live Postgres) | commit/rollback/idempotency/seed/grants all pass against real Postgres; advisory-lock transaction semantics |
| Identity, Better Auth, 5-role RBAC & audit | `apps/api/src/modules/identity`, `audit` | **Partial** | Genuine `betterAuth()` + `drizzleAdapter(pg)` mounted at `/api/auth/*`; `GET /api/auth/ok` returns a real Better Auth response; e2e RBAC tests pass on the in-memory adapter. **Not unified**: staff sessions live in the store `sessions` state, Better Auth sessions in the Drizzle `sessions` table — the seam is documented in `app.ts` and NOT faked. Full session parity is not verified. |
| Catalog, plans, prices, coupons | `apps/api/src/modules/catalog` | **Implemented-not-verified** (live DB) | Exercised only by the in-memory e2e suite |
| Commerce / checkout / orders / attribution | `apps/api/src/modules/commerce`, `integrations` | **Implemented-not-verified** (live DB) | Same — in-memory e2e only |
| Manual payments, R2 proofs, fulfillment | `apps/api/src/modules/payments`, `subscriptions` | **Implemented-not-verified** (live DB) | Same; production R2 fail-closed path is code-verified (503 without a real bucket) but no live R2 bucket exists in this environment |
| Licensing engine (Ed25519 JWS + HMAC-SHA256) | `apps/api/src/modules/licensing` | **Implemented-not-verified** (live DB) | Same; signing-key durability gap below |
| Meta CAPI tracking & transactional outbox | `apps/api/src/modules/tracking`, `webhooks` | **Implemented-not-verified** (live DB) | Same |
| Admin SPA (React + Vite + TS) | `apps/admin` | **Partial** | Real `vite build` passes and produces `dist/`; **runtime UI has not been exercised in a browser** in this session |
| Seed & bootstrap runners | `scripts/seed-reference.mjs`, `scripts/bootstrap-super-admin.mjs` | **Partial** | Seed path verified live via migration 0001 (roles/providers present); `bootstrap-super-admin` (HTTP POST to a running API) has **not** been run against a live server |
| CI / deploy workflows | `.github/workflows/ci.yml`, `deploy-production.yml` | **Implemented-not-verified** | Fixed (pnpm + frozen lockfile; migrate-before-deploy actually applies migrations; deploy jobs run `wrangler deploy`; manual-only preserved). **No GitHub Actions run has been observed in this session.** |
| Production deployment (Cloudflare) | — | **Not implemented / blocked** | No Cloudflare resources, secrets, or deploy have been touched. First setup + deploy is owner-owned per `AGENTS.md` §9. **Do not claim production readiness.** |

## Known gaps and limitations (do not hide these)

1. **Signing-key private material is per-process** unless `LICENSE_SIGNING_PRIVATE_JWK`
   is supplied: there is no durable key store. `signing_key_metadata` holds
   public JWKs only; `rotateSigningKey` is in-memory only. Needs a
   `signing_keys` table or KMS before production.
2. **Staff sessions vs Better Auth sessions are NOT unified** (see Identity row).
3. **CHECK constraints are SQL-only**: 98 CHECK constraints exist in migration
   0000 and are enforced by Postgres at runtime, but the Drizzle schema does
   not reproduce them — `drizzle-kit generate` will never emit them.
   Same for the 6 immutability triggers + 1 function (SQL-only by nature) and
   the `product_packages.current_version_id` FK (SQL-only to avoid a TS
   circular-reference cycle). See `db/schema/README.md`.
4. **14 tables are never used by any service**: `payment_refunds`,
   `notifications`, `license_events`, `license_validation_logs`,
   `subscription_events`, `order_adjustments`, `product_releases`,
   `product_distribution_channels`, `product_integration_profiles`,
   `customer_addresses`, `accounts`, `verifications`, `staff_profiles`,
   `tracking_deliveries`.
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
10. **Not verified in this session**: admin UI in a real browser; Better Auth
    end-to-end login flow against Postgres; `bootstrap-super-admin` against a
    live server; any GitHub Actions run; any Cloudflare/Wrangler deploy
    (dry-run only, placeholder Hyperdrive IDs).
