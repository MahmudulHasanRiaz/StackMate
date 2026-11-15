# StackMate — ZIP vs Repository vs PR #1 Reconciliation

**Branch:** `feat/stackmate-full-implementation` (base: `429124e`, PR #1 branch
`chore/stage-0-deploy-safety-foundation`; main at `d056892`)
**Date:** 15 November 2026

## 1. Sources reconciled

| Source | Commit / content | What it contained |
|---|---|---|
| `main` | `d056892` | Scaffold only: empty `apps/`, `db/`, `packages/` dirs + docs. No runnable code. |
| PR #1 branch | `429124e` (20 commits, 16 files) | Docs-only foundation: ADR-0001–0004, CI/CD + migration safety docs, `scripts/validate-repo.mjs`, workflows, governance updates. |
| Supplied ZIP | `stackmate-complete-implementation.zip` (124 files) | Full implementation: API, admin SPA, contracts, Drizzle schema + SQL migrations, docs, scripts. Already contains the PR #1 docs content, plus ADR-0005/0006 and implementation docs. |

The ZIP contains no Git history. The repository's `.git` metadata, branches,
and commit history were preserved: the ZIP tree was copied over the PR #1
branch with `rsync -a --exclude=.git`.

## 2. Conflict decisions (file exists in both)

Rule applied: keep the PR #1-branch version where it is newer, more complete,
or more cautious; keep the ZIP version where it adds implementation substance;
never silently downgrade a spec.

| File | Decision | Rationale |
|---|---|---|
| `AGENTS.md` | Kept PR #1 version (140 lines vs ZIP 95), then amended §4 (see §3) | PR #1 version has the full 10-point dependency-currency policy, date/migration policy, CI/CD ownership, and engineering workflow sections the ZIP trimmed. |
| `docs/decisions/ADR-0001…0004` | Kept PR #1 versions; merged ZIP additions into ADR-0002/0004 (see §3) | PR #1 versions are the reviewed, more cautious texts (e.g. ADR-0002 validation gates, ADR-0004 wording). |
| `docs/plan/Implementation Roadmap & Delivery Plan.md` | Kept PR #1 version (v1.1) | ZIP downgraded it to v1.0 and dropped the ownership-boundary paragraph. Specs are not rewritten to match code. |
| `docs/plan/Repository Structure & Engineering Conventions.md` | Kept PR #1 version (v1.1) | ZIP downgraded it to v1.0 and dropped the dependency-currency rules. |
| `docs/README.md` | Kept PR #1 version | ZIP version only added a duplicated PLAN link and looser index wording. |
| `docs/implementation/AI-AGENT-START-PROMPT.md` | Kept PR #1 version | PR #1 version has the dependency rule, CI/CD ownership, and future-services sections the ZIP trimmed. |
| `docs/decisions/README.md` | Kept ZIP version | ZIP correctly indexes ADR-0004–0006, which the PR #1 version predates. |
| `docs/implementation/PLAN.md` | Kept ZIP version | ZIP replaced the Stage-0 checklist with a reconciliation record (conflict resolutions C-01–C-09, D-01–D-05). The Stage-0 checklist is superseded by the work on this branch; the conflict record is the useful artifact. |
| `docs/implementation/STATUS.md` | Rewrote honestly (see §4) | Both versions were wrong in opposite directions: PR #1 said "no runnable app", ZIP falsely claimed Stages 0–10 complete/verified. |
| `docs/operations/CI-CD-AND-MIGRATIONS.md` | Kept ZIP version | ZIP is a runbook referencing the actual runner scripts; PR #1 version was a target contract. The ownership boundary (owner does first Cloudflare setup) is restated in `docs/implementation/STATUS.md` and the deploy workflow header. |
| `README.md` | Rewrote as a merge (see §4) | PR #1 README described a scaffold; ZIP README described the implementation with unverified claims. The merged README describes the actual implementation with honest status. |
| `.env.example`, `package.json`, `pnpm-workspace.yaml`, `scripts/validate-repo.mjs`, workflows, package manifests | Kept ZIP versions, then fixed (see §5) | ZIP versions are the implementation-complete ones; PR #1 versions were placeholders. Fixes applied in follow-up commits. |
| `docs/decisions/ADR-0005…0006` | Added from ZIP (new files) | Did not exist on the PR #1 branch. ADR-0005 is the governing Hyperdrive decision (see §3). |

## 3. Targeted merges into kept PR #1 files

- **AGENTS.md §4 — Hyperdrive override.** The PR #1 text forbade Hyperdrive
  ("Do not add … Hyperdrive … without measured need and an accepted ADR").
  The user directive for this work REQUIRES Hyperdrive from day one, and
  ADR-0005 (added from the ZIP) is the accepted ADR that measures the need
  and records the decision. The line now reads: Hyperdrive is required per
  ADR-0005; other optional services still need a measured need + ADR.
  ADR-0005 governs; the override is recorded here, not hidden.
- **ADR-0004 — verified dependency record.** Appended the ZIP's dependency
  selection table (hono 4.13.18, wrangler 4.161.0, better-auth 1.7.23,
  drizzle-orm 0.45.4, drizzle-kit 0.31.4, pg 8.20.0, vite 6.3.5, TanStack
  versions) with a correction note: `@cloudflare/workers-types 4.20261114.0`
  never existed on the registry; wrangler 4.161.0 peers on
  `^5.20261110.1`, so the repo pins `5.20261115.1`. `zod` was removed as a
  direct dependency (no source file imports it; better-auth 1.7.23 brings
  its own zod ^4).
