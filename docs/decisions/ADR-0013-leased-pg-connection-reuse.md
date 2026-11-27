# ADR-0013: Per-isolate leased pg connection reuse (B-01 follow-up)

- **Status:** Proposed (owner-ordered 2026-11-27: OD-02 p95<1s stays, Free plan only, no Paid escape hatch; OD-03 best way even if harder to develop, reuse with a proper ADR solving the cross-request-promise constraint; targeted queries alone will not reach p95<1s — reuse is the path, done the right way. Implementation in the working copy, unpushed, pending owner acceptance.)
- **Date:** 2026-11-27
- **Decision owners:** Product owner / Engineering
- **Related specifications:** ADR-0005 (Hyperdrive + driver, §2.1); audit-2026-11-25 fix plan B-01 (which states any store-reuse-across-requests design needs a new ADR first); API spec (latency target p95<1s, staging ~2s/call at audit time).

## Context

B-01 (audit #2 Critical, 2026-11-25) was the structural perf ceiling: every request loaded the entire database. The targeted-query phase (2026-11-26) replaced the combined full-state load with 1-query targeted reads on the hot paths (license validate 6→1 query, public catalog 7→1 query). Measured live on staging 2026-11-27, license validate is still ~2.48s and public catalog ~2.07s (baseline 3.3–4.1s). p95<1s is NOT met. The remaining per-request cost on a targeted route is:

- ~0.6s Worker overhead with no DB work at all (GET /health median 0.567s, staging, 2026-11-26 — the reason for this is not yet decomposed; see Follow-up work).
- A fresh `pg.Client.connect()` per request — TCP + TLS + Postgres auth to Hyperdrive, ~0.5–1s on staging.
- ~4 sequential query round-trips at ~250ms each on staging (signing-key fingerprint 1 + rate-limit upsert 1 + targeted read 1 + heartbeat UPDATE 1, license validate).

The connect is the largest single removable chunk, and it is removable only by reusing a connection across requests within a Worker isolate. That is exactly what failed catastrophically on 2026-11-15: the Batch 0 fix held ONE pg Client per isolate as a module-level singleton and serialized all statements through a per-client promise-chain queue (`clientQueues`). A queue promise created in request A and awaited in request B throws under Cloudflare's `handle_cross_request_promise_resolution` flag ("This promise was created by a request that has since ended, so it can never settle"), and staging went from ~10% failures to 12/12 store-dependent calls failing (live Worker logs 2026-11-15 22:11–22:15 +06, including the owner's own sign-in attempts). The revert (ADR-0005 evening amendment) went back to a fresh client per request. Any reuse design must solve that constraint properly, not work around it — and must do so on the Free plan (OD-02: no Paid Workers, no Paid quota relief).

## Decision drivers

- Correctness and security: never repeat a 12/12 outage; a reuse bug must fail at most one request and self-heal.
- Runtime compatibility: the `handle_cross_request_promise_resolution` flag is the hard constraint; safety must be provable without a live staging experiment.
- Latency: p95<1s on the Free plan, with no paid-tier escape hatch.
- Cost and usage limits: Free plan — Hyperdrive 100k queries/day (B-10), capped backend connections; idle connections are a real budget.
- Operational complexity / reversibility (owner rollback rule): single-purpose, reversible; rollback must be a one-line change, not a migration.
- Portability: the same code runs on Docker/VPS Postgres (no Cloudflare-only mechanism).

## Options considered

### Option A — Single-slot synchronous-lease connection cache (CHOSEN)

One idle `pg.Client` per connection string parked at module scope (`apps/api/src/platform/db/connection-cache.ts`); the next request on the same isolate leases it instead of connecting. The lease is a plain boolean flipped synchronously (check-and-claim in one synchronous slice, no await between them), so two concurrent requests can never hold the same client: the loser connects fresh, exactly as before. The owning request releases the lease synchronously in `DrizzleStore.close()`, before its response completes, so the client is always idle when another request claims it. A fresh-client store parks its client on close when the slot is free. Dead clients are discarded (see Decision). The store itself stays per-request — only the TCP connection is shared. `drizzleDb` is built fresh per store over the leased client (cheap, no I/O).

Advantages: the safety property is provable by reading the code — the module holds NO promise at module scope (only the Client object + booleans), and no request ever awaits a promise created by another request, because every query promise is created and awaited inside the single request holding the lease. Graceful degradation: under concurrency it falls back to today's proven path. Minimal backend footprint on the Free plan (at most one idle connection per isolate per connection string). No new service, binding, config, migration, or dependency. Reversible by making `parkCachedClient` return false. Evidence: local pg probe (server-side `pg_terminate_backend` fires `error`/`end` and the socket reports `destroyed: true` synchronously); 6 new tests prove lease identity, concurrent-distinctness, dead-client discard, and keying; HTTP probe through the real entrypoint, local: cold license-validate 126.6ms vs warm median 7.7ms (see Verification evidence).

