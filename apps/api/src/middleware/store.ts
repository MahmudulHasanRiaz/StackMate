/**
 * Request-store middleware — app.ts `fetchHandler` ~L7824-7949
 * (`resolveRequestStore` / `closeRequestStore` ~L455-474 + the `finally`
 * at ~L7930-7940, incl. C-10 fallback-client close; the lifecycle
 * itself lives in `middleware/shared.ts`).
 *
 * Request-scoped store: open the store for this request, run the rest
 * of the chain + handler, then close it in `finally` — app.ts
 * `fetchHandler`'s `finally`. The response body is fully materialized
 * JSON, so closing before the runtime sends it is safe. An injected
 * (adopted) store is never closed: its lifetime belongs to its owner.
 *
 * Factory form — Worker 1 (`hono-app.ts`) calls
 * `requestStore(env, storeFactory)`; the `(storeFactory)` form (env
 * resolved per request from `c.var.env` / `c.env`) is also accepted.
 */
import type { MiddlewareHandler } from "hono";
import type { StackMateBindings } from "../env.ts";
import type { StackMateStoreFactory } from "../app.ts";
import type { AppEnv } from "../types/context.ts";
import {
  claimStoreClose,
  closeBetterAuthFallbackClients,
  closeStoreForRequest,
  defaultStoreFactory,
  ensureRequestStore,
  resolveRequestEnv,
} from "./shared.ts";

export function requestStore(
  storeFactory?: StackMateStoreFactory
): MiddlewareHandler<AppEnv>;
export function requestStore(
  env: StackMateBindings,
  storeFactory?: StackMateStoreFactory
): MiddlewareHandler<AppEnv>;
export function requestStore(
  first?: StackMateStoreFactory | StackMateBindings,
  second?: StackMateStoreFactory
): MiddlewareHandler<AppEnv> {
  const storeFactory =
    typeof first === "function" ? first : (second ?? defaultStoreFactory);
  const fixedEnv =
    first !== undefined && typeof first !== "function" ? first : undefined;
  return async (c, next) => {
    const env = fixedEnv ?? resolveRequestEnv(c);
    const store = await ensureRequestStore(c, storeFactory, env);
    const owned = claimStoreClose(c);
    try {
      await next();
    } finally {
      if (owned) {
        await closeStoreForRequest(c, store);
      } else {
        // Adopted (injected) store: its lifetime belongs to its owner
        // and the store itself is NEVER closed here — but any Better
        // Auth fallback pg.Client created for this request (C-10) is
        // still ended, exactly like the old fetchHandler's finally,
        // which closed fallback clients even in injected-store mode.
        await closeBetterAuthFallbackClients(store);
      }
    }
  };
}
