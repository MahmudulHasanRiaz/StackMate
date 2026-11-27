/**
 * Per-isolate pg connection reuse — B-01 follow-up (2026-11-27).
 *
 * Problem: every request pays a fresh `pg.Client.connect()` (TCP + TLS
 * + Postgres auth to Hyperdrive) before its first query. On staging
 * that handshake is ~0.5–1s of the ~2.5s license-validate / catalog
 * latency, and the targeted queries themselves are already 1 RTT each
 * — the connect is now the largest remaining per-request cost.
 *
 * Design — a single-slot, synchronously-leased connection cache:
 * one idle `pg.Client` per connection string is parked at module
 * scope; the next request on the same isolate leases it instead of
 * connecting. The lease is a plain boolean flipped synchronously
 * (check-and-claim in one synchronous slice, no await between them),
 * so two concurrent requests can never hold the same client: the
 * loser gets a fresh client exactly as before. The owning request
 * releases the lease synchronously in `DrizzleStore.close()` — before
 * its response completes — so the client is always idle when another
 * request claims it.
 *
 * Why this does NOT repeat the 2026-11-15 failure (see
 * `drizzle-store.ts` header note 1): that revert shared one client
 * AND serialized all statements through a module-level promise-chain
 * queue — a queue promise created in request A, awaited in request B,
 * throws under Cloudflare's `handle_cross_request_promise_resolution`
 * flag, and staging went 12/12 failing. This cache stores NO promise
 * at module scope: only the `Client` object and two booleans. Every
 * query promise is created AND awaited inside the single request that
 * holds the lease, exactly as on a fresh client; no request ever
 * awaits a promise created by another request. The per-store
 * `storeQueue` chain stays instance-level for the same reason.
 *
 * Safety properties:
 * - At most one request uses a cached client at a time (lease). A
 *   request that finds the slot busy, dead, or for another
 *   connection string connects fresh — identical to the old path.
 * - A cached client is never in a transaction when leased or parked:
 *   `withTransaction` always COMMITs/ROLLBACKs before returning, and
 *   the lease is held for the whole request, so no other request can
 *   observe mid-transaction state.
 * - Dead-connection handling: `pg` emits `error`/`end` on the client
 *   when its backend goes away (verified locally: server-side
 *   `pg_terminate_backend` fires both, and the socket reports
 *   `destroyed: true` synchronously). Listeners registered when a
 *   client is parked mark it dead; acquire/park also check the socket
 *   state synchronously. A dead entry is discarded (ended) and the
 *   request connects fresh. Residual risk: a half-open connection
 *   (no FIN/RST, no event yet) can fail exactly ONE request with a
 *   connection error — the same failure a fresh connection dying
 *   mid-request has today — and the next request self-heals, because
 *   the failure marks the entry dead. `create()`/`createTargeted()`
 *   additionally retry ONCE on a fresh client when a leased client's
 *   creation-phase queries fail with a connection error.
 * - The `drizzleDb` wrapper is NOT shared: each store builds a fresh
 *   one over the leased client (cheap, no I/O), so no Drizzle
 *   internal state crosses requests. `drizzleDb.$client` is the
 *   leased client, so direct-client users (license heartbeat UPDATE,
 *   Better Auth) reuse it too.
 * - Keyed by exact connection string (same convention as the
 *   capabilities / signing-key caches): different databases never
 *   share. Capped at 8 entries; parking when full evicts the oldest
 *   idle entry.
 *
 * Scope: the request store itself stays per-request (one
 * `DrizzleStore` per request, closed per request) — only the
 * underlying TCP connection is reused. This is a deliberate, narrow
 * exception to `hyperdrive.ts` §2.1 ("never holds a module-scoped
 * TCP connection across Worker requests"): that rule was written for
 * the promise-queue singleton that failed; the lease design above is
 * what makes the exception safe. If the lease ever misbehaves, the
 * rollback is `parkCachedClient` returning false (fresh client per
 * request, old behaviour) — no schema, config, or Hyperdrive change.
 */
import type { Client } from "pg";

interface CachedConnection {
  client: Client;
  /** True while one request holds this client. */
  leased: boolean;
  /** True once `error`/`end` fired, or the socket is observably dead. */
  dead: boolean;
}

/** One idle client per connection string; small on purpose. */
const MAX_ENTRIES = 8;
const entriesByConnectionString = new Map<string, CachedConnection>();

/** Clients that already have the dead-marking listeners attached. */
const listenersAttached = new WeakSet<object>();

function markDead(entry: CachedConnection): void {
  entry.dead = true;
}

function attachDeadListeners(entry: CachedConnection): void {
  if (listenersAttached.has(entry.client)) return;
  listenersAttached.add(entry.client);
  // `error`/`end` are event callbacks, not promises: they never cross
  // the request boundary as an awaited value. `error` MUST have a
  // listener — an `error` event with none throws on the emitter.
  entry.client.on("error", () => markDead(entry));
  entry.client.on("end", () => markDead(entry));
}

function endQuietly(client: Client): void {
  // Fire-and-forget by design: the promise is created here and its
  // rejection handler attached here; no request ever awaits it.
  client.end().catch(() => {});
}

/**
 * Best-effort synchronous liveness check. Reads only the socket
 * state `pg` exposes (`client.connection.stream`); any shape it does
 * not recognise is treated as alive — the `error`/`end` listeners
 * are the backstop, and a missed dead client fails at most one
 * request (see the header).
 */
