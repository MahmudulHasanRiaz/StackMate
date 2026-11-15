# StackMate — Engineering Implementation Plan & Conflict Resolution Record

## 1. Repository & PR #1 Reconciliation Summary

- **Base Repository**: `https://github.com/MahmudulHasanRiaz/StackMate` (`main` at commit `d056892`).
- **Open Pull Request #1**: `https://github.com/MahmudulHasanRiaz/StackMate/pull/1` (`chore/stage-0-deploy-safety-foundation` at commit `429124e`, 20 commits, 16 files changed).
- **Reconciliation Action**: All 16 files from PR #1 (`ADR-0001` through `ADR-0004`, `docs/operations/CI-CD-AND-MIGRATIONS.md`, `scripts/validate-repo.mjs`, `.github/workflows/ci.yml`, `.github/workflows/deploy-production.yml`, and governance updates) were preserved intact and extended with `ADR-0005` (Cloudflare Hyperdrive + `node-postgres` + Drizzle ORM) and `ADR-0006` (Better Auth, RBAC, Ed25519 licensing, HMAC-SHA256, and AES-256-GCM envelope encryption).

## 2. Authoritative Conflict & Decision Resolutions (`C-01`–`C-09`, `D-01`–`D-05`)

| ID | Topic | Resolution | Governing ADR / Module |
| :--- | :--- | :--- | :--- |
| `C-01` | API Route Prefix & Auth Mounting | All business APIs under `/api/v1/*`; authentication mounted under `/api/auth/*` | `ADR-0003`, `apps/api/src/app.ts` |
| `C-02` | JSON Field Naming Convention | `snake_case` across all API request/response payloads and DB columns | `ADR-0003`, `@stackmate/contracts` |
| `C-03` | Multi-Item Order Snapshot Grain | Commercial and entitlement snapshots stored on `order_items` (`product_type_snapshot`, `entitlement_policy_snapshot`) | `ADR-0003`, `db/schema/commerce.ts` |
| `C-04` | Payment Provider vs. Method vs. Transfer Rail | Normalized 3-tier hierarchy: `payment_providers`, `payment_methods`, `payment_method_transfer_rails` | `ADR-0003`, `db/schema/payments.ts` |
| `C-05` | Currency Minor-Unit Storage | All monetary values stored in integer minor units (`BIGINT`); `BDT` uses exponent `2` (poisha) | `ADR-0003`, `packages/contracts/src/money.ts` |
| `C-06` | Date Display vs. Wire Format | `DD/MM/YYYY` (`Asia/Dhaka` default) for UI/human inputs; ISO 8601 UTC (`TIMESTAMPTZ`) for API wire & DB storage | `ADR-0001`, `packages/contracts/src/dates.ts` |
| `C-07` | Database Migration Strategy | Expand-contract forward-only SQL migrations (`db/migrations/*.sql`) via `DIRECT_DATABASE_URL`; `drizzle-kit push` forbidden in production | `ADR-0002`, `scripts/migrate.mjs` |
| `C-08` | Hyperdrive Driver & Caching Split | `drizzle-orm/node-postgres` + `pg >= 8.16.3`; dual Hyperdrive bindings (`HYPERDRIVE_NO_CACHE` vs. `HYPERDRIVE_CACHED`) | `ADR-0005`, `apps/api/src/platform/db/hyperdrive.ts` |
| `C-09` | Async Reliability Without Extra Cloudflare Primitives | PostgreSQL-backed transactional outbox (`outbox_events`) with lease locking (`FOR UPDATE SKIP LOCKED`), exponential backoff, and dead-letter state | `ADR-0005`, `apps/api/src/modules/webhooks/service.ts` |
| `D-01` | Initial Currency Policy | `BDT` (`poisha`, exponent `2`) default + multi-currency `currencies` registry (`USD`, `EUR`, `GBP`, `INR`) | `db/migrations/0001_seed_reference_catalog.sql` |
| `D-02` | WordPress Staging/Local Seat Counting | Policy-driven per product/plan via `count_staging_activations` (`false` by default so staging/local (`*.staging.*`, `localhost`, `*.test`, `*.local`) do not consume production seats unless enabled) | `apps/api/src/modules/licensing/service.ts` |
| `D-03` | Partial Payment Submissions | Disabled initially (`submitted_amount_minor` must match `order.total_minor`); data model supports multi-submission history per order | `apps/api/src/modules/payments/service.ts` |
| `D-04` | License Offline Grace Window | Default `7 days` (`offline_grace_days = 7`) encoded in signed `Ed25519` JWS token `grace_until` claim | `apps/api/src/modules/licensing/service.ts` |
| `D-05` | Multi-Factor Authentication (MFA) | Schema-ready (`users.mfa_enabled`, `user_mfa_factors`) with session assurance checks and RBAC enforcement across 5 system roles | `db/schema/identity.ts`, `apps/api/src/modules/identity/service.ts` |

## 3. Phase 2 — critical fixes + deployment readiness (2026-11-15)

Same branch (`feat/stackmate-full-implementation`), local commits only.
Staged tasks, in dependency order; all four landed and verified (see
`STATUS.md` for exact commands and `RECONCILIATION.md` §8 for the
per-fix record).

| # | Task | Depends on | Affected paths | Acceptance criteria (all met) |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Durable license signing keys | — | `db/migrations/0004_signing_keys.sql`, `db/schema/signing-keys.ts`, `apps/api/src/platform/db/drizzle-store.ts`, `store.ts`, `platform/crypto/index.ts`, `apps/api/src/index.ts`, `docs/operations/KEY-ROTATION-AND-SECURITY-RUNBOOK.md` | `signing_keys` is the source of truth; restart persistence proven; rotation keeps old tokens verifiable; revoked keys reject; fail-closed on missing/undecryptable secret. Test: `signing-keys.test.ts` 6/6. |
| 2 | Unify Better Auth + staff auth | — | `apps/api/src/modules/identity/better-auth.ts`, `service.ts`, `apps/api/src/app.ts`, `apps/admin/src/App.tsx` | One session authority (BA `sessions` table); suspended users fail; logout revokes; password change revokes other sessions; lazy migration never duplicates, wrong password never provisions; public sign-up blocked. Test: `better-auth-unified.test.ts` 9/9. Governing record: ADR-0007. |
| 3 | Postgres business-workflow tests | 1, 2 | `apps/api/test/business-workflows.integration.test.ts` only | 17 workflows + concurrency + rollback, all with DB-state assertions against real Postgres. Test: 20/20. Three real gaps found and recorded in STATUS.md (no expiry job; expired status never persisted; checkout customer dedupe). |
| 4 | CI + deploy workflow content | — | `.github/workflows/ci.yml`, `deploy-production.yml`, `docs/operations/CI-CD-AND-MIGRATIONS.md` | CI runs the full gate incl. Postgres integration tests; deploy is approval-gated, migrations-before-app via direct `DIRECT_DATABASE_URL`. YAML parses. **Not verified live**: no GitHub Actions run has been observed; the Muse GitHub App cannot push workflow files (403) — owner action. |

Risks carried forward: production deployment still owner-owned (no
Cloudflare resources touched); admin SPA never exercised in a browser;
no password-change UI in the admin SPA; the three Fix 3 findings above
are unfixed by design in this phase (recorded, not hidden).
