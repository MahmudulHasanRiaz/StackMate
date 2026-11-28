/**
 * StackMate Central API — composition root (Hono migration wiring).
 *
 * This file is COMPOSITION ONLY (~200 lines). All HTTP routing lives
 * in the Hono app (`./hono-app.ts` + `./routes/`), all middleware in
 * `./middleware/`, all cron jobs in `./scheduled.ts`. Nothing here
 * handles a route, a service, or a query.
 *
 * Wiring (the point of this file):
 * - `createStackMateApp` keeps the exact contract the Worker
 *   entrypoint (`./index.ts`) and the tests use: `{ store, fetch,
 *   scheduled }`, with `storeFactory` mode (fresh DrizzleStore per
 *   request) or injected-store mode.
 * - `fetch` resolves env fail-closed per request, answers the A-10
 *   early paths (GET /health, /ready, /setup-status) WITHOUT opening
 *   a store, then delegates to the Hono app (`createHonoApp`) by
 *   default. The Hono middleware chain owns the request-store
 *   lifecycle (open lazily, close in `requestStore`'s `finally`) —
 *   this file never closes a Hono-path store itself, so there is no
 *   double-close.
 * - Rollback flag (temporary): `HONO_ENABLED=0` / `false` in env
 *   falls back to the pre-Hono handler (`./app-legacy.ts`, the old
 *   7,952-line app.ts preserved verbatim). Default is Hono ON.
 *   Delete app-legacy.ts + the flag after the Hono path is
 *   live-verified.
 * - `scheduled` (cron) does NOT go through Hono — it resolves env +
 *   store, runs `./scheduled.ts` (`runScheduledJobs`), and closes a
 *   factory-created store in `finally`, exactly like the old
 *   `handleScheduled`.
 */
import { randomUUID } from "node:crypto";
import {
  createSuccessEnvelope,
} from "../../../packages/contracts/src/index.ts";
import {
  isHonoEnabled,
  resolveRuntimeConfig,
  type StackMateBindings,
  type WorkerExecutionContext,
} from "./env.ts";
import { StackMateDataStore } from "./platform/db/store.ts";
import { isSuperAdminProvisioned } from "./modules/identity/service.ts";
import { buildStandardHeaders } from "./middleware/shared.ts";
import { createHonoApp } from "./hono-app.ts";
import { createStackMateApp as createLegacyStackMateApp } from "./app-legacy.ts";
import { runScheduledJobs, type ScheduledJobResult } from "./scheduled.ts";

/**
 * Per-request store factory: builds (or returns) the store for one request
 * from the already-resolved env. Used by the Worker entrypoint so every
 * request gets a fresh DrizzleStore instead of a module-level shared store.
 *
 * B-01: the factory MAY receive the request pathname in `opts.path`
 * (`ensureRequestStore`, `middleware/shared.ts`, passes `c.req.path`).
 * The Worker entrypoint's factory (`apps/api/src/index.ts`
 * `createRequestStore`) uses it to decide between a full-load store
 * (`DrizzleStore.create`) and a targeted store
 * (`DrizzleStore.createTargeted`) for allowlisted routes (see
 * `platform/db/targeted-routes.ts`). The third arg is optional and
 * backward compatible — existing factories (tests, injected-store
 * wrappers) that ignore it keep working unchanged, and callers that
 * have no request path (cron: `handleScheduled` below) simply omit it
 * and always get a full-load store.
 */
export interface StackMateStoreFactoryOptions {
  /** The request pathname (e.g. "/api/v1/public/catalog"), when known. */
  path?: string;
}

export type StackMateStoreFactory = (
  env: StackMateBindings,
  ctx?: WorkerExecutionContext,
  opts?: StackMateStoreFactoryOptions
) => Promise<StackMateDataStore>;

