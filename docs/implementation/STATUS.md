# StackMate Implementation Status

**Status date:** 15 November 2026  
**Current stage:** Stage 0 — repository and delivery foundation  
**Application status:** No runnable application source scaffold has been verified.

## Foundation and agent handoff

- [x] Product and technical foundation specifications are organized and indexed.
- [x] Root README and AI agent instructions.
- [x] Initial pnpm workspace and TypeScript baseline.
- [x] Admin/API/contracts directory placeholders.
- [x] Database workspace placeholder.
- [x] Environment template and gitignore.
- [x] Workspace package manifests for admin, API, and contracts.
- [x] User-facing date policy: DD/MM/YYYY; ISO 8601 API; UTC timestamp semantics.
- [x] Migration safety and release-order policy.
- [x] Future digital-services marketplace extensibility constraint.
- [x] Current stable/security-patched dependency selection policy (ADR-0004).
- [x] Agent handoff prompt and repository-side CI/CD ownership clarified.

## Work the coding agent must complete

- [ ] Inspect the repository and produce a detailed, evidence-based implementation plan.
- [ ] Build runnable React/Vite admin and Hono Worker source entry points.
- [ ] Verify current stable toolchain/dependency versions against official sources; pin versions and commit lockfile.
- [ ] Add full formatting, lint, typecheck, test, and production build scripts.
- [ ] Prove Neon/Drizzle connectivity, transactions, and migration generation/apply.
- [ ] Add migration drift/consistency checks and tests proving failed migrations block app deployment.
- [ ] Implement repository-side Cloudflare deployment configuration, GitHub Actions release workflow, migration-before-deploy sequencing, smoke checks, and setup documentation.
- [ ] Verify the deployment workflow in a safe test/staging environment where credentials and resources are available.
- [ ] Update status with actual command outputs, test evidence, commit references, and remaining blockers.

## First Cloudflare setup ownership

The coding agent owns the repository-side code, workflows, configuration, tests, and setup instructions. The product owner will perform the first Cloudflare account/resource setup, configure GitHub Environment variables/secrets, authorize production, and trigger/approve the first live deployment (or delegate those account-level steps).

No one should claim that production is live until a real deployment workflow run and post-deployment smoke check succeed. Do not commit or share secret values in source control.

## Technical spikes

- [ ] Neon driver/connection strategy and transaction behavior.
- [ ] Better Auth + Drizzle + Worker runtime.
- [ ] SPA/API origin, cookie, CORS, and CSRF topology.
- [ ] Drizzle migration generation/apply/drift proof.
- [ ] R2 private upload/download proof.
- [ ] Signing-key and request-signing proof.

## Current verification boundary

The repository currently has initial documentation, package placeholders, a repository-validation script, and initial GitHub Actions workflow files. A complete application install/build/test, database migration, Cloudflare deployment, and live smoke check have **not** been verified. Do not mark Stage 0 or production deployment complete based only on the presence of files.

## Next priorities

1. Agent inspects current repository and writes the implementation plan.
2. Agent creates runnable base, verifies current stable dependencies, and commits lockfile.
3. Agent proves database/migrations and completes repository-side CI/CD; product owner then performs first Cloudflare setup and live deployment.