export function isClientSocketAlive(client: Client): boolean {
  try {
    const stream = (
      client as unknown as {
        connection?: { stream?: { destroyed?: unknown; writableEnded?: unknown; readableEnded?: unknown } };
      }
    ).connection?.stream;
    if (!stream) return true;
    if (stream.destroyed === true) return false;
    if (stream.writableEnded === true) return false;
    if (stream.readableEnded === true) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Synchronously claim the idle client for `connectionString`, or
 * null when there is none, it is leased, dead, or its socket is
 * observably closed. The claim (leased = true) happens in the same
 * synchronous slice as the check, so no concurrent request can claim
 * the same client. A dead entry is removed + ended on the spot.
 */
export function tryAcquireCachedClient(connectionString: string): Client | null {
  const entry = entriesByConnectionString.get(connectionString);
  if (!entry) return null;
  // Leased: another request owns it — never disturb it, even if it
  // has since been marked dead (its owner discards it on close).
  if (entry.leased) return null;
  if (entry.dead || !isClientSocketAlive(entry.client)) {
    entriesByConnectionString.delete(connectionString);
    endQuietly(entry.client);
    return null;
  }
  entry.leased = true;
  return entry.client;
}

/**
 * Park a healthy, freshly-closed store's client as the idle entry
 * for `connectionString`. Returns false (caller must end the client)
 * when the slot is already occupied, the client is dead, or the cache
 * is full and nothing idle could be evicted. Never parks a leased
 * client: only `close()` on a fresh-client store calls this.
 */
export function parkCachedClient(connectionString: string, client: Client): boolean {
  const existing = entriesByConnectionString.get(connectionString);
  if (existing) {
    if (!existing.leased && !existing.dead && isClientSocketAlive(existing.client)) {
      return false;
    }
    entriesByConnectionString.delete(connectionString);
    endQuietly(existing.client);
  }
  if (!isClientSocketAlive(client)) return false;
  if (entriesByConnectionString.size >= MAX_ENTRIES) {
    // Evict the oldest idle entry; if every entry is leased, refuse.
    for (const [key, entry] of entriesByConnectionString) {
      if (!entry.leased) {
        entriesByConnectionString.delete(key);
        endQuietly(entry.client);
        break;
      }
    }
    if (entriesByConnectionString.size >= MAX_ENTRIES) return false;
  }
  const entry: CachedConnection = { client, leased: false, dead: false };
  attachDeadListeners(entry);
  entriesByConnectionString.set(connectionString, entry);
  return true;
}

/** Release a leased client back to idle (or discard it if dead). */
export function releaseCachedClient(client: Client): void {
  for (const [key, entry] of entriesByConnectionString) {
    if (entry.client === client) {
      if (entry.dead || !isClientSocketAlive(client)) {
        entriesByConnectionString.delete(key);
        endQuietly(client);
      } else {
        entry.leased = false;
      }
      return;
    }
  }
  // Not a cached client (defensive): never leak it.
  endQuietly(client);
}

/** Remove a client from the cache and end it (leased-retry path). */
export function discardCachedClient(client: Client): void {
  for (const [key, entry] of entriesByConnectionString) {
    if (entry.client === client) {
      entriesByConnectionString.delete(key);
      endQuietly(client);
      return;
    }
  }
  endQuietly(client);
}

/**
 * End every IDLE cached client and clear the cache. Test/cleanup use
 * only: a backend-counting test needs a hermetic pre-state, and a
 * test-file `afterAll` that drops its database must not leave a
 * parked connection on it (DROP DATABASE refuses while a backend is
 * attached). Leased clients are left alone — their owners release or
 * discard them on close. Never needed on the Worker path: isolates
 * are frozen/discarded by the runtime with their sockets.
 */
export function drainConnectionCache(): void {
  for (const [key, entry] of entriesByConnectionString) {
    if (!entry.leased) {
      entriesByConnectionString.delete(key);
      endQuietly(entry.client);
    }
  }
}

/**
 * True when the failure looks like a dead/broken TCP connection or a
 * rejected connection attempt. Same matcher as the entrypoint's
 * `isConnectionError` (`apps/api/src/index.ts`) — duplicated here
 * because that module imports this one (importing it back would be a
 * cycle). Used only to decide the one leased-client retry inside
 * `DrizzleStore.create()` / `createTargeted()`: a deterministic boot
 * failure (missing table, undecryptable key) must never retry.
 */
export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === "string" &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "ENOTFOUND",
      "EAI_AGAIN",
      "53300",
      "57P01",
      "57P02",
      "57P03",
      "08000",
      "08001",
      "08003",
      "08004",
      "08006",
    ].includes(code)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  // "Client was closed and is not queryable" is pg's error when a
  // leased client was ended out from under its owner (e.g. the test
  // that kills a parked client, or an idle timeout racing a lease).
  // It means the same thing as a dead connection here: discard the
  // client and retry once on a fresh one. The entrypoint's copy of
  // this matcher (index.ts) does not need the clause — a fresh
  // client is never ended before use.
  return /connection (terminated|closed|reset|refused|timed out)|client has encountered a connection error|client was closed and is not queryable|connection error|remaining connection slots|too many (clients|connections)|cannot connect now|server closed the connection|terminating connection/i.test(
    message
  );
}
