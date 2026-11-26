/**
 * Shared plumbing for the Hono middleware (`apps/api/src/middleware/`).
 *
 * NOT a middleware itself — this file holds the exact copies of app.ts
 * helpers and the request-store lifecycle that several concern files
 * need, so no concern file duplicates them (one source of truth, no
 * drift) and every concern file stays small (owner rule: no file
 * over ~500 lines).
 *
 * Contents:
 * - `generateRequestId`, `trustedOriginsOf`, `buildStandardHeaders`,
 *   `parseSessionCookie`, `extractBearerToken`, `resolveRequestEnv`,
 *   `resolveClientIp` — exact copies of app.ts helpers (see each
 *   function's note for its app.ts source lines).
 * - `defaultStoreFactory` — the in-memory fallback factory (app.ts
 *   `createStackMateApp` with no factory).
 * - Request-store lifecycle (`ensureRequestStore`,
 *   `closeStoreIfUnclaimed`, `claimStoreClose`, `closeStoreForRequest`)
 *   — the lazy-open / ownership-flag design documented in
 *   `middleware/index.ts`: the store is opened by the first middleware
 *   that needs it and closed by `requestStore()`'s `finally` (or by an
 *   earlier middleware's `finally` when the chain throws before
 *   `requestStore` runs).
 * - Better Auth fallback-client registry (`trackBetterAuthFallbackClient`,
 *   `closeBetterAuthFallbackClients`) — app.ts C-10 (~L477-502).
 */
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { StackMateBindings } from "../env.ts";
import { StackMateDataStore } from "../platform/db/store.ts";
import type { StackMateStoreFactory } from "../app.ts";
import { AppError } from "../shared/errors.ts";
import type { AppEnv } from "../types/context.ts";

// ---------------------------------------------------------------------------
// Exact copies of app.ts helpers
// ---------------------------------------------------------------------------

export function generateRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function trustedOriginsOf(env: StackMateBindings): string[] {
  return env.TRUSTED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Exact copy of app.ts `buildStandardHeaders` (~L416-444).
 * Exported so Worker 1's app factory can build identical headers for
 * its early (pre-chain) responses, e.g. `/api/v1/health`.
 */
export function buildStandardHeaders(
  requestId: string,
  origin: string | null,
  trustedOrigins: string[],
  extraHeaders?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Request-ID": requestId,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    ...extraHeaders,
  };
  if (origin && trustedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
  }
  return headers;
}

/**
 * Exact copy of app.ts `parseSessionCookie` (~L307-326): the session
 * cookie names the CSRF gate (and auth resolution) recognise, including
 * the `__Secure-` prefix used in staging/production (ADR-0008
 * decision 10).
 */
export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (
      rawName === "stackmate_session" ||
      rawName === "__Host-stackmate_session" ||
      rawName === "better-auth.session_token" ||
      // Staging/production set the session cookie with the __Secure-
      // prefix (useSecureCookies: isProd). Without this name the app
      // CSRF gate below never sees the cookie live and never enforces
      // (ADR-0008 decision 10).
      rawName === "__Secure-better-auth.session_token"
    ) {
      return rest.join("=").trim();
    }
  }
  return null;
}

