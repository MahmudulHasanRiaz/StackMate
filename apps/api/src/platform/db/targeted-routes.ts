/**
 * B-01 targeted-only route allowlist (foundation — Audit #2 Critical B-01).
 *
 * Problem: `DrizzleStore.create()` (`platform/db/drizzle-store.ts`) runs
 * the combined full-state load (~65 tables) on EVERY request, because the
 * per-request factory (`apps/api/src/index.ts` `createRequestStore`)
 * creates a full store for every path. `DrizzleStore.createTargeted()`
 * connects WITHOUT that load — the store's `state` holds only the
 * in-memory seed rows — and targeted methods run 1–3 queries each.
 *
 * This file is the switch. `createRequestStore` consults
 * `isTargetedOnlyRoute(c.req.path)` (via `ensureRequestStore`,
 * `middleware/shared.ts`, which passes the request path to the factory)
 * and creates a targeted store ONLY for a route listed here; every
 * other route gets the full-load store exactly as before.
 *
 * The allowlist starts EMPTY on purpose: no route is switched until its
 * handler is proven targeted-safe (see below). The coordinator adds
 * entries at integration, one route at a time, after the owning worker
 * proves the handler.
 *
 * How a route EARNS an allowlist entry (all three are required):
 *  1. ZERO `store.state` reads anywhere in the request path — the
 *     handler, every service it calls, and the middleware that ran
 *     before it (`authContext` / `rateLimit` / `twoFactorGate`).
 *     Targeted store methods only (`findStaffPrincipalByEmail`,
 *     `findLicenseForValidation`, `loadPublicCatalog`,
 *     `claimOutboxEvents`, `checkRateLimit`, …). A single
 *     `store.state.users.find(...)` on a targeted store reads SEED
 *     rows, not the database — silently wrong, never loud.
 *  2. NO `loadState()` / `withTransaction()` / `reloadStateIfPossible`
 *     reliance: `withTransaction` reloads full state inside the
 *     transaction, and `reloadStateIfPossible` (identity service) is a
 *     no-op on a targeted store by design (see `DrizzleStore.
 *     isStateFresh` override) — so a handler that reads state after
 *     either of those calls can NEVER be allowlisted. That rules out
 *     sign-in and 2FA recovery, which read `store.state.users` after
 *     `reloadStateIfPossible`.
 *  3. Tests pass on a `createTargeted()` store: the handler's tests
 *     run against a targeted store (not just the full-load store) and
 *     assert no combined-load query runs (spy on `pg` `Client.
 *     prototype.query` for `json_agg`, as in
 *     `test/audit-batch-b.test.ts` `countJsonAggQueries`).
 *
 * Entry shape:
 * - `path`: the pathname to match. With `prefix: false` (default) it
 *   must match exactly; with `prefix: true` it matches the path
 *   itself and any path under it (`/api/v1/public` matches
 *   `/api/v1/public/catalog` but NOT `/api/v1/publications` — the
 *   match is segment-boundary aware).
 * - A `:name` segment in an exact entry matches any single non-empty
 *   segment (`/api/v1/admin/customers/:customerId/orders` matches
 *   `/api/v1/admin/customers/abc123/orders` but NOT
 *   `/api/v1/admin/customers/abc123` or
 *   `/api/v1/admin/customers/abc123/orders/xyz`). Prefix entries do
 *   not support `:name` segments — keep prefixes literal.
 * - `loadSigningKey`: when true, `createTargeted` also loads the
 *   license signing key (needed to sign entitlement tokens, e.g.
 *   license validation). A principal lookup does not need it, so it
 *   defaults to false — do not set it unless the route signs.
 *
 * Matching normalizes a trailing slash (`/api/v1/public/` matches
 * `/api/v1/public`). Query strings never reach this function —
 * callers pass `c.req.path` (pathname only).
 *
 * The array is exported (mutable) so tests can push a temporary entry
 * and remove it afterwards; production entries are added by editing
 * the literal below, one reviewed entry per route.
 */
export interface TargetedRouteEntry {
  /** Exact pathname, or a path prefix when `prefix` is true. */
  path: string;
  /**
   * When true, `path` matches itself and every pathname beneath it
   * (segment-boundary aware). Default false: exact match only.
   */
  prefix?: boolean;
  /**
   * Load the license signing key into the targeted store (license
   * validation needs it to sign entitlement tokens). Default false.
   */
  loadSigningKey?: boolean;
}

