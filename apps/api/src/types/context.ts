/**
 * Hono context contract for the StackMate API (Hono migration, Worker 3).
 *
 * `AppEnv` is the single shared contract every Hono middleware and route
 * module uses: request-scoped values live in `c.var`, never in module
 * scope (one Worker isolate serves many requests — module scope would
 * leak state across requests, cf. the Batch 0 singleton revert in
 * `apps/api/src/index.ts`). Do NOT redefine `AppEnv` anywhere else.
 * (This file is the authoritative home of `AppEnv`; the earlier
 * `hono/context.ts` placeholder was removed — no duplicate lives on.)
 *
 * - `requestId` — set by `requestId()` (`middleware/request-id.ts`),
 *   the `X-Request-ID` correlation id (always `req_<16 hex>`).
 * - `env` — the resolved `StackMateBindings`. The Hono app factory
 *   (Worker 1, `hono-app.ts`) sets it per request from `c.env`
 *   (Worker bindings) or its own `resolveRuntimeConfig` call; the
 *   middleware also falls back to `c.env` when `c.var.env` is unset.
 * - `store` — the request-scoped `StackMateDataStore`, opened by
 *   `requestStore()` (`middleware/store.ts`; or lazily by the first
 *   middleware that needs it — see `ensureRequestStore` in
 *   `middleware/shared.ts`) and closed in `requestStore()`'s `finally`.
 * - `principal` — the resolved staff principal, or `null` when the
 *   request carries no valid staff session. Set by `authContext()`
 *   (`middleware/auth.ts`); routes enforce authentication/authorization
 *   themselves (401/403), the middleware never throws for an
 *   unauthenticated request.
 *
 * `StaffPrincipal` is the EXISTING type from the identity module
 * (`modules/identity/service.ts`) — no new principal type is defined.
 */
import type { StackMateBindings } from "../env.ts";
import type { StackMateDataStore } from "../platform/db/store.ts";
import type { StaffPrincipal } from "../modules/identity/service.ts";

export type AppEnv = {
  Variables: {
    requestId: string;
    env: StackMateBindings;
    store: StackMateDataStore;
    principal: StaffPrincipal | null;
  };
};