/** Exact copy of app.ts `extractBearerToken` (~L329-333). */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Resolve the request env: `c.var.env` first (set by an earlier
 * middleware or by Worker 1's app factory), else the Hono bindings
 * (`c.env`). Throws a 500 `AppError` when neither carries bindings —
 * fail closed, never serve from an unconfigured env.
 */
export function resolveRequestEnv(c: Context<AppEnv>): StackMateBindings {
  const fromVar = (c.var as Partial<AppEnv["Variables"]>).env;
  if (fromVar && typeof fromVar.TRUSTED_ORIGINS === "string") return fromVar;
  const fromBindings = c.env as unknown as Partial<StackMateBindings> | undefined;
  if (fromBindings && typeof fromBindings.TRUSTED_ORIGINS === "string") {
    return fromBindings as StackMateBindings;
  }
  throw new AppError(
    "INTERNAL_ERROR",
    "StackMate environment bindings are not configured for this request.",
    500
  );
}

/**
 * Client IP, app.ts A-06 (~L695-709) exactly: `cf-connecting-ip` is
 * authoritative when present. `x-real-ip` is client-controlled and is
 * trusted ONLY when the request did NOT come through Cloudflare (no
 * `cf-connecting-ip` and no `cf-ray`) — behind Cloudflare a spoofed
 * `x-real-ip` must never pick the rate-limit bucket. Without either
 * header the request is bucketed under loopback.
 */
export function resolveClientIp(c: Context<AppEnv>): string {
  const cfConnectingIp = c.req.header("cf-connecting-ip");
  const viaCloudflare =
    cfConnectingIp !== undefined || c.req.header("cf-ray") !== undefined;
  return (
    cfConnectingIp ??
    (viaCloudflare ? "127.0.0.1" : (c.req.header("x-real-ip") ?? "127.0.0.1"))
  );
}

// ---------------------------------------------------------------------------
// Default store factory
// ---------------------------------------------------------------------------

/**
 * Default store factory (app.ts `createStackMateApp` behaviour when no
 * `storeFactory` is given): a fresh in-memory `StackMateDataStore`.
 * Worker 1 passes the real factory (fresh `DrizzleStore` per request,
 * see `apps/api/src/index.ts` `createRequestStore`) to
 * `middlewareChain` / `requestStore` / `authContext` / `rateLimit`.
 */
export const defaultStoreFactory: StackMateStoreFactory = async () =>
  new StackMateDataStore();

// ---------------------------------------------------------------------------
// Better Auth fallback-client registry (app.ts C-10, ~L477-502)
// ---------------------------------------------------------------------------

/**
 * pg.Clients created by the Better Auth fallback path in
 * `buildBetterAuth` (`middleware/auth.ts`) are tracked per store and
 * ended when the request finishes (see `closeStoreForRequest` below).
 * Without this each request that took the non-`drizzleDb` branch leaked
 * a client object. Exact copy of app.ts's `betterAuthFallbackClients`
 * WeakMap.
 */
const betterAuthFallbackClients = new WeakMap<
  object,
  Array<{ end: () => Promise<unknown> }>
>();

export function trackBetterAuthFallbackClient(
  store: StackMateDataStore,
  client: { end: () => Promise<unknown> }
): void {
  const tracked = betterAuthFallbackClients.get(store) ?? [];
  tracked.push(client);
  betterAuthFallbackClients.set(store, tracked);
}

export async function closeBetterAuthFallbackClients(
  store: StackMateDataStore
): Promise<void> {
  const clients = betterAuthFallbackClients.get(store);
  if (!clients || clients.length === 0) return;
  betterAuthFallbackClients.delete(store);
  await Promise.all(clients.map((client) => client.end().catch(() => {})));
}

// ---------------------------------------------------------------------------
// Request-store lifecycle
// ---------------------------------------------------------------------------

interface StoreLifecycle {
  store: StackMateDataStore;
  /** False only for a store this request's factory created. */
  owned: boolean;
  /** True once `requestStore()` has taken over closing it. */
  closeClaimed: boolean;
  closed: boolean;
}

const storeLifecycles = new WeakMap<object, StoreLifecycle>();

/**
 * End a factory-owned (per-request) store's resources. Exact copy of
 * app.ts `closeRequestStore` (~L466-474): only the DrizzleStore owns
 * anything closeable (its request-scoped pg Client); the in-memory
 * store has no dispose/close and this is a no-op for it. Never throws:
 * a close failure must not mask the request's response.
 */
async function closeRequestStore(store: StackMateDataStore): Promise<void> {
  const dispose = (
    store as unknown as { dispose?: () => Promise<void> }
  ).dispose;
  if (typeof dispose === "function") {
    await dispose.call(store).catch(() => {});
  }
}

export async function closeStoreForRequest(
  c: Context<AppEnv>,
  store: StackMateDataStore
): Promise<void> {
  const lifecycle = storeLifecycles.get(c);
  if (!lifecycle || lifecycle.store !== store || lifecycle.closed) return;
  lifecycle.closed = true;
  await closeRequestStore(store);
  // C-10: end any Better Auth fallback pg.Client created for this
  // request (injected-store mode only — factory stores always have
  // drizzleDb, so they never take the fallback branch).
  await closeBetterAuthFallbackClients(store);
}

/**
 * Close the request store from an earlier middleware's `finally` when
 * `requestStore()` never ran to claim it (e.g. `rateLimit` threw 429
 * before the chain reached `requestStore`). No-op when `requestStore`
 * claimed the close, when the store was adopted (not factory-owned),
 * or when it is already closed.
 */
export async function closeStoreIfUnclaimed(c: Context<AppEnv>): Promise<void> {
  const lifecycle = storeLifecycles.get(c);
  if (!lifecycle || !lifecycle.owned || lifecycle.closeClaimed || lifecycle.closed) {
    return;
  }
  await closeStoreForRequest(c, lifecycle.store);
}

/**
 * Mark the request store as owned by `requestStore()`'s `finally`.
 * Returns true when this request's store is factory-owned (so the
 * caller must close it); false for an adopted (injected) store, which
 * is never closed here — exactly like app.ts, where only a
 * `storeFactory`-created store is closed.
 */
export function claimStoreClose(c: Context<AppEnv>): boolean {
  const lifecycle = storeLifecycles.get(c);
  if (lifecycle && lifecycle.owned) {
    lifecycle.closeClaimed = true;
    return true;
  }
  return false;
}

/**
 * Resolve the store for one request (idempotent — one store per
 * request). Exact copy of app.ts `resolveRequestStore` semantics
 * (~L455-464): in `storeFactory` mode the factory decides; a store
 * already in `c.var.store` (seeded by Worker 1 — injected-store mode)
 * is adopted as-is and never closed here. A store-creation failure
 * answers exactly like app.ts `fetchHandler`'s catch (~L7901-7928):
 * log the real error and throw `AppError` 500 `STORE_UNAVAILABLE`
 * with the standard message, so `onErrorHandler` renders the standard
 * JSON error envelope instead of a bare Worker exception.
 */
export async function ensureRequestStore(
  c: Context<AppEnv>,
  factory: StackMateStoreFactory,
  env: StackMateBindings
): Promise<StackMateDataStore> {
  const vars = c.var as Partial<AppEnv["Variables"]>;
  if (vars.store) {
    const existing = storeLifecycles.get(c);
    if (!existing || existing.store !== vars.store) {
      // Adopted (injected) store: its lifetime belongs to its owner
      // and it is never closed here — mark it claimed from the start.
      storeLifecycles.set(c, {
        store: vars.store,
        owned: false,
        closeClaimed: true,
        closed: false,
      });
    }
    return vars.store;
  }
  let store: StackMateDataStore;
  try {
    // B-01: pass the request pathname so the factory can decide
    // between a full-load store and a targeted store (allowlisted
    // routes only — `platform/db/targeted-routes.ts`). The factory
    // decides; this call site never branches on the path itself.
    // `ctx` is not available here (Hono's execution context is not
    // forwarded to middleware), so the second arg stays undefined —
    // the factory type keeps it optional and backward compatible.
    store = await factory(env, undefined, { path: c.req.path });
  } catch (error) {
    console.error(
      "[stackmate] store creation failed",
      vars.requestId ?? "unknown",
      error instanceof Error ? error.message : "unknown error"
    );
    throw new AppError(
      "STORE_UNAVAILABLE",
      "The data store is temporarily unavailable. Please retry.",
      500
    );
  }
  c.set("store", store);
  storeLifecycles.set(c, { store, owned: true, closeClaimed: false, closed: false });
  return store;
}
