/**
 * Auth-context middleware — app.ts `getBetterAuth` ~L505-545 + the
 * admin-block auth resolution ~L2988-2999.
 *
 * Resolves the Better Auth session (cookie or Bearer staff session) and
 * sets `c.var.principal` — `null` when unauthenticated. This is the
 * admin-block auth resolution from app.ts WITHOUT the admin block's 401
 * (`UNAUTHORIZED` when no principal), 2FA restricted session gate
 * (`TWO_FACTOR_SETUP_REQUIRED`), or rate limit — those are enforced by
 * routes (`rbac`, route handlers) and `rateLimit()`
 * (`middleware/rate-limit.ts`) respectively, because this middleware
 * also runs for public/auth routes that must stay reachable without a
 * staff session.
 */
import type { MiddlewareHandler } from "hono";
import type { StackMateBindings } from "../env.ts";
import type { StackMateDataStore } from "../platform/db/store.ts";
import type { StackMateStoreFactory } from "../app.ts";
import { createBetterAuth } from "../modules/identity/better-auth.ts";
import {
  loadAuthConfig,
  type ResolvedAuthConfig,
} from "../modules/auth-config/service.ts";
import {
  resolveStaffPrincipal,
  resolveTokenPepper,
  storeSupportsBetterAuth,
  type StaffPrincipal,
} from "../modules/identity/service.ts";
import {
  buildApiTokenPrincipal,
  isApiTokenValue,
  verifyApiToken,
} from "../modules/api-tokens/service.ts";
import type { AppEnv } from "../types/context.ts";
import { AppError } from "../shared/errors.ts";
import {
  closeStoreIfUnclaimed,
  defaultStoreFactory,
  ensureRequestStore,
  extractBearerToken,
  resolveRequestEnv,
  trackBetterAuthFallbackClient,
} from "./shared.ts";

/**
 * Build the Better Auth instance for one request from the request's
 * store. Exact copy of app.ts `getBetterAuth` (~L505-545), only renamed
 * (it is no longer a closure inside `createStackMateApp`).
 * A DrizzleStore exposes its `drizzleDb` directly. Any other store (the
 * in-memory test adapter) gets a lazily created `pg` Client + drizzle()
 * over the Hyperdrive uncached connection string — constructing a `pg`
 * Client and calling drizzle() opens NO connection, so Better Auth paths
 * that never query need no live database.
 */
export async function buildBetterAuth(env: StackMateBindings, store: StackMateDataStore) {
  const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
  // DB-driven auth config (ADR-0008): the Better Auth instance is
  // built per request from the current Settings (OAuth providers +
  // 2FA plugin), cached 30s and invalidated on Settings save. A
  // Settings change takes effect without a redeploy.
  let authConfig: ResolvedAuthConfig | undefined;
  if (maybeDrizzle.drizzleDb) {
    authConfig = await loadAuthConfig(
      maybeDrizzle.drizzleDb as Parameters<typeof loadAuthConfig>[0],
      { encryptionKey: env.ENCRYPTION_KEY_V1, keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION },
      env.HYPERDRIVE_NO_CACHE.connectionString
    ).catch(() => undefined);
  }
  if (maybeDrizzle.drizzleDb) {
    return createBetterAuth(
      env,
      maybeDrizzle.drizzleDb as Parameters<typeof createBetterAuth>[1],
      authConfig
    );
  }
  const { Client } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const client = new Client({
    connectionString: env.HYPERDRIVE_NO_CACHE.connectionString,
  });
  // C-10: track the fallback client so the request's finally ends it
  // (see `closeBetterAuthFallbackClients` in `middleware/shared.ts`).
  trackBetterAuthFallbackClient(store, client);
  return createBetterAuth(env, drizzle(client), authConfig);
}

export function authContext(
  storeFactory: StackMateStoreFactory = defaultStoreFactory
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Site-key guard (old app.ts admin block, ~L2969-2978): a public
    // site key must never authenticate an admin request. A site-key-
    // only request to /api/v1/admin/* is 403 FORBIDDEN (the credential
    // type is wrong), not 401 (no credential) — the distinction matters:
    // a 401 would invite retrying with a staff session, while a 403
    // says this credential can never work here. Runs before the store
    // is opened (the guard needs no store).
    if (
      c.req.path.startsWith("/api/v1/admin") &&
      c.req.header("X-StackMate-Site-Key") !== undefined &&
      c.req.header("Cookie") === undefined &&
      c.req.header("Authorization") === undefined
    ) {
      throw new AppError(
        "FORBIDDEN",
        "Public site keys cannot access staff administration endpoints.",
        403
      );
    }
    const env = resolveRequestEnv(c);
    const store = await ensureRequestStore(c, storeFactory, env);
    try {
      // B-01 gate: build the Better Auth instance ONLY when a session
      // credential could exist. resolveStaffPrincipal uses `auth`
      // solely (a) to verify a `better-auth.session_token` cookie and
      // (b) to look up a Bearer / stackmate-session token — with NO
      // Cookie AND NO Authorization header both branches return null
      // without touching `auth`, so constructing it (per-request
      // loadAuthConfig + createBetterAuth) is pure overhead on every
      // credential-less request — i.e. every public/license call. A
      // request carrying ANY Cookie or Authorization header still
      // builds it (conservative: an unrelated cookie may sit next to
      // a session cookie, and a malformed Bearer still takes the same
      // null-principal path as before).
      const cookieHeader = c.req.header("Cookie") ?? null;
      const bearerToken = extractBearerToken(c.req.header("Authorization") ?? null);
      // OD-13: scoped API tokens (`stk_...`) authenticate WITHOUT
      // Better Auth. A `stk_` Bearer token is never a session token,
      // so it must never fall through to `resolveStaffPrincipal`
      // (which would look it up as a Better Auth session). On success
      // the principal carries exactly the token's scopes (roles: [],
      // so the `super_admin` bypass in `assertStaffPermission` never
      // applies); on failure the principal is null and downstream
      // guards answer 401 — never throw here, never fall through.
      // Skipping the Better Auth construction is pure-overhead
      // avoidance for these requests, same reasoning as the B-01 gate
      // below.
      if (bearerToken !== null && isApiTokenValue(bearerToken)) {
        const pepper = resolveTokenPepper(store, env.ENCRYPTION_KEY_V1) ?? null;
        const token = await verifyApiToken(store, { rawToken: bearerToken, pepper });
        c.set("principal", token ? buildApiTokenPrincipal(token) : null);
        await next();
        return;
      }
      const auth =
        cookieHeader === null && bearerToken === null
          ? null
          : storeSupportsBetterAuth(store)
            ? await buildBetterAuth(env, store)
            : null;
      const principal: StaffPrincipal | null = await resolveStaffPrincipal(store, {
        auth,
        cookieHeader,
        bearerToken,
      });
      c.set("principal", principal);
      await next();
    } finally {
      await closeStoreIfUnclaimed(c);
    }
  };
}