Disadvantages: one idle backend lingers per isolate (exactly one, idle, never in a transaction — pinned by the updated 1101 tests); a half-open connection (no FIN/RST, no event yet) can fail exactly one request, which then self-heals; does NOT by itself reach p95<1s (see Consequences).

### Option B — Module-scope `pg` Pool (the conventional Node best practice)

A `new Pool({ max: N })` at module scope; each store checks a client out at creation and returns it at close. This is the standard answer on plain Node, and its waiter promises are created in the waiting request (arguably flag-safe). REJECTED as the first step, on merit, not on familiarity: the Pool's internal bookkeeping (wait queue, idle-timeout timers, connection-creation promises, error propagation) is promise/callback machinery whose cross-request behavior under the flag is UNVERIFIED locally — Node has no such flag — and the only verification is a live staging experiment that risks repeating the 12/12 outage the owner already lived through. The lease (Option A) needs no such experiment because its safety is structural, not empirical. The Pool also costs N idle backends per isolate on a Free plan with capped connections, and queued checkouts couple concurrent requests' latency. Revisit trigger below.

### Option C — No reuse; parallelize the per-request queries only

Run the independent per-request queries concurrently (signing-key fingerprint ∥ rate-limit upsert ∥ targeted read) on a fresh connection. REJECTED as the path (owner OD-03 accepts targeted queries alone will not reach p95<1s): it saves at most ~2 RTTs (~0.5s) while leaving the ~0.5–1s connect untouched, and it requires restructuring the middleware chain (store creation precedes rate-limit by architecture), which is a larger blast radius than the lease for a smaller win. Kept as follow-up work AFTER reuse (the two compose: reuse removes the connect, parallelization removes RTTs).

### Option D — Multi-slot lease (N idle clients per connection string)

Same lease mechanism with N slots. REJECTED for now: it only helps requests that arrive concurrently on one isolate while a slot is free, and each extra slot costs a permanent idle backend per isolate on the Free plan. The measured bottleneck is warm-sequential traffic (one client validating, one site serving catalog), which a single slot already covers. Revisit on evidence that concurrent single-isolate traffic dominates.

### Option E — Durable Objects / KV / Queue-backed pooling

REJECTED: AGENTS.md §4 forbids new optional services without measured need and an accepted ADR, and none of them holds a TCP connection anyway — a DO would add a network hop per query, not remove one.

## Decision

Adopt Option A, precisely:

