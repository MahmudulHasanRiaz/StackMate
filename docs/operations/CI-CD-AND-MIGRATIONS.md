# CI/CD and Database Migrations Operations Runbook

## 1. Core Principles

1. **Forward-Only Expand-Contract Migrations**: Every schema change must be committed as a deterministic SQL migration in `db/migrations/*.sql` tracked in `db/migrations/meta/_journal.json`.
2. **Never Run `drizzle-kit push` in Production**: Schema pushing is strictly prohibited in staging and production environments (`ADR-0002`).
3. **Runtime vs. Migration Connection Split (`ADR-0005`)**:
   - **Runtime Worker Traffic**: Always connects through Cloudflare Hyperdrive (`env.HYPERDRIVE_NO_CACHE` and `env.HYPERDRIVE_CACHED`).
   - **Schema Migrations**: Always run in CI/CD prior to Worker deployment using the direct, non-pooled Neon PostgreSQL administrative URL (`DIRECT_DATABASE_URL`) so DDL advisory locks and transactional schema updates are not affected by Hyperdrive transaction pooling.

## 2. Deployment Order of Operations

Every production release follows a strict four-stage gate in `.github/workflows/deploy-production.yml`:

1. **Pre-Deployment Verification Gate (`verify`)**:
   - `npm run validate:repo`
   - `npm run db:check`
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
2. **Database Migration Gate (`migrate-db`)**:
   - Verifies point-in-time recovery / Neon branch snapshot readiness.
   - Runs `npm run db:migrate` against `DIRECT_DATABASE_URL`.
3. **API Worker Deployment (`deploy-api`)**:
   - Deploys `apps/api` to Cloudflare Workers with `HYPERDRIVE_NO_CACHE`, `HYPERDRIVE_CACHED`, and `R2_BUCKET` bindings.
   - Runs `npm run smoke:api`.
4. **Admin SPA Deployment (`deploy-admin`)**:
   - Deploys `apps/admin` only after the API and database migrations have succeeded.

## 3. Rollback & Recovery Procedure

- **Application Rollback**: If a newly deployed Worker or Admin SPA exhibits errors, roll back the Cloudflare Worker deployment immediately. Because all migrations follow the **expand-contract** pattern, the previous Worker version remains compatible with the expanded schema.
- **Database Recovery**: Never run destructive down-migrations on production financial, order, subscription, or license tables. Write a forward corrective migration or restore from the pre-deployment Neon branch snapshot.
