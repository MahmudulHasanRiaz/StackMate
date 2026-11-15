# CI/CD and Database Migration Operations

This runbook is the operational companion to [ADR-0002](../decisions/ADR-0002-ci-cd-and-database-migrations.md).

## Target release flow

`feature branch → pull request checks → reviewed merge to main → production workflow → migration job → Cloudflare deploy → smoke checks`

A successful merge is the deployment trigger. A green deployment is confirmed only by the workflow and post-deployment checks.

## Required GitHub configuration

Create separate GitHub Environments for `staging` and `production`. Store credentials as environment secrets, never as repository files.

Production secrets/variables will be finalized after the Worker, Pages deployment targets, and database driver are proven. Expected values include:
- Cloudflare account ID
- Cloudflare API token scoped to the required Workers/Pages deployment permissions
- Production PostgreSQL/Neon migration connection string (write-capable, migration-only)
- Public deployment/health-check URLs as non-secret variables

Use a separate runtime database identity with only the permissions required by the application. The migration identity must not be exposed to the Worker runtime.

## Migration release checklist

- [ ] ORM schema and migration files changed together when schema changes.
- [ ] Migration generated from the intended schema diff and reviewed as SQL.
- [ ] Migration applies successfully to a clean disposable database.
- [ ] Migration applies successfully to a database representing the previous release.
- [ ] Data backfills are bounded, observable, resumable, and tested where relevant.
- [ ] Lock duration and table rewrite risk reviewed.
- [ ] Old and new application versions remain compatible during the release.
- [ ] Production backup/restore readiness checked for risky changes.
- [ ] CI migration consistency check passes.
- [ ] Deployment workflow applies migrations before application deployment.

## Failure rules

- A migration failure blocks deployment. Do not bypass the job or manually mark the migration as applied.
- Do not automatically reverse production migrations.
- If a migration partially applied, inspect the database and migration ledger before retrying.
- Prefer a corrective forward migration. Restore from backup only under the incident recovery procedure.
- Do not delete old columns/tables in the same release that stops using them unless a reviewed maintenance plan explicitly allows it.

## Current state

This is a target runbook, not evidence of an active production deployment. StackMate currently has no verified runnable application, production migration, Cloudflare deployment config, or configured GitHub environment secrets. Enable automatic production deployment only after the Stage 0 and deployment-readiness gates are satisfied.
