/**
 * Rate-limit middleware — app.ts per-route-class `store.checkRateLimit`
 * calls.
 *
 * Route classes are derived from the path prefix — the same classes
 * app.ts throttles, with the same keys/limits:
 * - `/api/auth*` → `auth:<ip>` 60/min (~L1318).
 * - `/api/v1/licenses*` → `licenses:<ip>` 120/min (~L2073).
 * - `/api/v1/public/*` (except tracking ingest) → `public:<ip>` 120/min
 *   (~L2149); tracking ingest `POST .../tracking/events` gets its own
 *   buckets — per-site `tracking-site:<siteKey>` 600/min + per-IP
 *   `tracking:<siteKey>:<ip>` 60/min (~L2628-2629), so one abusive
 *   site/IP can flood tracking without starving checkout/catalog.
 * - `/api/v1/integrations/*` → `integrations:<ip>` 120/min (~L2640).
 * - `/api/v1/admin*` → `admin:<userId>:<ip>` 600/min (~L3024), only
 *   for an authenticated principal (app.ts rate-limits AFTER the 401
 *   check, so an unauthenticated request is never bucketed here — the
 *   route answers 401 instead). A 2FA-restricted session is likewise
 *   not bucketed (app.ts throws `TWO_FACTOR_SETUP_REQUIRED` BEFORE
 *   the rate limit, except `GET /api/v1/admin/me` which the SPA needs
 *   for the forced-setup wizard).
 * - Everything else (health/ready/setup-status/favicon, `/api/v1/graphql`
 *   until Worker 4 wires it, unknown paths) → no bucket, exactly as
 *   app.ts applies no `checkRateLimit` there.
 * All buckets are store-backed (`store.checkRateLimit`, table
 * `rate_limit_buckets`) and throw `AppError` 429 `RATE_LIMIT_EXCEEDED`
 * when exhausted. The per-endpoint caps (sign-in lockout ~L1463, token
 * attempt caps ~L747, forgot-password / 2FA-recovery cooldowns
 * ~L1693/~L1801) are NOT part of this middleware — they stay in their
 * route handlers, as in app.ts. Client IP follows app.ts A-06
 * (`resolveClientIp`, `middleware/shared.ts`).
 */
import type { Context, MiddlewareHandler } from "hono";
import type { StackMateStoreFactory } from "../app.ts";
import type { StaffPrincipal } from "../modules/identity/service.ts";
import type { AppEnv } from "../types/context.ts";
import {
  closeStoreIfUnclaimed,
  defaultStoreFactory,
  ensureRequestStore,
  resolveClientIp,
  resolveRequestEnv,
} from "./shared.ts";

interface RateLimitBucket {
  key: string;
  maxRequests: number;
  windowMs?: number;
}

function rateLimitBucketsFor(
  c: Context<AppEnv>,
  principal: StaffPrincipal | null
): RateLimitBucket[] | null {
  const pathname = c.req.path.replace(/\/+$/, "") || "/";
  const method = c.req.method.toUpperCase();
  const clientIp = resolveClientIp(c);

  if (pathname.startsWith("/api/auth")) {
    return [{ key: `auth:${clientIp}`, maxRequests: 60 }];
  }
  if (pathname.startsWith("/api/v1/licenses")) {
    return [{ key: `licenses:${clientIp}`, maxRequests: 120 }];
  }
  if (pathname.startsWith("/api/v1/public/")) {
    const isTrackingIngest =
      method === "POST" && pathname.endsWith("/tracking/events");
    if (isTrackingIngest) {
      // /api/v1/public/sites/:siteKey/tracking/events
      const siteKey = pathname.split("/")[5] ?? "";
      return [
        { key: `tracking-site:${siteKey}`, maxRequests: 600 },
        { key: `tracking:${siteKey}:${clientIp}`, maxRequests: 60 },
      ];
    }
    return [{ key: `public:${clientIp}`, maxRequests: 120 }];
  }
  if (pathname.startsWith("/api/v1/integrations/")) {
    return [{ key: `integrations:${clientIp}`, maxRequests: 120 }];
  }
  if (pathname.startsWith("/api/v1/admin")) {
    if (!principal) return null;
    if (
      principal.two_factor_setup_required &&
      !(method === "GET" && pathname === "/api/v1/admin/me")
    ) {
      return null;
    }
    return [{ key: `admin:${principal.user.id}:${clientIp}`, maxRequests: 600 }];
  }
  return null;
}

export function rateLimit(
  storeFactory: StackMateStoreFactory = defaultStoreFactory
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const env = resolveRequestEnv(c);
    const store = await ensureRequestStore(c, storeFactory, env);
    try {
      const principal =
        (c.var as Partial<AppEnv["Variables"]>).principal ?? null;
      const buckets = rateLimitBucketsFor(c, principal);
      if (buckets) {
        for (const bucket of buckets) {
          await store.checkRateLimit(bucket.key, bucket.maxRequests, bucket.windowMs);
        }
      }
      await next();
    } finally {
      await closeStoreIfUnclaimed(c);
    }
  };
}
