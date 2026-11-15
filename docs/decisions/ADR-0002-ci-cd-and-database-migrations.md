# ADR-0002: CI/CD and Database Migration Safety

- **Status:** Accepted
- **Date:** 15 November 2026
- **Decision owners:** StackMate product and engineering

## Context

Every accepted change to `main` should be eligible for automatic production deployment. Database changes must never be separated from their corresponding application release or silently omitted.

## Decision

### Branch and validation flow

- Pull requests run required validation: formatting, lint, typecheck, unit/integration tests, build, dependency/security checks, and migration consistency checks as those scripts become available.
- Direct pushes to `main` are discouraged; protect `main` with required checks and review. A push/merge to `main` triggers the production workflow.
- GitHub Actions uses least-privilege permissions, pinned action revisions where practical, concurrency control, and protected GitHub Environments/secrets.
- No production credential is stored in Git, repository files, build artifacts, or client-side environment variables.

### Release order

1. Checkout the exact commit and install from the committed lockfile using frozen-lockfile mode.
2. Run the complete validation and production build.
3. Verify the migration set and migration history.
4. Apply backward-compatible database migrations to the production database using a dedicated migration identity.
5. Deploy the API Worker and admin application from the same commit.
6. Run post-deployment health/smoke checks and publish the deployment result.

The production workflow must fail closed: missing credentials, missing migration configuration, failed checks, or failed migrations must stop the release. Never deploy application code after a failed migration step.

### Migration invariants

- Every schema change must include a committed, reviewed, ordered migration in the same change set.
- CI must fail when the ORM schema and committed migration state are inconsistent.
- Production deploys must apply pending migrations automatically; migrations are not a later manual task.
- Never use schema push/sync commands against production.
- Never edit a migration that has already been applied to a shared environment. Add a new corrective migration.
- Use expand-and-contract changes: add compatible structures first, deploy code that can work with old and new structures, backfill safely, then remove obsolete structures in a later release only after compatibility is proven.
- Avoid destructive DDL and long table locks in the normal automatic release path. Such changes require an explicit staged plan, impact review, backup/restore readiness, and an approved maintenance procedure.
- Use a single controlled migration job with a database-level migration lock/advisory lock where supported. Do not run migrations concurrently from every Worker instance.
- Migration scripts must be deterministic, idempotent where feasible, observable, and safe to retry after partial failure. A failed migration requires investigation; do not mark it applied manually to bypass the failure.
- Take/verify backups and define recovery objectives before production data becomes valuable. Application rollback does not imply database rollback.

### Deployment and recovery

- Keep staging and production databases, R2 buckets, Worker environments, and credentials separate.
- Use immutable commit/build identifiers and retain deployment metadata.
- Configure health checks and a documented rollback/forward-fix procedure.
- Prefer rolling application code back only when it remains compatible with the migrated schema. Database rollback is not automatic.
- Use deployment concurrency so a newer release cannot race an in-progress release. Cancel obsolete queued deployments, not an active migration.
- A failed post-deploy smoke test must alert and trigger the documented recovery process.

## Consequences

The current repository is not yet deployable: runnable apps, migrations, lockfile, Cloudflare configuration, and credentials still need to be added. This ADR defines the release contract; the workflow must not pretend to deploy until those prerequisites exist.

## Validation gates

Before enabling production deployment:
- Prove Drizzle migration generation, review, and apply against a disposable PostgreSQL database.
- Prove the selected Neon connection method and transaction behavior in the Worker runtime.
- Add migration drift checks and a migration failure test.
- Configure Cloudflare API token with minimum required permissions and account ID as GitHub environment secrets.
- Configure production environment protection and smoke-test URLs.
- Verify a failed migration prevents application deployment.
