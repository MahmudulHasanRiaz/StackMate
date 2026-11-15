# Cloudflare Hyperdrive & Neon PostgreSQL Operations Guide

## 1. Architecture Overview

StackMate uses **Cloudflare Hyperdrive** from day one as the connection pooling and read-query caching layer between the Cloudflare Worker (`apps/api`) and **Neon PostgreSQL**.

```
External Sites / WP Plugins / Admin SPA
                 │
                 ▼
     Cloudflare Worker (Hono API)
       ├── env.HYPERDRIVE_NO_CACHE  ──► Direct consistency (Auth, RBAC, Orders, Payments,
       │                                Subscriptions, Licenses, Idempotency, Outbox)
       └── env.HYPERDRIVE_CACHED    ──► Read-cached public catalog (max_age=60s, swr=15s)
                 │
                 ▼
     Neon PostgreSQL (Primary Source of Truth)
       ▲
       └── Direct Admin Connection (DIRECT_DATABASE_URL) ──► CI/CD DDL Migrations ONLY
```

## 2. Driver & ORM Compatibility

Per official Cloudflare Hyperdrive documentation:
- **Supported Driver**: `node-postgres` (`pg >= 8.16.3`) paired with `drizzle-orm/node-postgres`.
- **Unsupported Driver**: `postgres` (`Postgres.js`) with Drizzle ORM over Hyperdrive is **not supported** by Cloudflare and must not be used.
- **Required Worker Flag**: `"compatibility_flags": ["nodejs_compat"]` in `apps/api/wrangler.jsonc`.
- **Connection Scoping**: Because Cloudflare Workers isolate request contexts, every request instantiates its `pg.Pool` / `pg.Client` using `env.HYPERDRIVE_NO_CACHE.connectionString` (or `env.HYPERDRIVE_CACHED.connectionString`) inside the request lifecycle and releases it upon completion.

## 3. Dual Hyperdrive Binding Strategy (Cache Safety Policy)

Hyperdrive caches read queries at the wire protocol level and **does not automatically invalidate cached reads when writes occur**. To prevent stale authorization or financial double-spend bugs, StackMate binds two Hyperdrive configurations pointing to the same Neon database:

| Binding Name | Caching Mode | Allowed Queries |
| :--- | :--- | :--- |
| `HYPERDRIVE_NO_CACHE` | `--caching-disabled` | Authentication, sessions, RBAC, orders, coupons, manual payment submissions, payment verification, subscriptions, licenses, idempotency locks, audit logs, webhook outbox, and all `INSERT`/`UPDATE`/`DELETE` transactions. |
| `HYPERDRIVE_CACHED` | `--caching-enabled --max-age=60 --swr=15` | Public, unauthenticated product/plan/price catalog queries (`GET /api/v1/public/sites/:siteKey/catalog`) where up to 60 seconds of staleness is acceptable. |

### Provisioning Commands

```bash
# 1. Create the uncached primary Hyperdrive binding (used for all writes & sensitive reads)
npx wrangler hyperdrive create stackmate-db-no-cache \
  --connection-string="postgres://user:password@ep-example.ap-southeast-1.aws.neon.tech/stackmate?sslmode=require" \
  --caching-disabled

# 2. Create the cached Hyperdrive binding (used strictly for public catalog reads)
npx wrangler hyperdrive create stackmate-db-cached \
  --connection-string="postgres://user:password@ep-example.ap-southeast-1.aws.neon.tech/stackmate?sslmode=require" \
  --caching-enabled \
  --max-age=60 \
  --swr=15
```

Update the resulting Hyperdrive IDs in `apps/api/wrangler.jsonc`.

## 4. Transaction & Locking Discipline Under Hyperdrive Transaction Pooling

Hyperdrive pools connections in **transaction mode**:
1. Never issue session-level `SET` statements outside a `BEGIN ... COMMIT` block expecting them to persist across queries.
2. Never use session-level PostgreSQL advisory locks (`pg_advisory_lock`); always use transaction-scoped locks (`pg_advisory_xact_lock`) or explicit row-level locking (`SELECT ... FOR UPDATE` / `FOR UPDATE SKIP LOCKED`) inside an explicit database transaction (`withTransaction()`).
3. Keep transactions short and deterministic. Never perform external HTTP requests (such as Meta CAPI calls or outbound webhooks) while holding a database transaction open—insert an `outbox_events` row inside the transaction and dispatch it asynchronously via the outbox worker.

## 5. Cloudflare Plan Limits & Operational Monitoring

- **Workers Free Plan**: Hyperdrive allows **100,000 queries per day** (resets daily at `00:00 UTC`), counting both cached and uncached `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and `DDL` statements.
- **Workers Paid Plan ($5/month)**: Hyperdrive includes **unlimited queries** at no additional per-query cost.
- **Production Recommendation**: Use Workers Paid plan before onboarding high-frequency WordPress plugin license heartbeat traffic.
