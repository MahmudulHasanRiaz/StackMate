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

## 4. Account widget + Neon gaps + Settings shell fix (2026-11-15, uncommitted)

Owner decisions 2026-11-15 ~23:49–23:56: (1) Settings shell must keep
the main menu visible as a COLLAPSED icon rail (collapse ≠ hide) with
a collapse/expand toggle; (2) account widget = proper dropdown menu
(theme System/Dark/Light inside it, own profile name update, password
change UI); (3) Neon styling gaps closed from the screenshot audit;
(4) font = Inter (Neon's font, verified from live neon.com captures),
self-hosted; icons = Lucide stays. The nav restructure (Tracking /
Webhooks / Websites / Payment Methods → Settings or Administration)
was confirmed separately (~00:00 +06) and is sequenced as the NEXT
batch — NOT this one; no nav items move here.

| # | Task | Affected paths | Acceptance criteria |
| :--- | :--- | :--- | :--- |
| 1 | Neon gap audit | `~/workspace/stackmate-work/neon-gap-audit.md` | Screenshot vs code compared gap by gap (active nav, table headers, density, background, banners, topbar search, sidebar collapse, right rail, fonts, icons); each gap marked fix / not-implemented / not-applicable with a reason |
| 2 | Neon styling fixes (token-based only) | `apps/admin/src/styles/tokens.css`, `apps/admin/index.html` | Active nav = white text on subtle bg; table headers non-uppercase, no bg block (conflict with spec §3.3 recorded in audit + spec §9.1); cell padding 12→10px; pure-black bg `#000`, surfaces `#101010`; alerts = bordered panels (new `--sm-*-border` tokens); Inter self-hosted (`@fontsource-variable/inter` 5.3.0, `public/fonts/inter/InterVariable.woff2` + OFL.txt, `--sm-font-sans` starts with `"Inter"`); vite build emits the font in `dist/fonts/inter/` |
| 3 | Theme 3-way | `apps/admin/src/lib/theme.ts`, `apps/admin/index.html`, `apps/admin/src/main.tsx` | `sm-theme` = `"system" \| "dark" \| "light"`, default `"dark"`; system follows `prefers-color-scheme` with a live matchMedia listener; index.html bootstrap handles all three values with no flash |
| 4 | Account menu | `apps/admin/src/components/primitives.tsx` (Menu + Avatar), `apps/admin/src/components/shell.tsx` | One account button (avatar initials + name + chevron) → dropdown (header, Theme System/Dark/Light radios with check, Profile, Change password, Settings link, Sign out danger); closes on outside click + Esc, arrow-key navigable, focus ring per tokens; theme choice lives here ONLY (standalone topbar toggle removed) |
| 5 | Profile name update | `apps/api/src/modules/identity/service.ts` (`updateOwnProfile`), `apps/api/src/app.ts` (PATCH `/api/v1/admin/me`), `apps/api/test/better-auth-unified.test.ts` | Better Auth POST `/api/auth/update-user` VERIFIED through the real API (updates shared `users.name`, GET /me reflects it) but writes no audit log and returns a non-envelope shape — so the supported path is PATCH `/api/v1/admin/me` (name only, envelope, audit-logged `identity.profile.name_updated`, returns updated principal); email/roles in the body ignored; 422 on empty/>120 chars; 401 unauthenticated |
| 6 | Change-password UI | `apps/admin/src/components/shell.tsx` (PasswordDialog) | POST `/api/auth/change-password` `{current_password, new_password}`; ≥10 chars + confirm match client-side; wrong current password shows the 401 message; success toast notes other sessions were signed out |
| 7 | QuickNav (⌘K) | `apps/admin/src/components/shell.tsx`, `apps/admin/src/styles/tokens.css` | Search-style topbar button + `⌘K`/`Ctrl+K` opens a filter dialog over the 15 sections + Settings + 3 action shortcuts; arrows + Enter navigate, Esc closes; navigation only (no record search, no create dialogs) |
| 8 | Settings shell fix | `apps/admin/src/components/shell.tsx`, `apps/admin/src/styles/tokens.css` | SettingsShell renders main nav as 64px rail + Settings nav expanded (grid 64px 240px 1fr); "Collapse menu" button at sidebar bottom toggles rail/expanded, persisted (`sm-nav-collapsed`), same state in both shells; <900px main rail hidden, settings nav is the drawer |
| 9 | Verification | — | `tsc --noEmit` api + admin; admin vite build; lint-repo; full vitest (must stay green); wrangler dry-run staging; jsdom smoke mount of the shell (account menu open/close, theme switch System/Dark/Light, collapse toggle) under `~/workspace/stackmate-work/spa-repro/` |
| 10 | Neon pattern rules (owner follow-up 2026-11-16 ~00:10) | `apps/admin/src/styles/tokens.css`, `apps/admin/src/components/shell.tsx` | Radius cap 6px (dialogs 8px max; `--sm-radius-lg: 6px`, `--sm-radius-xl: 8px`); pills stay 999px; compact heights (topbar 48px, nav 6px 10px/13px, inputs 32px, buttons 30px/26px, content 20px, sidebar 12px, card 16px, KPI 12px 16px, dialog 16px); 1px dividers between nav groups; pattern discipline on EVERY surface; 2px micro-values listed as named exceptions in the audit |
| 11 | Screenshot 2 patterns (owner follow-up 2026-11-16 ~00:11, image-76) | `apps/admin/src/lib/section-kit.tsx`, `apps/admin/src/components/primitives.tsx` (`RowMenu`), `apps/admin/src/sections/webhooks.tsx`, `apps/admin/src/sections/integrations.tsx`, `apps/admin/src/styles/tokens.css` | PageHeader: 24px bold title first, breadcrumb under it; ListTable: full-width search under the breadcrumb; table headers white semibold 600 (supersedes muted); badges are pills; `RowMenu` ("…" per row, portaled/fixed, ~32px rows, flips up, Esc/outside/scroll close, arrow keys) on the 3 tables with 2+ row actions (webhooks endpoints, credentials, domains); single-action tables keep inline buttons; white-primary is a DECISION POINT — NOT applied (green primary stays until the owner decides) |
| 12 | Re-verification after pattern pass | — | Full `verify-batch1.sh` green again (vitest 96/96 incl. the 2 new better-auth tests); jsdom smoke re-run incl. a RowMenu check on /webhooks with stubbed data; vite build + lint + wrangler dry-run pass |

Risks: table-header change deliberately diverges from design spec §3.3
(recorded in §9.1 — owner Neon direction supersedes); the right-hand
inspector rail is a follow-up (needs detail-page layout changes);
390px mobile still unverified by tooling (user checks on his phone).
The white-primary question (S6) is open — the parent decides it with
the owner; do NOT flip the primary system to white without that decision.
