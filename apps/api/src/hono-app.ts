/**
 * Hono app composition (Hono migration Phase 0/1, Worker 1 — Foundation).
 *
 * This is the composition root for the whole backend: ONE Hono app that
 * every HTTP request enters through (plan §2). It wires, in order:
 *
 *   0. env seeding (composition, NOT a Worker-3 middleware): `c.var.env`
 *      is set from the factory deps before anything else runs, so the
 *      middleware chain and the route handlers can read the resolved
 *      bindings without re-resolving them per request.
 *   1. requestId → 2. securityHeaders → 3. cors → 4. csrfGate →
 *      5. authContext → 6. rateLimit → 7. requestStore
 *      (all from `apps/api/src/middleware/`, Worker 3 — one file per
 *      concern, composed by `middlewareChain(env, storeFactory)`).
 *   8. `registerAllRoutes(app)` — all REST route modules (Worker 2/2b)
 *      plus `registerGraphQLRoutes(app)` — POST /api/v1/graphql, admin
 *      reads only, queries only, additive (Worker 4, Phase 2). The
 *      auth fallback catch-all registers last inside registerAllRoutes.
 *
 * `createHonoApp` mirrors `createStackMateApp` (apps/api/src/app.ts):
 * the app takes resolved `env` + a `storeFactory` and resolves a
 * request-scoped store per request — there is deliberately NO
 * module-level app and NO shared store here, same as the Worker
 * entrypoint (`apps/api/src/index.ts`).
 *
 * Accepted call shapes (all three are used):
 * - `createHonoApp({ env, storeFactory })` — the production shape
 *   (Worker entrypoint); env + factory both explicit.
 * - `createHonoApp(store)` — a `StackMateDataStore` instance; the
 *   factory returns it. This is the fallback shape the Phase-0
 *   route-conformance test uses (Worker 5).
 * - `createHonoApp()` — no args; test env (`APP_ENV: "test"`, dev
 *   defaults) + a fresh in-memory store per request. This is the
 *   first shape the conformance test tries. Never use it in
 *   production: it has no Hyperdrive binding and no real secrets.
 *
 * The returned Hono app IS the Cloudflare Worker fetch handler:
 * `app.fetch(request, env, ctx)` — `src/index.ts` (or its Hono
 * successor) hands the Worker `fetch` event straight to it.
 * `app.routes` lists every registered route (method + path) for the
 * Phase-0 route-conformance test (Worker 5).
 *
 * Middleware wiring: the chain is one call —
 * `app.use(...middlewareChain(env, storeFactory))` — so the factory
 * (env, storeFactory) is shared by every middleware that may open the
 * store (`authContext`, `rateLimit`, `requestStore`). `requestStore`
 * is a factory; `middlewareChain` calls it with the fixed env +
 * factory. See `apps/api/src/middleware/index.ts`.
 *
 * Behaviour preserved from the hand-rolled `fetchHandler` (app.ts):
 * - Unknown route → 404 `NOT_FOUND` error envelope, message
 *   `Route '<METHOD> <pathname>' not found.` (same string app.ts uses
 *   for the disabled bootstrap endpoint, so a prober cannot tell a
 *   missing route from a disabled one).
 * - Unhandled error → the standard error envelope; `AppError` keeps its
 *   own code/status/details, anything else is 500 `INTERNAL_ERROR`
 *   with a generic message (no internals leaked).
 * - Every envelope carries the request id in `meta`/`error.request_id`.
 */
import { Hono } from "hono";
import { createErrorEnvelope } from "../../../packages/contracts/src/index.ts";
import { resolveRuntimeConfig, type StackMateBindings } from "./env.ts";
import { StackMateDataStore } from "./platform/db/store.ts";
import type { StackMateStoreFactory } from "./app.ts";
import type { AppEnv } from "./types/context.ts";
import { middlewareChain, onErrorHandler } from "./middleware/index.ts";
import { registerAllRoutes } from "./routes/index.ts";

export type { AppEnv } from "./types/context.ts";

export interface CreateHonoAppDeps {
  /** Resolved Worker bindings (from `resolveRuntimeConfig`). */
  env: StackMateBindings;
  /**
   * Per-request store factory — same type `createStackMateApp` takes
   * (`app.ts`): `(env, ctx?) => Promise<StackMateDataStore>`.
   * Worker entrypoint passes a factory that builds a fresh DrizzleStore
   * per request; tests pass one returning the in-memory store.
   */
  storeFactory: StackMateStoreFactory;
}

export interface CreateHonoAppWithStoreDeps {
  /** Resolved Worker bindings (from `resolveRuntimeConfig`). */
  env: StackMateBindings;
  /**
   * Injected store (adopted, never closed by the Hono chain — its
   * lifetime belongs to its owner). Used by `createStackMateApp` in
   * injected-store mode so the resolved env is honoured (the
   * bare-store shape `createHonoApp(store)` uses the default test env).
   */
  store: StackMateDataStore;
}

