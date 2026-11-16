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

## 7. Restructure batch — nav moves + Settings real categories + tracking pixel-groups + webhook delete (2026-11-16, uncommitted)

Owner-confirmed (2026-11-16 ~00:00 +06): ALL configuration lives ONLY
inside Settings, never in the main menu; Tracking events list is an
audit/report view → Administration; tracking CONFIG is built inside
Settings, UI-based, never via ENV, multi-platform ready (Meta now,
TikTok + others later), multiple PIXEL GROUPS per platform (enable/
disable, pixel ID, test code, CAPI token). Websites & Credentials →
Settings (no website report view exists — do NOT build one); Payment
Methods → Settings (Payment Review stays operational); Webhooks
endpoints → Settings; Outbox & Deliveries → Administration.
Features / Products / Packages stay operational. Settings categories
are Muse's design job within the principle. Danger-button style is
NOT touched (owner decision open).

### Nav map (before → after)

| Item | Before | After |
|---|---|---|
| Websites & Credentials | Main menu, Integrations group, `/integrations` (+ `/$siteId`) | Settings → Integrations group, `/settings/websites` (+ `/$siteId`) |
| Payment Methods | Main menu, Commerce group, `/payment-methods` (+ `/$methodId`) | Settings → Commerce group, `/settings/payment-methods` (+ `/$methodId`) |
| Webhooks endpoints | Main menu, Integrations group, `/webhooks` (+ `/$webhookId`) | Settings → Integrations group, `/settings/webhooks` (+ `/$webhookId`); detail keeps Deliveries tab only |
| Tracking config | — (no UI; `PUT .../tracking` only) | Settings → Integrations group, `/settings/tracking` (new pixel-groups page) |
| Tracking Events (list) | Main menu, Integrations group, `/tracking` | Administration group, `/tracking-events` |
| Outbox & Deliveries | Inside webhook detail ("Outbox events" tab) | Administration group, `/outbox` (own section, extracted) |
| Integrations group | Main menu (3 items) | REMOVED — group disappears with its last item |
| Settings categories | 3 placeholder slots | 4 real categories, grouped (Integrations: Websites / Webhooks / Tracking; Commerce: Payment Methods), permission-filtered; stale "contents pending" topbar hint removed |

### Tasks

