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

## 5. Product-flow fix — Features + Packages, product-first UX (2026-11-16, uncommitted)

Owner finding (live, 2026-11-16 ~00:03 +06): the Features/Packages UI
hid the product context — a small toolbar `<Select>` silently defaulted
to the first product, create dialogs never named the product, features
were one-at-a-time only, the list showed no package-association info
(matrix E7 ❌), and the package form was a single form with no
wizard/review (matrix F2 🟡). PRD §6.1 + API spec §9.2/§9.3 + DB
(`product_features.product_id` NOT NULL, unique `(product_id,
feature_key)`) are product-first by design — the gap was UX flow, not
data. No nav items move in this batch (restructure batch owns the
shell/nav); primary button color stays green (white-vs-green decision
OPEN). Pattern constraints from the owner (2026-11-16 ~01:11 +06,
~01:14 +06): build ONLY with the existing primitives
(`components/primitives.tsx` + `lib/section-kit.tsx` + `styles/tokens.css`) —
no custom one-off components, custom radii, custom colors, or inline
styles; radii ≤6px (dialogs ≤8px), no 999px pills, no circular avatars;
status as a small pill only where Neon does, otherwise plain text.

| # | Task | Affected paths | Acceptance criteria |
| :--- | :--- | :--- | :--- |
| 1 | Features explicit product-first | `apps/admin/src/sections/features.tsx` | `/features` with no `product` param shows a "Choose a product" picker (table of products with Features/Packages counts + Select per row) — never a silent default; once selected, the subtitle names the product ("Features of {name}") and the header action appears only then; the product selector stays for switching |
| 2 | Create feature dialog names its product | `apps/admin/src/sections/features.tsx` | Title `Create feature — {product name}` + read-only disabled Product field |
| 3 | Bulk feature add (API decision: single bulk endpoint, not sequential creates) | `packages/contracts/src/domains/catalog.ts` (`BulkCreateProductFeaturesSchema`, 1–100 rows), `apps/api/src/modules/catalog/service.ts` (`createProductFeaturesBulk` — one transaction, per-row safeParse + key-uniqueness vs product AND earlier batch rows + entitlement validation; 201 if ≥1 created, 422 with `details.errors` if none; one summary audit `catalog.feature.bulk_created` only when ≥1 created), `apps/api/src/app.ts` (`POST /api/v1/admin/products/:productId/features/bulk`, registered before `:featureId` detail routes), `apps/api/test/catalog-bulk-features.test.ts` 6/6, `apps/admin/src/sections/features.tsx` (Tabs "One feature" / "Several at once"; multi-row form with add/remove rows, per-row client validation, server errors attached per row, partial success drops landed rows + keeps failed rows with a summary Alert; dialog size md in bulk mode) | One transaction, per-row results, auditable (one summary audit entry), no partial-state ambiguity from N separate requests; partial failure reported per row by index, never silent; the list refreshes showing exactly what landed |
| 4 | Association view (E7) | `apps/api/src/modules/catalog/service.ts` (`featureUsageByPackages` — highest referencing version per package, sorted by package name; `withFeatureUsage`), `apps/api/src/app.ts` (GET list + GET detail + POST single-create return `used_by_packages`), `apps/admin/src/sections/features.tsx` ("Used by" column — plain white links `name vN · status`, comma-separated; "Not used in any package" when zero; detail Card "Used by packages (N)" with Package/Version/Status table or hint text when unused) | Real data only — `used_by_packages[]` from package versions' feature values; zero usage shows the empty text, never a fake |
| 5 | Create package dialog names its product | `apps/admin/src/sections/packages.tsx` | Wizard title `Create package — {product name}` from step 2 on + read-only product field on the review step |
| 6 | Stepped package builder (F2) | `apps/admin/src/sections/packages.tsx` (`CreatePackageDialog` → 4-step wizard: 1 Product (pre-filled from context, changeable — resets grants + errors), 2 Details, 3 Features (grants editor from THAT product's active features only), 4 Review (full summary via `DetailFacts` + "Creates as a draft" hint); `Tabs` step indicator, back-jump to any reached step, forward jumps blocked; review submit re-validates and jumps back to the offending step; Enter advances / submits on review) | Creates as DRAFT; publish stays a separate explicit action on the package page (never auto-publish); existing edit/version/publish flows untouched |
| 7 | Packages list product-first | `apps/admin/src/sections/packages.tsx` | Same picker treatment as features (no silent default; selected product prominent; header action conditional) |
| 8 | Verification | — | Full `verify-batch1.sh` green (vitest 102/102, 13 files — was 96/96, 12; tsc api+admin; vite build; lint-repo 141 files; check-migrations 65 tables / 6 migrations; wrangler dry-run staging); jsdom smoke 73/73 (was 44/44 — 29 new checks: picker states, Used by column, bulk dialog + submit toast, wizard steps + review + create → detail); API spec §9.2 documents the bulk endpoint; docs/implementation/PLAN.md + STATUS.md updated with exact numbers |

Risks / noted gaps (for the CORE pattern pass, not this batch): no
generic stack-gap primitive exists in `tokens.css` (stacked Cards /
fields have no gap utility — `.sm-form-grid` gap 16px, `.sm-facts`
margin-bottom 24px, `.sm-tabs` 20px, `.sm-alert` 16px are the spacing
facts this batch relied on); secondary text token `--sm-text-muted`
`#9ca3af` is too grey vs Neon's `#B0B1B2` (13px); six 999px rules
remain in tokens.css (badges/chips/avatar). The bulk rows and wizard
use existing primitives only, so they inherit the core fix
automatically. The smoke harness caught one of its own bugs during
this batch (two "Next" buttons — ListTable pager + wizard footer —
`byText` returned the pager; wizard button lookups are now
dialog-scoped) — a harness artifact, not a product bug.

## 6. Neon CORE pass — tokens + primitives first (2026-11-16, uncommitted)

Owner verdict (2026-11-16 ~01:40 +06): "Does Neon use a direct green
button anywhere like yours?" (No.) + "You still couldn't leave the
radius-type design styling structure." The previous passes capped
tokens and fixed instances while the FOUNDATION stayed round and
green. This pass changes the six core systems in `tokens.css` +
`primitives.tsx` + `section-kit.tsx` + `shell.tsx`; every screen is
built from these, so the whole design follows in one flow. No nav
items move. Owner button spec (2026-11-16 ~01:41 +06, images 80/81/82):
exactly three variants — PRIMARY solid white/black, SECONDARY
transparent + grey border, ACCENT green outline for brand CTAs only.
References: `~/workspace/stackmate-work/neon-gap-audit.md` (C1–C6) +
screenshots image-73/76/77/78/79/80/81/82.

| # | Task | Affected paths | Acceptance criteria |
| :--- | :--- | :--- | :--- |
| 1 | Button system — exactly 3 variants, no solid green fill | `apps/admin/src/styles/tokens.css` (new `--sm-btn-primary-bg/text/hover` per theme), `apps/admin/src/components/primitives.tsx` (`ButtonVariant` gains `"accent"`) | PRIMARY dark = white `#ffffff` bg + black `#000000` text (hover `#e5e5e5`), light = black `#0f172a` bg + white text (the inversion); SECONDARY = transparent bg + 1px light-grey border + white text; ACCENT = transparent bg + 1px green border + green text, brand CTAs only; DANGER renders as secondary (Neon shows no danger button); RowMenu trigger = bordered secondary square 26px; all ~6px radius, ~30px height, 13–14px Inter. All 87 primary/danger call sites change by the primitive alone. Built-CSS check: zero `.sm-btn-*` rules with a solid green fill |
| 2 | Radius STRUCTURE goes (not a cap) | `tokens.css` | `.sm-avatar` / `.sm-account-btn` / `.sm-chip` 999px → 6px square; 999px survives ONLY for `.sm-badge` (true status pill + dot), `.sm-badge-dot`, `.sm-spinner` — exactly 3 occurrences in the built CSS |
| 3 | Color-application rule (one rule, everywhere) | `tokens.css` | `--sm-text-muted` dark `#9ca3af` → `#B0B1B2` (measured from image-79 inspector, contrast 8.65); light stays `#475569` (`#B0B1B2` on white would fail contrast); active nav icon → green (image-76), text stays white; green appears ONLY as accent-outline button border/text, links, active-nav icon, logo mark, status dots, focus ring — never a solid fill |
| 4 | Typography scale | `tokens.css` | Secondary text 13px `#B0B1B2` everywhere (all `12.5px` → 13px, 10 rules; no 12.5px remains); group/section labels 11px UPPERCASE + tracking → 12px normal case; menu items 14px → 13px; Inter Variable, base 14px |
| 5 | Primitives layer + account menu (image-78) | `primitives.tsx` (new `MenuSub` — fly-out to the LEFT, 150ms close delay bridging the 4px gap, hover/click/Enter/ArrowRight open, ArrowLeft close; `RowMenu` trigger class; token classes replace every primitive one-off: `.sm-check-label`, `.sm-card-head`, `.sm-breadcrumb-item`, `.sm-select-sm` 28px → 26px, `.sm-toast-icon`, `.sm-flex-1`, `.sm-table-skeleton`, `.sm-topbar-spacer`, `.sm-settings-back`, `.sm-menu-header-body`), `shell.tsx` (AccountMenu restructured: header → "Manage" → Profile / Change password / Settings / Theme submenu / Status row → Sign out; `useApiStatus` — one `GET /api/v1/health` per session, module-cached, honest "All OK" / "Checking…" / "Unavailable" pill), `tokens.css` (new `.sm-stack` / `.sm-stack-sm` stack-gap primitives — the gap the product-flow batch noted as absent) | Account menu mirrors Neon's structure using the fixed Menu primitive, not a custom build; theme choice lives ONLY in the submenu; Status pill is a real live check, never hardcoded. `shell.tsx` has ZERO inline styles after this pass; the only inline styles left in `primitives.tsx` are the two genuinely dynamic ones (RowMenu portal position, Skeleton height/width props) |
| 6 | Layout skeleton | — (no change) | Already at target: topbar 48px, sidebar 248px / rail 64px, content 20px, PageHeader title-first 24px + breadcrumb under, ListTable full-width search, white semibold table headers |
| 7 | Section sweep (one-off overrides → core) | `apps/admin/src/sections/products.tsx`, `packages.tsx`, `features.tsx` (+ `payment-methods.tsx`, `payment-review.tsx` for the shared class) | Grep-verified: sections contain ZERO color/radius/font-size inline overrides, ZERO hardcoded hex, ZERO `sm-accent` references. Repeated patterns converted to token classes: 8× `padding: 16` on `.sm-table-wrap` → `.sm-table-wrap-pad`; feature-detail skeleton stack → `.sm-stack-sm`; products fieldset + packages grant cards (token border + token radius) → `.sm-bordered-card`. The ~120 remaining inline styles are layout spacing ON the 4px scale, deliberately kept (not pattern violations). The product-flow screens (features picker/bulk, packages wizard) inherit the core fix with NO edits of their own |
| 8 | Verification | — | Full `verify-batch1.sh` green (vitest 102/102, 13 files; tsc api+admin; vite build chunk `index-BhUs9wnY.js`; lint-repo 141 files; check-migrations 65 tables / 6 migrations; wrangler dry-run staging; pnpm frozen-lockfile skipped locally — CI runs it); jsdom smoke **76/76** (was 73/73 — harness updated for the Theme submenu flow + Status pill; +3 new checks); computed-style probe **45/45** on the built CSS (`~/workspace/stackmate-work/neon-core-pass/probe-computed.mjs`, resolves every `var(--sm-*)` against both theme token blocks); before/after table in `~/workspace/stackmate-work/neon-core-pass/computed-styles.md`. **No pixel screenshots** — no headless browser exists in this environment; pixel confirmation is the parent's browser re-test |

Risks / noted gaps (for the parent's browser re-test, not this batch):
light-mode primary is the inversion by rule (Neon light theme was never
screenshotted — verify it reads as premium, not heavy, on a real light
screen); the Theme submenu fly-out direction (left) + 150ms hover
bridge need a real pointer to confirm they feel right; danger buttons
now look like secondary (Cancel vs Delete differ only by label — owner
decision if a distinct destructive style is wanted); ACCENT has no call
sites yet (no brand/Connect-style CTA exists in the admin today);
right inspector rail (G7) still not built; staging latency unchanged
(~2s/call — p95 <1s target still not met); the white-primary decision
in §5 ("primary button color stays green — decision OPEN") is now
CLOSED by this pass (owner answered 2026-11-16 ~01:40–01:41 +06).
