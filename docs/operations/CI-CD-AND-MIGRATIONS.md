# CI/CD and Database Migration Operations

This runbook defines the repository-side release contract. See [ADR-0002](../decisions/ADR-0002-ci-cd-and-database-migrations.md), [ADR-0004](../decisions/ADR-0004-current-stable-dependency-policy.md), and AGENTS.md.

## Target release flow

`feature branch → pull request checks → reviewed merge to main → production workflow → migration job → Cloudflare deploy → smoke checks`

A deployment is confirmed only by a successful workflow and post-deployment checks.

## Ownership

The coding agent must implement and verify the repository-side GitHub Actions workflows, Cloudflare deployment configuration, migration runner integration, health checks, and setup documentation after the runnable base exists.

The product owner performs first-time Cloudflare account/resource setup, configures protected GitHub Environment secrets/variables, authorizes production deployment, and triggers/approves the first live deployment (or delegates these account-level steps). The agent must never ask for or commit secret values.

## GitHub configuration required

Create separate protected `staging` and `production` GitHub Environments. Store credentials as environment secrets, never in repository files.

Expected values will be finalized after the Worker/Pages deployment targets and database driver are proven. They may include:
- Cloudflare account ID
- Minimum-scope Cloudflare API token for the selected deployment targets
- PostgreSQL/Neon migration connection string (migration-only)
- Public health-check URLs as non-secret variables

Use a separate runtime database identity with only application permissions. Never expose migration credentials to the Worker runtime.

## Migration checklist

- [ ] ORM schema and migration files changed together.
- [ ] Migration generated from the intended schema diff and reviewed as SQL.
- [ ] Migration applies to a clean disposable database.
- [ ] Migration applies to a database representing the previous release.
- [ ] Backfills are bounded, observable, resumable, and tested.
- [ ] Lock duration and table rewrite risk reviewed.
- [ ] Old/new application versions remain compatible during release.
- [ ] Backup/restore readiness checked for risky changes.
- [ ] CI migration consistency check passes.
- [ ] Deployment applies migrations before application code.

## Failure rules

A migration failure blocks deployment. Do not bypass the job or manually mark a failed migration as applied. Inspect partially applied state before retrying. Prefer a corrective forward migration; never automatically reverse production migrations. Remove obsolete columns/tables only after a later compatibility release.

## Current state

This is the target operational contract, not evidence of an active production deployment. The coding agent must complete and test the repository-side implementation. The product owner will supply Cloudflare account configuration and protected GitHub environment values and approve the first live deployment. A live deployment is complete only after the actual workflow and smoke check succeed.