export interface StackMateAppInstance {
  /**
   * The construction-time store, when the app was built with an injected
   * (or default in-memory) store. `null` in `storeFactory` mode: there is
   * no single store — one is resolved per request via the factory.
   */
  readonly store: StackMateDataStore | null;
  fetch(
    request: Request,
    rawEnv?: Partial<StackMateBindings>,
    ctx?: WorkerExecutionContext
  ): Promise<Response>;
  scheduled(
    event: { cron?: string; scheduledTime?: number },
    rawEnv?: Partial<StackMateBindings>,
    ctx?: WorkerExecutionContext
  ): Promise<ScheduledJobResult>;
}

export function createStackMateApp(
  existingStore?: StackMateDataStore
): StackMateAppInstance;
export function createStackMateApp(options: {
  storeFactory: StackMateStoreFactory;
}): StackMateAppInstance;
export function createStackMateApp(
  existingStoreOrOptions?: StackMateDataStore | { storeFactory: StackMateStoreFactory }
): StackMateAppInstance {
  const storeFactory =
    existingStoreOrOptions && "storeFactory" in existingStoreOrOptions
      ? existingStoreOrOptions.storeFactory
      : undefined;
  const injectedStore = storeFactory
    ? undefined
    : ((existingStoreOrOptions as StackMateDataStore | undefined) ??
      new StackMateDataStore());

  /**
   * Resolve the store for one request. In `storeFactory` mode the factory
   * decides (Worker entrypoint: fresh DrizzleStore per request). Otherwise
   * the construction-time injected/default store is returned.
   */
  async function resolveRequestStore(
    env: StackMateBindings,
    ctx?: WorkerExecutionContext
  ): Promise<StackMateDataStore> {
    if (storeFactory) return storeFactory(env, ctx);
    if (!injectedStore) {
      throw new Error("No data store is configured for this request.");
    }
    return injectedStore;
  }

  /**
   * End a factory-owned (per-request) store's resources. Only the
   * DrizzleStore owns anything closeable (its request-scoped pg
   * Client); the in-memory store has no dispose/close and this is a
   * no-op for it. Called only for storeFactory mode, where the factory
   * created the store for this request — an injected store's lifetime
   * belongs to its owner and is never closed here. Never throws: a
   * close failure must not mask the request's response (or the cron
   * result).
   */
  async function closeRequestStore(store: StackMateDataStore): Promise<void> {
    const dispose = (
      store as unknown as { dispose?: () => Promise<void> }
    ).dispose;
    if (typeof dispose === "function") {
      await dispose.call(store).catch(() => {});
    }
  }

  /** Build the Hono app for this request's resolved env. */
  function buildHonoApp(env: StackMateBindings) {
    if (storeFactory) return createHonoApp({ env, storeFactory });
    // Injected-store mode: injectedStore is always defined here
    // (createStackMateApp defaulted it when no factory was given).
    return createHonoApp({ env, store: injectedStore! });
  }

  /** Lazily build the pre-Hono (legacy) app — only when the rollback flag is off. */
  let legacyApp: StackMateAppInstance | undefined;
  function getLegacyApp(): StackMateAppInstance {
    if (!legacyApp) {
      legacyApp = storeFactory
        ? createLegacyStackMateApp({ storeFactory })
        : createLegacyStackMateApp(injectedStore!);
    }
    return legacyApp;
  }

  /**
   * Fetch entrypoint: env is resolved FIRST and fail-closed — in
   * staging/production resolveRuntimeConfig throws without
   * HYPERDRIVE_NO_CACHE (and without required secrets), and that throw
   * propagates here instead of ever serving from a silent in-memory store.
   * The A-10 early paths answer before any store resolution; everything
   * else delegates to the Hono app (default) or the legacy handler
   * (HONO_ENABLED=0/false only).
   */
  async function fetchHandler(
    request: Request,
    rawEnv?: Partial<StackMateBindings>,
    ctx?: WorkerExecutionContext
  ): Promise<Response> {
    const env = resolveRuntimeConfig(rawEnv);
    const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const trustedOrigins = env.TRUSTED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const originHeader = request.headers.get("Origin");
    const earlyUrl = new URL(request.url);
    const earlyPathname = earlyUrl.pathname.replace(/\/+$/, "") || "/";
    const earlyMethod = request.method.toUpperCase();
    const earlyResponse = (data: unknown, status = 200) =>
      new Response(JSON.stringify(createSuccessEnvelope(data, requestId)), {
        status,
        headers: buildStandardHeaders(requestId, originHeader, trustedOrigins),
      });

    // A-10: /health and /ready answer BEFORE any store resolution —
    // the cheapest, most-polled endpoints used to pay a full store
    // creation (~10 pg queries + a fresh connect) for a one-bit answer.
    if (
      earlyMethod === "GET" &&
      (earlyPathname === "/api/v1/health" || earlyPathname === "/api/v1/ready")
    ) {
      return earlyResponse({
        status: "ok",
        service: "stackmate-api",
        environment: env.APP_ENV,
        default_currency: env.DEFAULT_CURRENCY,
        default_timezone: env.DEFAULT_TIMEZONE,
        hyperdrive: {
          uncached_binding_configured: Boolean(env.HYPERDRIVE_NO_CACHE?.connectionString),
          cached_binding_configured: Boolean(env.HYPERDRIVE_CACHED?.connectionString),
        },
        timestamp: new Date().toISOString(),
      });
    }
    if (earlyMethod === "GET" && earlyPathname === "/api/v1/setup-status") {
      try {
        let provisioned: boolean;
        if (!storeFactory && injectedStore) {
          provisioned = await isSuperAdminProvisioned(injectedStore);
        } else {
          const { Client } = await import("pg");
          const probe = new Client({
            connectionString: env.HYPERDRIVE_NO_CACHE.connectionString,
          });
          try {
            await probe.connect();
            const res = await probe.query(
              "SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key = 'super_admin') AS provisioned"
            );
            provisioned = res.rows[0]?.provisioned === true;
          } finally {
            await probe.end().catch(() => {});
          }
        }
        return earlyResponse({ setup_required: !provisioned });
      } catch {
        // Fall through to the normal (Hono / legacy) path below.
      }
    }

    // Rollback flag (temporary): HONO_ENABLED=0/false serves the
    // pre-Hono handler. Default is Hono ON.
    if (!isHonoEnabled(env)) {
      return getLegacyApp().fetch(request, env, ctx);
    }

    // Hono path: the middleware chain owns the request-store lifecycle
    // (open lazily, close in requestStore's finally), so this handler
    // never closes the store itself — no double-close.
    // NOTE: ctx is NOT forwarded to Hono's fetch — no route or
    // middleware uses c.executionCtx / waitUntil, and Hono's
    // ExecutionContext requires a `props` field our minimal
    // WorkerExecutionContext does not carry. The fetch signature
    // still accepts ctx for contract compatibility.
    const honoApp = buildHonoApp(env);
    return honoApp.fetch(request, env);
  }

  /**
   * Cron entrypoint: does NOT go through Hono (not an HTTP request).
   * Resolves env + store, runs the scheduled jobs, closes a
   * factory-created store in `finally` (the await is load-bearing —
   * see scheduled.ts).
   */
  async function handleScheduled(
    event: { cron?: string; scheduledTime?: number },
    rawEnv?: Partial<StackMateBindings>,
    ctx?: WorkerExecutionContext
  ): Promise<ScheduledJobResult> {
    const env = resolveRuntimeConfig(rawEnv);
    const store = await resolveRequestStore(env, ctx);
    try {
      return await runScheduledJobs(store, env);
    } finally {
      if (storeFactory) await closeRequestStore(store);
    }
  }

  return {
    store: injectedStore ?? null,
    fetch: fetchHandler,
    scheduled: handleScheduled,
  };
}