1. `apps/api/src/platform/db/connection-cache.ts` (new, ~270 lines) holds `Map<string, { client, leased, dead }>` keyed by exact connection string (same convention as the capabilities / signing-key caches), capped at 8 entries. It exports `tryAcquireCachedClient` (synchronous claim), `parkCachedClient`, `releaseCachedClient`, `discardCachedClient`, `drainConnectionCache` (test/cleanup use only), and `isConnectionError` (same matcher as `apps/api/src/index.ts`, duplicated to avoid an import cycle, plus the `Client was closed` clause that only a leased client can produce).
2. `DrizzleStore.create()` / `createTargeted()` lease when free, else connect fresh exactly as before. A leased client whose creation-phase queries fail with a connection error is discarded and creation retries ONCE on a fresh client (the retry's acquire finds the entry gone, so it cannot re-lease the same client and cannot loop); any other creation failure releases a healthy leased client back to the cache. `close()` releases the lease synchronously (leased client) or parks the fresh client when the slot is free, else ends it as before.
3. Dead detection: `error`/`end` listeners registered when a client is parked mark it dead (a listener is mandatory — an `error` event with none throws on the emitter); acquire/park also check the socket state synchronously (`connection.stream.destroyed / writableEnded / readableEnded`). A dead entry is removed + ended, never re-leased. `drizzleDb` is fresh per store; `drizzleDb.$client` is the leased client, so direct-client users (license heartbeat UPDATE, Better Auth) reuse it too.
4. Invariants, pinned by tests: at most one request uses a cached client at a time; a cached client is never in a transaction when leased or parked (`withTransaction` always COMMITs/ROLLBACKs before returning, and the lease is held for the whole request); the per-store `storeQueue` chain stays instance-level — across stores sharing one leased client, serialization is the lease.
5. `hyperdrive.ts` §2.1 ("never holds a module-scoped TCP connection across Worker requests") gains a narrow documented exception pointing at this ADR: that rule was written for the promise-queue singleton that failed; the lease is what makes the exception safe. Hyperdrive config and the migration policy are untouched (no schema change, no new migration).

## Consequences

### Positive

- Removes the ~0.5–1s connect from every warm-isolate request (the largest remaining per-request chunk after targeted queries). Local proof: fresh connect median 4.6–5.5ms vs warm targeted create 0.9–1.2ms; license-validate through the real entrypoint 126.6ms cold vs 7.7ms warm median.
- No new service, binding, config, migration, or dependency; no Hyperdrive change; Docker/VPS behavior identical (lease is driver-level).
- Reversible: `parkCachedClient` returning false restores per-request clients exactly.
- Test pins updated to the new contract instead of deleted: sequential requests open exactly ONE pg connection (counting proxy); concurrent requests hold distinct backends; exactly ONE idle backend lingers; `close()` parks instead of ending (perf-regression); `afterAll` DROP DATABASE drains the cache first (general-settings).

### Negative / trade-offs

- One idle backend lingers per isolate per connection string (idle, never in a transaction). On the Free plan this is the cheapest possible footprint for reuse (Option B/D cost more).
- Residual half-open risk: a connection that dies without FIN/RST or an event can fail exactly one request with a connection error — the same failure a fresh connection dying mid-request has today — and the next request self-heals (the failure marks the entry dead). The creation-phase leased retry covers the case where the first use is inside `create()`/`createTargeted()`; for targeted routes without `loadSigningKey` there is no creation-phase query, so the first use is in middleware — still one request, still self-healing.
- Does NOT by itself reach p95<1s on staging (OD-02). Arithmetic on the measured staging inputs (license validate 2.48s = ~0.6s no-DB overhead + ~0.5–1s connect + ~4×~250ms sequential RTTs): reuse removes the connect, leaving ~0.6s overhead + ~1.0s of sequential RTTs ≈ ~1.6s. The gap is owned by the 4 sequential RTTs and the undecomposed ~0.6s overhead (see Follow-up work). No paid tier is assumed or needed for this step; the gap is closed by follow-up work, not by quota relief. Free-plan query budget is unchanged by reuse (Hyperdrive 100k/day counts queries, not handshakes — ~4–5 queries per license validation either way), so volume headroom is unchanged.
- `close()` no longer ends the client in the common case: test cleanups that DROP DATABASE must drain the cache first (new `drainConnectionCache` export); a plain Node process holding a parked client will not exit on its own (vitest workers are terminated by the runner; the probe script had to be run under vitest for this reason).

### Follow-up work

- [ ] Live staging re-measure after push (parent): license validate + public catalog p95 on warm isolates; confirm the connect chunk is gone and record the residual.
- [ ] Decompose the ~0.6s no-DB overhead (health 0.567s with no store): cold-isolate spin-up vs per-request Hono app construction (`buildHonoApp` per request registers ~180 routes) vs TLS. Do not assert a cause without a measurement.
- [ ] Parallelize the independent per-request queries (signing-key fingerprint ∥ rate-limit upsert ∥ targeted read) and/or move the heartbeat UPDATE off the critical path — the remaining ~0.5s of RTTs after reuse.
- [ ] Revisit Option B (Pool) only if a live experiment proves flag-safety AND measurements show concurrent single-isolate traffic dominating; revisit Option D (multi-slot) only on the same evidence.

## Verification evidence

- Local pg behavior probe (2026-11-27, Node script against local Postgres 16): connect ~5–20ms vs single query ~0.5ms; server-side `pg_terminate_backend` fires `error` ("Connection terminated unexpectedly") + `end`, socket reports `destroyed: true` synchronously; concurrent queries on one client queue correctly (pg internal serialization).
- New tests `apps/api/test/b01-connection-reuse.test.ts` 6/6: sequential targeted stores share one client; open store holds the lease (concurrent create gets a different client); sequential full `create()` reuses; dead parked client discarded, next store works on fresh; different connection-string spellings do not share; warm targeted create median 0.87–1.15ms vs fresh connect median 4.6–5.5ms.
- Temporary HTTP probe (deleted after use) through the real entrypoint, local Postgres: license validate (401 path) cold 126.6ms (includes first-ever signing-key bootstrap on the empty probe DB) vs warm median 7.7ms, min 6.5ms, 10/10 sequential.
- Updated pins: `worker-1101-repro.test.ts` (sequential = exactly 1 handshake; concurrent = distinct backends; exactly one idle lingering backend), `perf-regression.test.ts` (close parks; next store leases the same client), `general-settings.test.ts` (drain before DROP DATABASE).
- **Full verify 2026-11-27:** vitest **645/645, 72 files** (was 639/639 + 6 new); tsc api exit 0, tsc admin exit 0. No push, no deploy, no production change (this track only).
- Note on the local environment: the VM lost its Postgres install mid-task (system paths reset; home persisted). Postgres 16 was reinstalled from the apt cache, `stackmate_test` recreated, migrations 0000–0026 re-applied before verification. Staging was not touched; live staging re-measure is owed after the parent pushes.

## Revisit trigger

- A live staging 1101 / cross-request-promise error attributable to the cache (revert to per-request clients by making `parkCachedClient` return false; the pins above will catch it first).
- Evidence that concurrent single-isolate traffic dominates (revisit Option B/D), or that the idle-backend footprint matters on the Free plan (revisit: park only when the isolate is warm / shorten idle lifetime).
- The ~0.6s overhead decomposition changing the residual arithmetic (revisit the p95 plan, not this ADR's mechanism).