/**
 * Normalize the three accepted `createHonoApp` call shapes into the
 * one pair the composition needs. Fail-closed: an unrecognized shape
 * throws with the accepted shapes named, instead of serving with a
 * half-wired app (undefined env / factory).
 */
function normalizeDeps(deps?: CreateHonoAppDeps | CreateHonoAppWithStoreDeps | StackMateDataStore): {
  env: StackMateBindings;
  storeFactory: StackMateStoreFactory;
  /**
   * The injected store, when one was given. `createHonoApp` seeds it
   * into `c.var.store` BEFORE the middleware chain, so
   * `ensureRequestStore` ADOPTS it (owned=false, never closed) —
   * exactly like the old `fetchHandler`'s injected-store mode. Without
   * this the factory wrapper (`async () => store`) makes the middleware
   * treat the shared store as factory-owned and close it after the
   * first request — which kills a DrizzleStore (its pg connection is
   * closed; every later request throws "DrizzleStore is closed").
   * That is the bug that made every Postgres integration test fail
   * after the first request once the live path was wired to Hono.
   */
  adoptedStore?: StackMateDataStore;
} {
  const defaultEnv = (): StackMateBindings =>
    resolveRuntimeConfig({ APP_ENV: "test" });
  if (deps === undefined) {
    return {
      env: defaultEnv(),
      storeFactory: async () => new StackMateDataStore(),
    };
  }
  if (deps instanceof StackMateDataStore) {
    const store = deps;
    return {
      env: defaultEnv(),
      storeFactory: async () => store,
      adoptedStore: store,
    };
  }
  if ("storeFactory" in deps && typeof deps.storeFactory === "function") {
    return {
      env: deps.env ?? defaultEnv(),
      storeFactory: deps.storeFactory,
    };
  }
  if ("store" in deps && deps.store instanceof StackMateDataStore) {
    const store = deps.store;
    return {
      env: deps.env ?? defaultEnv(),
      storeFactory: async () => store,
      adoptedStore: store,
    };
  }
  throw new Error(
    "createHonoApp() takes no arguments, a StackMateDataStore, or " +
      "{ env, storeFactory } — received an unrecognized argument."
  );
}

export function createHonoApp(): Hono<AppEnv>;
export function createHonoApp(store: StackMateDataStore): Hono<AppEnv>;
export function createHonoApp(deps: CreateHonoAppDeps): Hono<AppEnv>;
export function createHonoApp(deps: CreateHonoAppWithStoreDeps): Hono<AppEnv>;
export function createHonoApp(
  deps?: CreateHonoAppDeps | CreateHonoAppWithStoreDeps | StackMateDataStore
): Hono<AppEnv> {
  const { env, storeFactory, adoptedStore } = normalizeDeps(deps);
  const app = new Hono<AppEnv>();

  // 0. Env seeding — see header. Must run before the chain: cors/CSRF,
  // authContext and rateLimit all read trusted origins / secrets / the
  // store factory's env from `c.var.env`.
  // An injected (adopted) store is seeded here too, so
  // `ensureRequestStore` adopts it (owned=false, never closed) instead
  // of treating it as factory-owned and closing it after the first
  // request (which kills a DrizzleStore — see normalizeDeps).
  app.use("*", async (c, next) => {
    c.set("env", env);
    if (adoptedStore) {
      c.set("store", adoptedStore);
    }
    await next();
  });

  // 1–8. Middleware chain, in the contract order (Worker 3,
  // `apps/api/src/middleware/`): requestId → securityHeaders → cors →
  // csrfGate → authContext → twoFactorGate → rateLimit → requestStore.
  // The chain is one call so the factory (env, storeFactory) is shared
  // by every middleware that may open the store.
  app.use(...middlewareChain(env, storeFactory));

  // 8. All REST routes (Worker 2/2b) + GraphQL (Worker 4, Phase 2 —
  // registered inside registerAllRoutes, last-but-one before the auth
  // fallback catch-all).
  registerAllRoutes(app);

  // Unknown route: same 404 envelope + message shape as app.ts.
  app.notFound((c) => {
    const requestIdValue = c.var.requestId ?? "unknown";
    return c.json(
      createErrorEnvelope(
        "NOT_FOUND",
        `Route '${c.req.method} ${c.req.path}' not found.`,
        requestIdValue
      ),
      404
    );
  });

  // Unhandled error: the faithful port of app.ts's handleRequest catch
  // block (Worker 3, `middleware/error-handler.ts`) — AppError keeps
  // its code/status, SchemaValidationError → 422, anything else is 500
  // INTERNAL_ERROR with a generic message (no internals leaked).
  app.onError(onErrorHandler);

  return app;
}