- **ADR-0002 — concrete script references.** Added the ZIP's references to
  the real runner scripts (`scripts/migrate.mjs` with advisory lock,
  `scripts/check-migrations.mjs`, `scripts/smoke-check.mjs`) alongside the
  PR #1 validation-gates section, which was kept intact.

## 4. What the ZIP claimed vs what was true

The ZIP's `STATUS.md` claimed Stages 0–10 "Complete (Full Monorepo
Implementation Verified)". Verified against the actual code, these claims
were false and were corrected, not believed:

1. **Production store was in-memory.** `apps/api/src/app.ts` did
   `new StackMateDataStore()`; every service imports that type.
   `apps/api/src/platform/db/hyperdrive.ts` existed but was never used by
   any business operation. → Fixed by `apps/api/src/platform/db/drizzle-store.ts`
   (`DrizzleStore extends StackMateDataStore`, Drizzle/Postgres-backed,
   Hyperdrive uncached connection string, fail-closed in staging/production).
   The in-memory class remains ONLY as a test adapter.
2. **Better Auth was config-only.** `better-auth.ts` built a plain config
   object; `betterAuth()` was never called, no Drizzle adapter was wired,
   no `/api/auth` handler was mounted. → Fixed: `createBetterAuth()` calls
   `betterAuth()` with `drizzleAdapter(drizzleDb, { provider: "pg" })` and
   is mounted as the fallback for `/api/auth/*` after the existing custom
   staff-session routes. Session seam documented in code + STATUS.md.
3. **Verification scripts were fake.** `typecheck-and-transpile.mjs` was
   Babel transpile-only; `build-all.mjs` only copied `index.html`/css;
   `run-tests.mjs` transpiled then ran `node --test` on one file.
   → Replaced with real `tsc --noEmit` (`scripts/typecheck.mjs`), real
   vite + wrangler bundle validation (`scripts/build-all.mjs`), and real
   `vitest run` (`scripts/run-tests.mjs`).
4. **Root scripts pointed at nonexistent files.** `db:seed` and
   `bootstrap:super-admin` referenced `scripts/seed-reference.mjs` and
   `scripts/bootstrap-super-admin.mjs`, which did not exist. → Both scripts
   now exist and are implemented (idempotent seed via `DATABASE_URL`;
   bootstrap via HTTP POST to a running API).
5. **Worker entry ignored env.** `apps/api/src/index.ts` created a
   module-level default app with an in-memory store. → Rewritten: per-request
   construction from env bindings, fail-closed without Hyperdrive in
   staging/production.
6. **CI never installed dependencies and used npm on a pnpm repo; the
   deploy workflow never migrated (only `--dry-run`) and never deployed.**
   → Both workflows fixed (pnpm setup + frozen lockfile install, real
   `db:migrate:deploy`, real `wrangler deploy` steps; manual-only deploy
   preserved).

## 5. What was reused from the ZIP (unchanged or near-unchanged)

- All domain service logic (`apps/api/src/modules/*/service.ts`), route
  handling in `app.ts`, crypto (`platform/crypto`), R2 validation
  (`platform/storage/r2.ts`), contracts (`packages/contracts`), admin SPA
  (`apps/admin/src`), SDK examples, integration docs, operations runbooks.
- Drizzle schema (`db/schema/*`) and SQL migrations (`db/migrations/0000`,
  `0001`) — subject to the schema-vs-migration audit (see STATUS.md for
  the findings and any fixes applied).
- `scripts/check-migrations.mjs`, `scripts/validate-repo.mjs`,
  `scripts/lint-repo.mjs`, `scripts/migrate.mjs` — real scripts, kept.

## 6. What was corrected or rewritten

- `apps/api/src/platform/db/drizzle-store.ts` — NEW: production store.
- `apps/api/src/platform/db/store.ts` — in-memory class relabelled
  test-only; `r2Bucket` field widened to the `R2BucketBinding` interface.
- `apps/api/src/modules/identity/better-auth.ts` — real `betterAuth()`.
- `apps/api/src/app.ts` / `apps/api/src/index.ts` — per-request store
  factory, Better Auth mount, fail-closed production wiring.
- `scripts/typecheck.mjs` (new), `scripts/build-all.mjs`,
  `scripts/run-tests.mjs`, `scripts/smoke-check.mjs`,
  `scripts/seed-reference.mjs` (new), `scripts/bootstrap-super-admin.mjs` (new).
- `.github/workflows/ci.yml`, `.github/workflows/deploy-production.yml`.
- `docs/implementation/STATUS.md`, `README.md`, `AGENTS.md` (§4),
  ADR-0002/0004 (merged additions).
- Dependency pins: `@cloudflare/workers-types` → `5.20261115.1`;
  `zod` removed as a direct dependency (see §3).

## 7. Known gaps carried forward (not silently fixed)

- License signing-key material is generated per process (no durable key
  store in the schema — `signing_key_metadata` holds public JWKs only).
  Durable key persistence (signing_keys table or KMS) is an open TODO;
  see `drizzle-store.ts` header and STATUS.md.
- Staff sessions (custom identity service, store `sessions` state) and
  Better Auth sessions (Drizzle `sessions` table) are NOT yet unified.
  The seam is documented in code and STATUS.md.
- No live Postgres was available in this environment at implementation
  time unless the integration-test agent provisioned one; see STATUS.md
  for the exact verification state.