export const TARGETED_ONLY_ROUTES: TargetedRouteEntry[] = [
  // -- B-01 wiring batch 1 (2026-11-26) ------------------------------------
  // License validate signs entitlement tokens → loadSigningKey: true.
  // (modules/licensing/service.ts validateLicenseInstallationTargeted;
  // test/b01-license-catalog.test.ts 8/8 on a createTargeted store.)
  { path: "/api/v1/licenses/validate", loadSigningKey: true },
  // Public catalog (routes/public/index.ts; test/b01-license-catalog.test.ts).
  // NOTE: checkout (/api/v1/public/sites/:siteKey/checkout/...) and
  // tracking are NOT wired — do NOT add a broad /api/v1/public prefix.
  { path: "/api/v1/public/sites/:siteKey/products" },
  { path: "/api/v1/public/sites/:siteKey/products/:productSlug/packages" },
  { path: "/api/v1/public/sites/:siteKey/products/:productSlug" },
  { path: "/api/v1/public/sites/:siteKey/packages/:packageVersionId" },
  // Admin lists (modules/*/list.ts + routes/admin/licenses.ts helpers;
  // test/b01-lists.test.ts 11/11 on a createTargeted store, plus the
  // in-memory fallback so the same handlers also serve the in-memory
  // test adapter). NOTE: assertStaffPermissionAudited calls
  // withTransaction ONLY on the 403 denial path (best-effort audit,
  // errors swallowed) — the success path never touches store.state.
  // Detail GETs, /admin/search, and mutations are NOT allowlisted.
  { path: "/api/v1/admin/products" },
  { path: "/api/v1/admin/customers" },
  { path: "/api/v1/admin/orders" },
  { path: "/api/v1/admin/subscriptions" },
  { path: "/api/v1/admin/renewals" },
  { path: "/api/v1/admin/payment-providers" },
  { path: "/api/v1/admin/payment-methods" },
  { path: "/api/v1/admin/refunds" },
  { path: "/api/v1/admin/licenses" },
  { path: "/api/v1/admin/licenses/:licenseId/activations" },
  { path: "/api/v1/admin/invoices" },
  { path: "/api/v1/admin/orders/:orderId/invoices" },
  { path: "/api/v1/admin/orders/:orderId/installments" },
  { path: "/api/v1/admin/customers/:customerId/orders" },
  { path: "/api/v1/admin/customers/:customerId/subscriptions" },
  { path: "/api/v1/admin/customers/:customerId/licenses" },
  { path: "/api/v1/admin/customers/:customerId/addresses" },
  { path: "/api/v1/admin/customers/:customerId/reports" },
  { path: "/api/v1/admin/customers/:customerId/payments" },
  { path: "/api/v1/admin/customers/:customerId/installations" },
  { path: "/api/v1/admin/customers/:customerId/activity" },
  { path: "/api/v1/admin/customers/:customerId/tickets" },
];

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/**
 * Exact match with `:name` parameter segments: same segment count, and
 * every pattern segment either equals the pathname segment or starts
 * with `:` (matching any single non-empty segment).
 */
function matchesExactPattern(pattern: string, pathname: string): boolean {
  const patternSegments = normalizePath(pattern).split("/").filter(Boolean);
  const pathSegments = normalizePath(pathname).split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every(
    (segment, i) =>
      segment.startsWith(":") ||
      segment === pathSegments[i]
  );
}

/**
 * The allowlist decision for one request pathname. Returns
 * `{ loadSigningKey }` when the path is allowlisted (the factory
 * creates a targeted store), or `null` when it is not (the factory
 * creates a full-load store exactly as before). First match wins;
 * exact entries are checked before prefix entries so a specific
 * exact entry can never be shadowed by a broader prefix.
 */
export function isTargetedOnlyRoute(
  path: string
): { loadSigningKey: boolean } | null {
  const pathname = normalizePath(path);
  for (const entry of TARGETED_ONLY_ROUTES) {
    if (entry.prefix === true) continue;
    if (matchesExactPattern(entry.path, pathname)) {
      return { loadSigningKey: entry.loadSigningKey ?? false };
    }
  }
  for (const entry of TARGETED_ONLY_ROUTES) {
    if (entry.prefix !== true) continue;
    const prefix = normalizePath(entry.path);
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return { loadSigningKey: entry.loadSigningKey ?? false };
    }
  }
  return null;
}
