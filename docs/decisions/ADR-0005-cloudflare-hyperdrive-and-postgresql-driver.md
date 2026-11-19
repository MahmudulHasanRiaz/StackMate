# ADR-0005: Cloudflare Hyperdrive, PostgreSQL Driver Selection, and Query Caching Strategy

- **Status:** Accepted (amended 2026-11-15 — per-isolate client reuse; see Amendment below)
- **Date:** 15 November 2026
- **Decision owners:** StackMate product and engineering
- **Related specifications:** PRD §2.3, §2.4; TAD §7.3, §17.3; Database Design §21; Security & Threat Model §4.1, §4.4

## Context

StackMate runs its backend API on Cloudflare Workers with Neon PostgreSQL as the primary database and Drizzle ORM as the query and schema layer. The product owner has mandated using **Cloudflare Hyperdrive from day one** for connection pooling and supported query caching between Cloudflare Workers and Neon PostgreSQL.

At the same time:
1. Cloudflare Workers prohibit sharing open TCP sockets (`pg.Pool` / `pg.Client`) across distinct incoming requests at module scope ([Better Auth Cloudflare Guide](https://better-auth.com/docs/guides/cloudflare)).
2. Official Cloudflare Hyperdrive documentation explicitly warns that pairing Drizzle ORM with `postgres.js` over Hyperdrive is not supported and mandates using `node-postgres` (`pg` `> 8.16.3`) with the `nodejs_compat` compatibility flag ([Cloudflare Hyperdrive Drizzle ORM Docs](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)).
3. Hyperdrive caches eligible read-only (`SELECT`) queries by default (`max_age = 60s`, `stale_while_revalidate = 15s`) and **does not purge or invalidate cached read results on writes** ([Cloudflare Hyperdrive Query Caching Docs](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)). Serving authentication sessions, RBAC permissions, order status, payment verification queues, or license activations from a cached Hyperdrive binding would introduce severe security and financial consistency bugs.

## Decision

1. **Driver & ORM Selection:** Use `drizzle-orm/node-postgres` with `pg` (`>= 8.16.3`, pinned at `^8.20.0`) and `"compatibility_flags": ["nodejs_compat"]`, `"compatibility_date": "2026-11-15"` in `apps/api/wrangler.jsonc`.
2. **Dual Hyperdrive Bindings (Cache-Disabled Default + Cached Read Binding):**
   - `HYPERDRIVE_NO_CACHE`: Configured with `--caching-disabled`. Used as the **authoritative default connection** for all authentication, session lookup, RBAC permission resolution, admin mutations and reads-after-write, order creation, manual payment submission and approval, subscription periods, license activation/validation, idempotency checks, and transactional outbox processing.
   - `HYPERDRIVE_CACHED`: Configured with Hyperdrive query caching enabled (`max_age = 60s`, `stale_while_revalidate = 15s`). Used **exclusively** for explicitly opt-in, staleness-tolerant read queries (such as public product catalog listings `/api/v1/public/sites/:siteKey/products` and historical dashboard aggregate summaries). If `HYPERDRIVE_CACHED` is not bound in an environment, the database factory safely falls back to `HYPERDRIVE_NO_CACHE`.
3. **Request-Scoped Connection Lifecycle (SUPERSEDED 2026-11-15 — see Amendment below):**
   - Never instantiate a global `Client` or `Pool` at module scope in the Worker.
   - Inside each request context, `createRequestDatabaseContext(env, ctx)` lazily creates a request-scoped `pg.Client` (or single-connection pool) connected to `env.HYPERDRIVE_NO_CACHE.connectionString` (and optionally `env.HYPERDRIVE_CACHED.connectionString` when a cacheable public read is requested), and registers `ctx.waitUntil(client.end())` after request completion so connections are cleanly returned to Hyperdrive's edge transaction pool.
4. **Interactive Transactions & Row Locking:**
   - Multi-statement business operations (`ApprovePayment`, `RejectPayment`, `CreateOrder`, `ActivateLicense`, `RenewSubscription`, `ClaimOutboxBatch`) run inside `db.transaction(async (tx) => { ... })` on the `HYPERDRIVE_NO_CACHE` client.
   - Because Hyperdrive operates in transaction pooling mode, all statements between `BEGIN` and `COMMIT`/`ROLLBACK` (including `SELECT ... FOR UPDATE` and `FOR UPDATE SKIP LOCKED`) execute on the same pinned backend PostgreSQL connection.
   - Never perform external HTTP calls (Meta CAPI, outbound webhooks, email APIs, R2 uploads) inside a `db.transaction()` block.
5. **Migration Connection Separation:**
   - Database migrations (`pnpm run db:migrate:deploy`) run in CI/CD before `wrangler deploy` using a direct Neon PostgreSQL connection string (`DATABASE_MIGRATION_URL`, with `pg_try_advisory_lock`) rather than through Hyperdrive's transaction pooler.
6. **Plan Limits & Operational Headroom:**
   - Per [Cloudflare Hyperdrive Pricing Docs](https://developers.cloudflare.com/hyperdrive/platform/pricing/), the Workers Free plan limits Hyperdrive to **100,000 queries/day** (counting both cached and uncached queries and mutations, resetting at `00:00 UTC`), whereas the Workers Paid plan includes **Unlimited** Hyperdrive queries at no extra cost.
   - Because two Hyperdrive configurations (`HYPERDRIVE_NO_CACHE` and `HYPERDRIVE_CACHED`) each maintain their own connection pool against Neon, configure origin pool sizes so their combined `max_size` stays comfortably below Neon's `max_connections` limit, leaving headroom for migrations and administrative access.

## Amendment 2026-11-15 — per-isolate client reuse (supersedes Decision §3)

**Evidence.** Staging measured 13–35s per request (health ≈13–14s three times back-to-back; setup-status 20–35s). Root cause: every request opened a fresh `pg` Client + connect + capability detection + table checks + a ~48-query sequential full-state load, and every transaction repeated the lock + full load. At ~250ms Hyperdrive→Neon round-trip, ~55 queries/request ≈ 13s. A fresh client per request is therefore not viable for this store design.

**New rule.** One lazy singleton `pg` Client per Worker isolate, held at module scope in `apps/api/src/index.ts` (keyed by connection string; each isolate holds its own — isolates never share a client). The per-request `DrizzleStore` stays fresh (fresh in-memory state, fresh signing-key handles) and receives the shared client as `existingClient`; it never connects, ends, or owns it. The client is evicted on `error`/`end`/connect failure, and `createRequestStore` retries ONCE on connection-like errors after eviction. All statements on a shared client are serialized through a per-client promise queue (`clientQueues` in `drizzle-store.ts`); capability detection and required-table checks are memoized per client (rejected checks evict, never poison). The combined single-statement state load (`buildLoadStateQuery`, 48 `json_agg` columns) cuts a request from ~55 queries to ~6 steady-state (setup-status 106 → 10 pg queries/request, asserted ≤15 by `apps/api/test/perf-regression.test.ts`); at ~250ms RTT that predicts ~2.5s/request, down from 13–35s.

**Why this is safe enough.** The connection string is Hyperdrive's (the TCP peer is Hyperdrive's edge pool, not Neon directly). A frozen isolate holding a stale socket is the known failure mode and is handled by eviction + one retry. Better Auth queries bypass the per-client queue (documented residual risk in `drizzle-store.ts`: a BA query inside another request's open transaction sees that snapshot; a BA session insert lost to a concurrent rollback just means re-sign-in; BA never writes business tables). No cross-isolate sharing exists.

**Revert condition.** If the singleton causes stale-connection incidents in staging/production, revert to request-scoped clients while KEEPING the combined load + caps cache (predicted ~7 RTTs/request ≈ 1.75s). Truly fast (<300ms) needs store reuse across requests, not just client reuse — a separate future decision.

## Amendment 2026-11-15 (evening) — revert to request-scoped clients (supersedes the per-isolate amendment above)

**Trigger — the revert condition fired the same evening.** Staging failure rate on store-dependent calls climbed through the day (10% → 25% under concurrency → 12/12 failed 22:11–22:15 +06, including the owner's own sign-in attempts, all surfacing in the SPA as "The data store is temporarily unavailable"). Cloudflare Real-time Logs showed one error on every failure: `[stackmate] store creation failed` + `Error: This promise was created by a request that has since ended, so it can never settle. With the handle_cross_request_promise_resolution compatibility flag, a promise can only settle in the request that created it, and settling it after that request ends is dropped.` Stack: `DrizzleStore.acquireQueue → DrizzleStore.create → createRequestStore → fetchHandler`. The per-client promise-chain queue (`clientQueues`) is the mechanism: a queue promise created in request A and awaited in request B can never settle once A ends. As isolates warmed up, more requests hit poisoned warm isolates — the rate climbed with warmth, which is why the fix measured fine at 19:53 and broke later in the evening. The bare 1101s seen by curl earlier (7/30 on `/me`) are believed to be the same poisoned chain escaping as an unhandled rejection; the revert should fix both.

**New rule.** Request-scoped clients (the pre-Batch-0 shape): `DrizzleStore.create()` opens its own fresh `pg` Client, and the entrypoint closes the store when the request finishes (`closeRequestStore` in `apps/api/src/app.ts`, `storeFactory` mode only — fetch and scheduled/cron both). No module-level client, no promise queue, no module-scope promise of any kind. The `existingClient` option and `clientQueues`/`acquireQueue` are deleted. Capability detection and required-table checks stay cached, now as resolved plain values keyed by connection string (never a promise, never awaited from module scope); a failed detection is never cached. The combined single-statement state load is unchanged.

**Retries kept.** Connect-phase retry ONCE on ANY error now lives inside `DrizzleStore.create` (`connectWithRetry`; the 53300 fake-proxy recovery test still pins it), and the entrypoint retries `create()` once on connection-like failures from the load/signing-key phase. The JSON 500 `STORE_UNAVAILABLE` envelope in `fetchHandler` is unchanged, and `resolveRuntimeConfig` failures still throw (deployment errors stay loud).

**Cost.** ~7 round-trips/request (≈1.75s predicted on staging at ~250ms RTT), as the original revert condition predicted — slower than the singleton's ~2.5s-measured-but-poisoned path, correct instead of fast-but-broken. Truly fast (<300ms) still needs store reuse across requests, a separate future decision that must solve the cross-request promise constraint first (e.g. no shared promise chains at all, or a different driver).

## Consequences

- Zero cross-request I/O violations in Cloudflare Workers.
- Immediate read-after-write consistency for all security, auth, financial, and licensing operations via `HYPERDRIVE_NO_CACHE`.
- Sub-millisecond edge query caching for high-traffic public catalog reads on external landing pages via `HYPERDRIVE_CACHED`.
