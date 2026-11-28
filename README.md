# StackMate

StackMate is a centralized, production-grade SaaS commerce, manual payment verification, subscription lifecycle, software/WordPress licensing, external website integration, and server-side Meta Conversions API (CAPI) tracking platform.

## Architecture Overview

| Layer | Technology |
| :--- | :--- |
| **Admin Application** | React + Vite + TypeScript SPA (`apps/admin`) |
| **Backend API** | Hono + TypeScript on Cloudflare Workers (`apps/api`) |
| **Database Connection Layer** | Cloudflare Hyperdrive (`HYPERDRIVE_NO_CACHE` + `HYPERDRIVE_CACHED`) |
| **Primary Database** | PostgreSQL on Neon (`db/schema`, `db/migrations`) |
| **ORM & Driver** | Drizzle ORM (`drizzle-orm/node-postgres`) + `pg >= 8.16.3` (`nodejs_compat`) |
| **Authentication & RBAC** | Genuine Better Auth (`betterAuth()` + Drizzle adapter, `pg`) + 5-role granular RBAC |
| **Object Storage** | Private Cloudflare R2 (`R2_BUCKET`) for payment proof attachments — fail-closed in staging/production without a real bucket |
| **Async Reliability** | PostgreSQL-backed transactional outbox (`outbox_events`) with lease locking & DLQ |
| **Shared Contracts** | `@stackmate/contracts` (`packages/contracts`) |

## Key Engineering Guarantees

1. **Cloudflare Hyperdrive From Day One**: Dual Hyperdrive bindings ensure zero stale reads on authentication, sessions, RBAC, orders, manual payment verification, subscriptions, and licensing (`HYPERDRIVE_NO_CACHE`), while enabling safe edge query caching (`HYPERDRIVE_CACHED`) strictly for public catalog reads.
2. **Technology-Agnostic External Websites vs. WordPress Product Licensing**:
   - External marketing websites (Astro, Next.js, React, WordPress, custom stacks) integrate via `/api/v1/public/sites/:siteKey/*` and HMAC-signed `/api/v1/integrations/sites/:siteKey/*`.
   - WordPress plugins (`wordpress_plugin`) and themes (`wordpress_theme`) are first-class sellable product types licensed centrally via `/api/v1/licenses/*` (`activate`, `validate`, `deactivate`, `signing-keys`) alongside `licensed_software`, `saas_application`, `dedicated_deployment`, and `digital_service`.
3. **Manual Payment Verification & Atomic Fulfillment**: Supports Bangladesh & international manual payment methods (`bKash`, `Nagad`, `Rocket`, `Upay`, `Bank Transfer`) with private R2 proof validation, duplicate transaction ID protection, and atomic approval transactions that provision customer accounts, subscriptions, and one-time license keys in a single lock-safe unit of work.
4. **Verified-Only Meta Conversions API (CAPI)**: `Purchase` and `Subscribe` conversion events are emitted exclusively after a manual payment submission is verified and approved—never on unverified proof submission or rejected payments.
5. **Date & Currency Standards**: All user-facing dates use `DD/MM/YYYY` (`Asia/Dhaka` default) while API wire payloads and PostgreSQL columns use UTC ISO 8601 (`TIMESTAMPTZ`). All monetary values use integer minor units (`BDT` poisha, exponent `2`).

## Quick Start & Verification Commands

> Package manager is **pnpm** (v10.6.1; `pnpm install --frozen-lockfile`).
> Honest implementation status lives in `docs/implementation/STATUS.md` —
> run the commands below and trust their output, not the stage labels in
> older docs.

```bash
# 1. Validate repository governance, ADR index, and required structure
pnpm run validate:repo

# 2. Verify SQL migrations and Drizzle schema consistency (63 tables, migrations 0000-0003)
pnpm run db:check

# 3. Preview forward-only database migrations
pnpm run db:migrate -- --dry-run

# 4. Run static code & security lint checks
pnpm run lint

# 5. Run real TypeScript typechecking (tsc --noEmit, all packages)
pnpm run typecheck

# 6. Run the full test suite (vitest). The DrizzleStore integration tests
#    run against a real Postgres ONLY when DATABASE_URL is set, and skip
#    otherwise — they never fake-pass.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test pnpm test

# 7. Build all packages, API Worker bundle, and Admin SPA
pnpm run build

# 8. Run API smoke check
pnpm run smoke:api
```
