import { createStackMateApp } from "./app.ts";
import {
  resolveRuntimeConfig,
  type StackMateBindings,
  type WorkerExecutionContext,
} from "./env.ts";
import { DrizzleStore } from "./platform/db/drizzle-store.ts";
import { isTargetedOnlyRoute } from "./platform/db/targeted-routes.ts";
import type { StackMateDataStore } from "./platform/db/store.ts";

/**
 * Worker entrypoint: everything is built per request from the env bindings.
 * There is deliberately NO module-level app and NO in-memory store here.
 *
 * Fail-closed order: env is resolved FIRST. In staging/production
 * resolveRuntimeConfig throws without HYPERDRIVE_NO_CACHE (or without the
 * required secrets) and that throw propagates — the request is never served
 * from a silent in-memory fallback.
 *
 * The per-request store is a DrizzleStore backed by the Hyperdrive
 * uncached connection string (see apps/api/src/platform/db/drizzle-store.ts).
 * The license signing private JWK is forwarded when configured; the
 * signing keys themselves are durable (signing_keys table, migration
 * 0004) and the envelope-encryption secret is forwarded below, so a
 * Worker boot decrypts the stored keys instead of generating a
 * per-process key. Without ENCRYPTION_KEY_V1 the store fails closed
 * at boot (see DrizzleStore.resolveEncryptionSecret).
 *
 * Store creation is REQUEST-SCOPED (revert, 2026-11-15 evening — the
 * ADR-0005 pre-recorded revert path): every request creates a fresh pg
 * Client, connects, runs the combined single-statement load, and the
 * store is closed when the request finishes (see
 * apps/api/src/app.ts closeRequestStore). NOTHING is stored at module
 * scope — no shared client, no promise queue, no cached promise.
 *
 * Why the revert: the Batch 0 perf fix held ONE pg Client per isolate
 * as a module-level singleton and serialized all statements through a
 * per-client promise-chain queue. A queue promise created in request A
 * and awaited in request B throws under Cloudflare's
 * handle_cross_request_promise_resolution flag ("This promise was
 * created by a request that has since ended, so it can never settle"),
 * and staging went from ~10% failures to 12/12 store-dependent calls
 * failing with it (live Worker logs, 2026-11-15 22:11–22:15 +06 —
 * including the user's own sign-in attempts). The combined
 * single-statement load and the caps/tables plain-value cache are
 * KEPT, so a request is still ~7 round-trips (~1.75s predicted on
 * staging at ~250ms RTT) instead of the original ~55 (~13–35s).
 * This restores compliance with hyperdrive.ts §2.1 ("Never holds a
 * module-scoped TCP connection across Worker requests").
 */
/**
 * B-01: `path` is the request pathname, forwarded by the factory
 * (`ensureRequestStore` → factory third arg). When the path is
 * allowlisted (`platform/db/targeted-routes.ts`), the request gets a
 * targeted store — `DrizzleStore.createTargeted`, which connects
 * WITHOUT the combined full-state load (state holds only seed rows;
 * handlers must use targeted methods). `loadSigningKey` comes from
 * the allowlist entry (license validation needs the signing key to
 * sign entitlement tokens; a principal lookup does not).
 *
 * Every other path gets `DrizzleStore.create(opts)` EXACTLY as
 * before, including the connection-error retry below — no behaviour
 * change for non-allowlisted routes. The targeted branch has no
 * outer retry: `createTargeted` already retries the connect itself
 * (`connectWithRetry`) and there is no load phase after connect
 * whose failure the retry would cover (capability/table checks and
 * signing-key resolution are deterministic boot failures).
 *
 * Exported for tests (`test/b01-foundation.test.ts` drives the
 * factory decision directly); the Worker entrypoint uses it via the
 * `storeFactory` below.
 */
export async function createRequestStore(
  env: StackMateBindings,
  path?: string
): Promise<StackMateDataStore> {
  const connectionString = env.HYPERDRIVE_NO_CACHE.connectionString;
  const opts = {
    connectionString,
    r2Bucket: env.R2_BUCKET ?? null,
    signingKeyId: env.LICENSE_SIGNING_KEY_ID,
    signingPrivateJwk: env.LICENSE_SIGNING_PRIVATE_JWK,
    signingPublicJwk: env.LICENSE_SIGNING_PUBLIC_JWK,
    encryptionSecret: env.ENCRYPTION_KEY_V1,
    appEnv: env.APP_ENV,
  };
  const targeted = path ? isTargetedOnlyRoute(path) : null;
  if (targeted) {
    return DrizzleStore.createTargeted({
      ...opts,
      loadSigningKey: targeted.loadSigningKey,
    });
  }
  try {
    return await DrizzleStore.create(opts);
  } catch (error) {
    // One retry on a connection-like failure, with a fresh client
    // (DrizzleStore.create always opens its own). Any other failure
    // (missing tables, undecryptable keys, bad config) propagates
    // unchanged — retrying a deterministic boot failure would only
    // fail twice. The connect-phase retry (53300 etc.) lives inside
    // DrizzleStore.create; this retry covers connection-like failures
    // from the load/signing-key phase after a successful connect.
    if (!isConnectionError(error)) throw error;
    return DrizzleStore.create(opts);
  }
}

/**
 * True when the failure looks like a dead/broken TCP connection OR a
 * rejected connection attempt. Besides the TCP errno family, PostgreSQL
 * error codes that mean the connection could not be established or was
 * lost: 53300 too_many_connections ("remaining connection slots…"),
 * 57P03 cannot_connect_now (Neon compute waking/refusing), 08000/08001/
 * 08003/08004/08006 connection_exception family, 57P01/57P02 admin/crash
 * shutdown.
 *
 * Staging 2026-11-15: ~10% of /me (25% under 20-way concurrency) came
 * back as Cloudflare 1101 — an uncaught throw from store creation. The
 * load-phase retry only matched TCP-style errors, so a 53300/57P03
 * connect rejection propagated as the opaque 1101 instead of retrying
 * once on a fresh connection. That matcher is kept (broadened here);
 * the 1101s themselves turned out to be the cross-request promise
 * flag (see the header note) and are fixed by the request-scoped
 * revert, not by this retry.
 */
function isConnectionError(error: unknown): boolean {
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
  return /connection (terminated|closed|reset|refused|timed out)|client has encountered a connection error|connection error|remaining connection slots|too many (clients|connections)|cannot connect now|server closed the connection|terminating connection/i.test(
    message
  );
}

function createRequestApp() {
  return createStackMateApp({
    // B-01: forward the request path the factory receives as its
    // third arg (`StackMateStoreFactoryOptions.path`, set by
    // `ensureRequestStore`) so `createRequestStore` can decide
    // targeted vs full-load per route.
    storeFactory: async (factoryEnv, _ctx, factoryOpts) =>
      createRequestStore(factoryEnv, factoryOpts?.path),
  });
}

export default {
  async fetch(
    request: Request,
    env: Partial<StackMateBindings>,
    ctx: WorkerExecutionContext
  ): Promise<Response> {
    const resolvedEnv = resolveRuntimeConfig(env);
    const app = createRequestApp();
    return app.fetch(request, resolvedEnv, ctx);
  },
  async scheduled(
    event: { cron?: string; scheduledTime?: number },
    env: Partial<StackMateBindings>,
    ctx: WorkerExecutionContext
  ): Promise<void> {
    const resolvedEnv = resolveRuntimeConfig(env);
    const app = createRequestApp();
    await app.scheduled(event, resolvedEnv, ctx);
  },
};

export { createStackMateApp };
