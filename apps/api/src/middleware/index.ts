/**
 * Middleware barrel + chain (Hono migration, Worker 3).
 *
 * This file is a FAITHFUL port of the cross-cutting pipeline that used
 * to live inside `createStackMateApp` / `handleRequest` / `fetchHandler`
 * in `apps/api/src/app.ts` (baseline feat `e382d65`). NO behaviour is
 * changed here — only the form: each pipeline step is a Hono middleware
 * `(c, next) => ...` on the shared `AppEnv` context
 * (`types/context.ts`), one file per concern under
 * `apps/api/src/middleware/` (owner rule: no file over ~500 lines,
 * no god file).
 *
 * Source map (every rule cites the app.ts line it was copied from):
 * - `requestId` — app.ts `handleRequest` ~L612-625.
 * - `buildStandardHeaders` — app.ts ~L416-444.
 * - `corsHandler` — app.ts OPTIONS block ~L674-694 + the CORS part of
 *   `buildStandardHeaders`.
 * - `csrfGate` — app.ts `assertSameSiteCookieMutation` ~L643-671.
 * - `authContext` — app.ts admin-block auth resolution ~L2988-2999
 *   (`storeSupportsBetterAuth` + `getBetterAuth` ~L505-545 +
 *   `resolveStaffPrincipal`), WITHOUT the admin block's 401/2FA/rate-limit
 *   steps (those belong to routes / `twoFactorGate` / `rateLimit`).
 * - `twoFactorGate` — app.ts admin block ~L3005-3021 (the 2FA-setup
 *   gate: restricted principal + non-/me admin path → 403
 *   TWO_FACTOR_SETUP_REQUIRED). Runs after `authContext` (needs the
 *   principal) and before `rateLimit` (app.ts threw the gate before
 *   the admin bucket).
 * - `rateLimit` — app.ts per-route-class `store.checkRateLimit` calls:
 *   auth ~L1318, licenses ~L2073, public ~L2149, tracking ingest
 *   ~L2628-2629, integrations ~L2640, admin ~L3024.
 * - `requestStore` — app.ts `fetchHandler` ~L7824-7949
 *   (`resolveRequestStore` / `closeRequestStore` ~L455-474 + the
 *   `finally` at ~L7930-7940, incl. C-10 fallback-client close).
 * - `rbac` — `assertStaffPermissionAudited` from
 *   `modules/identity/service.ts` (the variant every admin route in
 *   app.ts uses, e.g. ~L3233) with `assertStaffPermission` as fallback.
 * - `onErrorHandler` — app.ts `handleRequest` catch block ~L7595-7640.
 *
 * Store-lifecycle note (why `authContext`/`rateLimit` can run BEFORE
 * `requestStore` in the chain): in app.ts the store was resolved in
 * `fetchHandler` BEFORE `handleRequest` ran auth/rate-limiting, but the
 * chain order below puts `requestStore` last. To keep that order AND
 * preserve behaviour, the store is opened lazily by the first middleware
 * that needs it (`ensureRequestStore` in `middleware/shared.ts` —
 * idempotent, one store per request) and `requestStore()` owns the close
 * in its `finally`. If an earlier middleware throws before
 * `requestStore` runs, that middleware's own `finally` closes the store
 * instead (ownership flag), so a 429/401-path never leaks a pg Client.
 * A store that Worker 1 pre-seeded into `c.var.store` (injected-store
 * mode) is adopted, never closed — exactly like app.ts, where only a
 * `storeFactory`-created store is closed.
 */
import type { MiddlewareHandler } from "hono";
import type { StackMateBindings } from "../env.ts";
import type { StackMateStoreFactory } from "../app.ts";
import type { AppEnv } from "../types/context.ts";
import { defaultStoreFactory } from "./shared.ts";
import { requestId } from "./request-id.ts";
import { securityHeaders } from "./security-headers.ts";
import { corsHandler } from "./cors.ts";
import { csrfGate } from "./csrf.ts";
import { authContext } from "./auth.ts";
import { twoFactorGate } from "./two-factor-gate.ts";
import { rateLimit } from "./rate-limit.ts";
import { requestStore } from "./store.ts";

export { requestId } from "./request-id.ts";
export { securityHeaders } from "./security-headers.ts";
export { cors, corsHandler } from "./cors.ts";
export { csrfGate } from "./csrf.ts";
export { authContext, buildBetterAuth } from "./auth.ts";
export { twoFactorGate } from "./two-factor-gate.ts";
export { rbac } from "./rbac.ts";
export { rateLimit } from "./rate-limit.ts";
export { requestStore } from "./store.ts";
export { onErrorHandler } from "./error-handler.ts";
export {
  buildStandardHeaders,
  closeBetterAuthFallbackClients,
  defaultStoreFactory,
  ensureRequestStore,
  extractBearerToken,
  generateRequestId,
  parseSessionCookie,
  resolveClientIp,
  resolveRequestEnv,
  trustedOriginsOf,
} from "./shared.ts";
export type { AppEnv } from "../types/context.ts";

/**
 * The whole cross-cutting pipeline as one chain, in the order app.ts
 * applied it: requestId → securityHeaders → cors → csrfGate →
 * authContext → twoFactorGate → rateLimit → requestStore.
 *
 * `storeFactory` is Worker 1's per-request factory (fresh DrizzleStore,
 * `apps/api/src/index.ts` `createRequestStore`); it is passed to every
 * middleware that may open the store (`authContext`, `rateLimit`,
 * `requestStore`) so the lazy open and the owning close use the SAME
 * factory. Omit it only in tests — the default is the in-memory store,
 * exactly like `createStackMateApp` with no factory.
 *
 * Two call shapes (Worker 1 calls `requestStore(env, storeFactory)`):
 * - `middlewareChain(storeFactory)` — env resolved per request from
 *   `c.var.env` / `c.env`.
 * - `middlewareChain(env, storeFactory)` — env fixed at composition.
 *
 * Usage (Worker 1): `app.use(...middlewareChain(env, storeFactory))`.
 * NOTE: `c.var.env` must be set before this chain runs (by the app
 * factory from `c.env` bindings) — or the app must be created as
 * `new Hono<{ Bindings: StackMateBindings; Variables: AppEnv["Variables"] }>()`
 * so `resolveRequestEnv` can read the bindings from `c.env` directly.
 */
export function middlewareChain(
  storeFactory?: StackMateStoreFactory
): MiddlewareHandler<AppEnv>[];
export function middlewareChain(
  env: StackMateBindings,
  storeFactory?: StackMateStoreFactory
): MiddlewareHandler<AppEnv>[];
export function middlewareChain(
  first?: StackMateStoreFactory | StackMateBindings,
  second?: StackMateStoreFactory
): MiddlewareHandler<AppEnv>[] {
  const storeFactory =
    typeof first === "function" ? first : (second ?? defaultStoreFactory);
  const fixedEnv =
    first !== undefined && typeof first !== "function" ? first : undefined;
  return [
    requestId(),
    securityHeaders(),
    corsHandler(),
    csrfGate(),
    authContext(storeFactory),
    twoFactorGate(),
    rateLimit(storeFactory),
    fixedEnv
      ? requestStore(fixedEnv, storeFactory)
      : requestStore(storeFactory),
  ];
}