| # | Task | Affected paths | Acceptance criteria |
|---|---|---|---|
| 1 | Migration 0006 — pixel groups | `db/migrations/0006_tracking_pixel_groups.sql`, `db/migrations/meta/_journal.json`, `db/schema/tracking.ts` | `label varchar(120)` nullable added; unique `uq_tracking_configurations_site_provider` (site, provider) → `uq_tracking_configurations_site_provider_pixel` (site, provider, pixel_id); expand-and-contract, no data migration (existing rows satisfy the new unique — one row per site+provider, each with a pixel_id); journal idx 6 |
| 2 | Store + Drizzle wiring for `label` + provider | `apps/api/src/platform/db/store.ts` (`TrackingConfigRecord`: `label: string \| null`, `provider: "meta" \| "tiktok"`), `apps/api/src/platform/db/drizzle-store.ts` (load query + row mapper + insert/update sync spec) | Label round-trips through load + persist; provider enum widened in the mapper (`asEnum` over `["meta", "tiktok"]`) |
| 3 | Contracts | `packages/contracts/src/domains/integrations-tracking.ts` | `TRACKING_PROVIDERS = ["meta", "tiktok"]`; `CreateTrackingConfigSchema` (provider enum, pixel_id, access_token, test_event_code?, enabled_events, status?, label?); `UpdateTrackingConfigSchema` (all-optional partial); `ConfigureSiteTrackingSchema` provider becomes the enum (PUT keeps working) |
| 4 | Tracking pixel-groups service + routes | `apps/api/src/modules/tracking/service.ts` (create/list/update/delete per group; PUT upsert now matches on site+provider+pixel_id instead of site+provider so it stays safe under multi-group; ingest event check uses ANY enabled config that enables the event, not the first enabled config), `apps/api/src/app.ts` (`GET/POST /api/v1/admin/integrated-sites/:siteId/tracking`, `PATCH/DELETE .../:configId`; toggle = PATCH `status`, no redundant endpoint) | Create 201 / duplicate (site, provider, pixel_id) 409 / missing site 404 / missing config 404 / unauthenticated 401 / wrong permission 403; token never returned (ciphertext stripped); update re-encrypts only when a new token is supplied (rotated_at then); delete is a hard delete + audit `tracking.configuration.deleted`; PUT still 200s the existing tests (single PUT per site, fresh pixel) |
| 5 | Webhook endpoint delete | `apps/api/src/modules/webhooks/service.ts` (`deleteWebhookEndpointByAdmin` — hard delete + audit `webhooks.endpoint.deleted`; endpoint's deliveries removed from state too, so persistStateDiff never re-inserts orphaned rows against the FK — Postgres FK cascade removes secrets + deliveries rows; outbox_events stay (no FK to endpoints)), `apps/api/src/app.ts` (`DELETE /api/v1/admin/webhooks/:webhookId`) | Delete 200 + endpoint gone from list + deliveries gone; unknown id 404; unauthenticated 401; wrong permission 403; deliveries/outbox history rule documented in the service comment |
| 6 | Admin nav + shell | `apps/admin/src/components/shell.tsx` (NAVIGATION_GROUPS: Commerce loses payment-methods, Integrations group deleted, Administration gains Tracking Events + Outbox & Deliveries; QuickNav gains Settings categories; SettingsShell renders grouped, permission-filtered categories + drops the stale hint), `apps/admin/src/sections/settings.tsx` (real `SETTINGS_CATEGORIES` with `to`/`group`/`permission`; `SettingsCategoryPage` placeholder removed) | Main menu has no config items; Settings nav shows 4 real categories in 2 groups; categories hidden without their permission; QuickNav finds the moved pages |
| 7 | Admin routes | `apps/admin/src/router.tsx` (settings children via new `makeSettingsListRoute`/`makeSettingsDetailRoute`; main children `/tracking-events`, `/outbox`; settings index redirects to `/settings/websites`; old `/integrations`, `/payment-methods`, `/webhooks`, `/tracking`, `/settings/$category` routes removed) | Every old URL 404s (no silent alias — the moves are the point); every new URL mounts its section |
| 8 | Moved sections | `apps/admin/src/sections/integrations.tsx` (refs → `/settings/websites*`, breadcrumb Settings, `TrackingConfig` type +label/provider union), `apps/admin/src/sections/payment-methods.tsx` (refs → `/settings/payment-methods*`, breadcrumb Settings), `apps/admin/src/sections/webhooks.tsx` (refs → `/settings/webhooks*`, breadcrumb Settings, Outbox tab removed, Delete in RowMenu + confirm + DELETE mutation), `apps/admin/src/sections/tracking.tsx` (route → `/tracking-events`, breadcrumb Administration, title "Tracking Events", "View outbox →" → `/outbox`) | Sections render under their new routes with no other behavior change; webhooks detail has Deliveries only |
| 9 | New sections | `apps/admin/src/sections/tracking-config.tsx` (site picker → groups table → create/edit dialogs, toggle switch → PATCH status, delete confirm; token via password input, never echoed), `apps/admin/src/sections/outbox.tsx` (`OutboxSection` — the extracted OutboxTab table + replay, own route) | Built ONLY with existing primitives (no custom one-offs) per the CORE-pass constraint; all five states per section (loading/empty/error/no-results/success) |
| 10 | Tests | `apps/api/test/tracking-pixel-groups.test.ts` (in-memory, same pattern as `catalog-bulk-features.test.ts`), `apps/api/test/webhook-endpoint-delete.test.ts` | Tracking: create/list/update/delete/toggle + 409 + 404 + 401 + PUT compat + ingest with 2 groups (event enabled only on the 2nd group is accepted); webhook delete: register → delete → 200 + list no longer contains it + deliveries gone + 404 on unknown + 401 |
| 11 | Verification | — | Full `verify-batch1.sh` green (vitest incl. new files; tsc api+admin; vite build; lint-repo; check-migrations **65 tables / 7 migrations**; wrangler dry-run staging); jsdom smoke updated for moved routes (all checks pass — report the new count); probe grew through the owner follow-ups (font stack +1, button/radius +5, light mode +12) — final count reported in Status; API spec §17/§18 + PLAN/STATUS + prd-ui-coverage.md (N8, O1 → ✅; P4 reference updated) |

Risks: PUT semantics change (pixel-match upsert) — the two existing
PUT tests call PUT once per site with a fresh pixel, so they still
pass; the old "update the single config regardless of pixel_id"
behavior is intentionally gone. TikTok appears as a provider option
before any TikTok delivery exists — the config page carries the same
honest "delivery is not live yet" note as the Meta banner; delivery
itself is Batch 4. The `$category` route is deleted outright — any
bookmarked `/settings/category-N` URL 404s (placeholders never had
real content, so nothing is lost).

### Status — DONE (2026-11-16, uncommitted; parent verifies + pushes)

Full `verify-batch1.sh` green: vitest **112/112, 15 files** (10 new:
8 tracking pixel-groups + 2 webhook delete); tsc api + admin exit 0;
vite build (initial chunk 460.66 kB / 136.40 kB gzip,
`index-Bz7uVOdx.js`); lint-repo **149 files**; check-migrations
**65 tables / 7 migrations**; wrangler dry-run staging exit 0; pnpm
frozen-lockfile skipped locally (no binary — CI runs it). jsdom
smoke (harness `~/workspace/stackmate-work/spa-repro/`, rebuilt
bundle): **93/93 PASS** (was 76/76 — harness updated for the moved
routes; +17 new checks: Settings real categories + redirect,
Tracking Events + Outbox pages, tracking-config site picker →
groups → create dialog, webhooks RowMenu Delete + confirm-cancel).
Computed-style probe
(`~/workspace/stackmate-work/neon-core-pass/probe-computed.mjs` on the
built CSS `dist/assets/index-InK-ZJil.css`): **66/66 PASS** (was
48/48 — +1 font-stack, +5 button/radius, +12 light-mode checks, see
the follow-ups below; one probe failure found and fixed along the
way: the minifier shortens literal `#000000` → `#000` in built CSS
while `var()` token values stay verbatim — the expectation was
corrected to the built form). API spec §17.6 + §18.7
added; PLAN/STATUS + prd-ui-coverage.md updated (N8, O1 → ✅).

Two fixes found during verification (not in the original plan):
- Migration 0006 was NOT re-runnable: plain `ADD CONSTRAINT` has no
  `IF NOT EXISTS` in Postgres, so the second Postgres suite re-applying
  all migrations failed with "relation already exists". Fixed with the
  repo's established DO-block form (same as migration 0002's FK add).
