# StackMate Implementation Plan

**Status:** Draft — execution agent must refine after inspecting the live repository and environment.  
**Current phase:** Stage 0 — Repository foundation.

## 1. Repository inspection

- [ ] Confirm current branch, remote, clean/dirty state, and default branch.
- [ ] Confirm Node.js and pnpm versions available in the target development environment.
- [ ] Confirm repository tree matches Repository Structure specification.
- [ ] Confirm no secrets or user work would be overwritten.

## 2. Stage 0 tasks

- [ ] Select and pin Node/pnpm/toolchain versions.
- [ ] Add admin app package and minimal React/Vite entry point.
- [ ] Add API package and minimal Hono Worker entry point.
- [ ] Add contracts package and package exports.
- [ ] Add Drizzle configuration and schema/migration entry points after Neon driver spike.
- [ ] Add lint, format, typecheck, unit-test, and build tooling.
- [ ] Add CI workflow.
- [ ] Verify clean install and all workspace checks.
- [ ] Update README with commands that were actually tested.

## 3. Mandatory technical spikes

- [ ] Neon driver vs Hyperdrive and transaction behavior.
- [ ] Better Auth + Drizzle + Worker compatibility.
- [ ] SPA/API origin, cookies, CORS, CSRF, and trusted origins.
- [ ] R2 private upload and authorized read.
- [ ] Migration workflow and transaction rollback.
- [ ] Signing key and server request-signing design.

## 4. Work log

Add dated entries with commit references, changed paths, test evidence, decisions, and blockers. Do not mark a task complete without evidence.

## 5. Acceptance criteria

Stage 0 is complete only when the workspace installs from its lockfile, all root checks pass, CI is green, no secrets are committed, and the runtime-sensitive assumptions are documented rather than guessed.