- Typed `navigate`/`Navigate` to `/settings/*` failed tsc: the
  `makeSettings*Route` helpers took `path: string`, widening the
  literal out of the router type. Fixed by making the helpers generic
  over the path literal (`<TPath extends string>`).

FONT STACK follow-up (owner 2026-11-16 ~03:03 +06, screenshot
image-83): `--sm-font-sans` was a 9-item stack; Neon's computed stack
is exactly two items. Changed to `"Inter Variable", sans-serif` —
nothing else in the stack; verified no other sans stack exists in the
admin source (every `font-family` use goes through
`var(--sm-font-sans)` or `var(--sm-font-mono)`; no stack in
`index.html`/`main.tsx`). Package, import, and weights untouched —
the font itself already loaded (live CSS @font-face, woff2 200s).
Probe +1 check asserting the resolved token equals
`"Inter Variable", sans-serif` (dark theme); probe 49/49.

BUTTON SYSTEM rework (owner 2026-11-16 ~03:07 +06, screenshots
image-84/85; evidence from Neon's live CSS fetched 03:07 +06):
Neon's green is `#00E599`, NOT `#00E5A0`; the green FILL is a
gradient `linear-gradient(180deg, #00E599 24.85%, #007F55 68.32%)`,
not flat; accent buttons fill green on hover (screenshot 85) and
white appears only on the single most-important action. Applied:
`--sm-accent` #00e5a0 → #00e599 (dark), light accent #007a55 →
#007f55, `--sm-accent-soft` → rgba(0,229,153,0.1), new token
`--sm-accent-gradient` (one token, both themes); accent hover =
gradient + black text + transparent border; white primary kept ONLY
on "Create product" (Products list) — all other 56 static
`variant="primary"` sites + 2 dynamic ones (ConfirmDialog confirm,
payment-method Enable) → `variant="accent"` (58 accent call sites
total). Derived (NOT from Neon CSS — documented as derived):
`--sm-accent-hover` #00c98f → #00c987 (dark), #005c44 → #005f40
(light). Danger style NOT touched (owner decision open). Probe +5
(gradient token, hover fill dark + light, hover text, hover border);
probe 54/54 after the rework.

RADIUS fix (owner 2026-11-16 ~03:11 +06; Neon live CSS, Tailwind
v4: base radius `.25rem` = 4px): `--sm-radius-md/lg` 6px → **4px**,
`--sm-radius-xl` 8px → **6px** (dialogs only); `--sm-radius-sm`
(4px, small controls only) unchanged. No hardcoded radii in TSX,
so the token change covers everything. Probe radius checks updated
to 4px (dialogs 6px).

LIGHT-MODE learning (owner 2026-11-16 ~03:13 +06, screenshots
image-86/87/88 — Neon console light mode, read first-hand): light
is NOT dark inverted — white surfaces on a #f8fafc page, dark text,
pale green TINTS where dark uses transparent/outline. Applied (light
only, dark unchanged): accent button bg `rgba(0,229,153,0.12)` +
#007F55 border/text (new `--sm-btn-accent-bg` token; dark stays
transparent); secondary button WHITE bg (new
`--sm-btn-secondary-bg`; dark stays transparent); success banner
pale green tint bg `rgba(0,229,153,0.08)` + soft green border
`rgba(0,229,153,0.35)` + #007F55 text (light-only
`[data-theme="light"] .sm-alert-success` rule; dark alerts stay
bordered panels on surface bg); light `--sm-success-bg` #dcfce7 →
`rgba(0,229,153,0.08)`, `--sm-success-text` #166534 → #007f55,
`--sm-success-border` rgba(22,101,52,0.35) → rgba(0,229,153,0.35)
(badge + banner share these tokens); active tab dark text + 2px dark
underline (new `--sm-tab-active`: dark #00e599 / light #0f172a).
Already correct via tokens, probe-checked: active nav light-grey
pill + dark text + #007F55 icon; neutral badge #f1f5f9 + dark text;
table headers dark semibold. No sub-tab component exists
(single-level `Tabs` only) — the pill-group sub-tab pattern is
recorded, nothing invented. Info alert already a pale tint in light
— unchanged. Audit doc C7 + design-system §9.2 record the rules.
Probe +12 light checks (accent bg tint, secondary bg white, banner
bg tint, badge success bg + text, badge neutral bg, active-nav bg +
icon, tab active text + underline, table header color, accent bg
dark transparent); probe 66/66.

Environment note: this VM was rebuilt during the batch — local
Postgres 16 was gone entirely (no binaries, no service). Reinstalled
via apt (the boot-time `apt-get update` held the lock ~13 min),
started the service, set the `postgres` password, recreated
`stackmate_test`; the full suite then ran green on the first pass.

## 8. Green-gradient correction + Neon gap hunt + 100% responsive (2026-11-16, uncommitted)

Owner orders 2026-11-16 ~04:14 +06: (1) the green gradient I shipped
mixed green with BLACK/DARK — Neon mixes green with WHITE/LIGHT;
(2) find the other gaps yourself and fix them; (3) make the whole
frontend 100% responsive for any screen size. One writer on the tree;
no commit/push; danger button style NOT touched (owner decision open);
dashboard redesign stays a separate queued item (only Neon gaps in
what exists are fixed here).

| # | Task | Depends on | Affected paths | Acceptance criteria |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Light green gradient (CORRECTS the restructure batch's dark gradient) | — | `apps/admin/src/styles/tokens.css` (`--sm-accent-gradient` → `linear-gradient(180deg, #6FF2C4 0%, #00E599 100%)`, text stays #000000), `~/workspace/stackmate-work/neon-core-pass/probe-computed.mjs` (3 gradient expectations), `~/workspace/stackmate-work/neon-gap-audit.md` (C1 correction) | Accent hover/focus fill is light in BOTH themes; the 180deg dark gradient (`#00E599 24.85% → #007F55 68.32%`) is recorded as a mis-attribution (the class exists in Neon's marketing CSS but is used NOWHERE in the homepage HTML, count 0; console CSS unreachable — Keycloak login; the owner's image-85 hovered button is uniformly bright light green and wins). `#007F55` stays as light-mode text/border green; light accent DEFAULT tint unchanged. |
| 2 | Right inspector rail (G7) — detail-page layout | — | `apps/admin/src/lib/section-kit.tsx` (new `DetailLayout` + `Inspector`), `apps/admin/src/styles/tokens.css` (`.sm-detail-layout` grid `1fr 300px`, `.sm-inspector` sections, label-left/value-right rows, dividers; stacks below main <1280px), 12 detail sections (customers, features, integrations, licenses, orders, packages, payment-methods, payment-review, products, staff user, subscriptions, webhooks — first `DetailFacts` → rail section named for the entity; second facts inside Cards, wizard-review, dialog, and drawer usages KEEP the `DetailFacts` grid) | Detail pages show the facts as a right rail (Neon image-77: collapsible-titled sections, 13px #B0B1B2 labels left, values right, dividers); rail collapses below the main column <1280px; no detail page loses facts; smoke + vitest stay green. |
| 3 | Sticky table header fix (found in gap hunt) — CORRECTED during verification (see task 9) | — | `apps/admin/src/styles/tokens.css` (`.sm-table th`: `top: 0` — NOT `top: var(--sm-topbar-height)`; background per container — `--sm-surface` inside `.sm-table-wrap`, `--sm-bg` inside `.sm-table-flat` — so scrolled rows never show through) | **The `top: 48px` version shipped first in this batch was WRONG and was caught by the Chromium audit, not by review:** `overflow-x: auto` on the wrap computes `overflow-y` to `auto`, so the WRAP is the sticky scrollport, not the viewport — `top: 48px` meant "48px below the wrap's top edge" and permanently displaced the header 48px down over the first data row (measured: thead 250–287, first row 287–334, `th` at 298–335; `elementFromPoint` at the first row's Select button returned `TH` at scrollY=0 — the first row's buttons were unclickable). `top: 0` puts the header at its natural position (no displacement, first row clickable); the header then scrolls away with the page — a viewport-sticky header is incompatible with the horizontal-scroll wrapper and would need the internal-scroll card pattern (a design decision, not assumed). `html { scroll-padding-top: 96px; }` added so keyboard focus / `scrollIntoView()` clears the 48px topbar + ~37px header (WCAG 2.4.11). |
| 4 | Flat list tables (Neon image-76: list tables sit directly on the page bg, no bordered panel; bordered panels are for detail-page tables, image-73) | — | `apps/admin/src/lib/section-kit.tsx` (`ListTable` uses new `.sm-table-flat`), `apps/admin/src/styles/tokens.css` (`.sm-table-flat`: no border/bg/radius, rows separated by 1px lines only) | All 14 list sections render flat tables; detail-page tables keep `.sm-table-wrap`. Judgment call with screenshot evidence, recorded in the audit. |
| 5 | Scrollbar styling (Neon: thin dark scrollbars; ours were browser defaults — light/white on dark mode) | — | `apps/admin/src/styles/tokens.css` (`scrollbar-color` + `::-webkit-scrollbar` family, both themes, tokenized) | Thin dark scrollbars in dark, thin grey in light; no layout change. |
| 6 | Responsive pass — dialogs, QuickNav, touch targets, overflow safety net | — | `apps/admin/src/styles/tokens.css` (≤640px: dialog overlay `align-items: flex-end`, padding 0, dialog full-width bottom sheet, top radius 6px only, max-height 92vh, slide-up via `--sm-transition-slow` so reduced-motion zeroes it; QuickNav hides its label → icon-only; `.sm-btn`/`.sm-btn-icon`/`.sm-menu-item`/`.sm-nav-btn` min-height 40px; `html, body { overflow-x: clip; }` safety net — `clip`, not `hidden`, so `position: sticky` keeps working) | No horizontal page overflow at 390/640/900/1280/1440/1920; dialogs are bottom sheets on mobile; topbar fits at 390px (hamburger + icon search + avatar); primary actions are ≥40px touch targets on mobile; `prefers-reduced-motion` respected (existing media query zeroes the slide animation). |
| 7 | Dead token cleanup | — | `apps/admin/src/styles/tokens.css` (remove unused `--sm-accent-text-on` — defined in both themes, referenced nowhere; its light value #ffffff would be wrong on the light gradient) | No `--sm-accent-text-on` references remain; probe unaffected. |
| 8 | Verification — honest, with a real headless-browser layout audit | 1–7 | `bash ~/workspace/stackmate-work/verify-batch1.sh` (expect vitest ≥112, check-migrations 65/7); jsdom smoke (`~/workspace/stackmate-work/spa-repro/`, extended: rail renders on a detail page, drawer opens <900px, dialog bottom-sheet classes present); computed-style probe (extended: new gradient, flat-table rules, bottom-sheet rules, sticky-header top/bg, scrollbar tokens); headless Chromium (Playwright `chromium-1148` already in `~/.cache/ms-playwright`, `playwright-core` installed under `~/workspace/stackmate-work/responsive-audit/`, stub API server serving the built SPA) at 390/640/900/1280/1440/1920 — screenshots + `scrollWidth <= innerWidth` per width | Every width verified in a real browser, or the exact blocker is reported and the un-verified widths are named — never claim responsive from CSS alone. **DONE — see STATUS.md evidence row: Chromium audit 50/50 (incl. the white-button ground truth, sticky-header geometry, shell squeeze, drawer rail, settings-drawer trap).** |
| 9 | Mobile shell squeeze (found by the Chromium audit — the account-menu check failed only in the FULL run) | 8 | `apps/admin/src/styles/tokens.css` (`@media (max-width: 900px)`: `.sm-shell` + `.sm-shell[data-nav-collapsed="true"]` + `.sm-shell[data-sidebar="rail"]` → `grid-template-columns: 1fr`; same for `.sm-settings-shell` + `[data-nav-collapsed="false"]`) | **Root cause — specificity, not layout:** the collapsed-rail template `.sm-shell[data-nav-collapsed="true"]` is (0,2,0) and beats the mobile (0,1,0) single-column rule. Visiting Settings persists `sm-nav-collapsed=true`, so at <900px the grid stayed `64px 1fr`; the sidebar is a fixed drawer (out of flow), so `.sm-main` auto-placed into the 64px first column (measured: `.sm-main` 64px wide, account button at 120–154, menu cut off at left −110). The (0,2,0) overrides make one column win below 900px in both shells. |
| 10 | Mobile drawer shows the icon rail, not the full nav (found by screenshot review) | 8 | `apps/admin/src/styles/tokens.css` (`@media (max-width: 900px)`: collapsed/rail label-hiding rules overridden inside `.sm-sidebar` — nav buttons left-aligned with base padding, `.sm-nav-label`/`.sm-brand-name` `display: inline`, `.sm-nav-group-label` `display: block`) | The persisted collapse preference turned the mobile drawer into an unlabeled icon list — unusable on touch (no tooltips). The drawer now always shows full labeled navigation; the collapse preference stays a desktop concern. |
| 11 | Settings drawer is a trap on mobile (found by the Chromium audit — the close click timed out) | 8 | `apps/admin/src/components/shell.tsx` (SettingsShell: backdrop div + Escape effect, mirroring MainShell; close-on-navigate already existed), `apps/admin/src/styles/tokens.css` (`.sm-settings-shell[data-settings-nav="open"] .sm-sidebar-backdrop` rule in the <900px block) | The settings drawer had NO backdrop and NO Escape handler, and its hamburger sits under the open drawer (z 50 over the topbar) — a touch user who opened it had no way to dismiss it without navigating. Backdrop click + Escape now both close it (verified in the audit). |
| 12 | White-button claim + light warning banner (restructure browser re-test follow-ups) | 8 | Chromium audit (`~/workspace/stackmate-work/responsive-audit/audit.mjs` `buttonTruth`: computed style + sampled screenshot pixels) | **White-button claim DISPROVED by the same method that made it:** "Create feature" / "Create package" / "Create pixel group" compute to `background: rgba(0,0,0,0)`, border + color `rgb(0,229,153)`, class `sm-btn-accent`; their button boxes contain ZERO white pixels (842–972 black + 6–92 green samples). "Create product" is genuinely white (`rgb(255,255,255)` bg, 949 white samples) — correct by design, the single white primary. No code change. **Light warning banner: LEFT AS IS** — Neon's image-88 warning is inline text with no fill/border on a white card; ours is white fill + amber border/text (same background), so no token change. |

Risks: the rail migration touches 12 detail sections (regression risk is
carried by the smoke test + the Chromium audit's detail-page screenshots);
the flat-list-table change is a visible judgment call (Neon image-76) —
the owner can revert it in one token-class change; the JS chunk hash of
the Cloudflare build may differ from the local build (environmental —
the CSS hash is the content check, as in the restructure batch).

**Outcome (2026-11-16, uncommitted — parent verifies + pushes):** all 12
tasks done. The Chromium audit caught 3 real defects the CSS-only checks
could not see (sticky-header 48px overlap, mobile shell squeeze,
settings-drawer trap) and disproved the white-button claim with computed
styles + pixel samples. Final numbers: vitest 112/112 (15 files), tsc
api+admin exit 0, vite build (JS chunk `index-C91IoIEj.js`, CSS
`index-9dEl2aSF.css`), lint 149 files, check-migrations 65/7, wrangler
dry-run exit 0; jsdom smoke 101/101; computed-style probe 95/95;
Chromium audit 50/50 at 390/640/900/1280/1440/1920. The batch's own
first fix (`top: 48px`) was wrong and is recorded as such in task 3 —
the audit, not review, caught it. No commit, no push, no staging
changes, danger style untouched.
