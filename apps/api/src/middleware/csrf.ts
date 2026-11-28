/**
 * CSRF-gate middleware — app.ts `assertSameSiteCookieMutation` ~L643-671
 * (+ `parseSessionCookie` ~L307-326, in `middleware/shared.ts`).
 *
 * CSRF gate for cookie-authenticated state-changing requests (L-1).
 * An absent Origin no longer skips the gate — a cross-site Referer or
 * `Sec-Fetch-Site: cross-site` also blocks. Absent Origin AND absent
 * Referer stays allowed: non-browser clients (and the test suite) send
 * neither, and a blanket fail-closed there would break legitimate API
 * clients that carry the session cookie. Bearer-token requests are
 * unaffected (no ambient credential to forge with), and GET/HEAD never
 * mutate. Throws `AppError` 403 `FORBIDDEN` with app.ts's exact message.
 *
 * Scope note: in app.ts this gate was called only at three sites
 * (sign-out ~L1507, change-password ~L1542, the admin block ~L2988)
 * — and this middleware keeps exactly that scope. It does NOT guard
 * other /api/auth/* endpoints (2FA, OAuth, ...): those are guarded by
 * Better Auth's own originCheckMiddleware, whose trusted list is
 * NORMALIZED and broader (trailing-slash stripped, API_URL/APP_URL/
 * BETTER_AUTH_URL included, wildcards) and whose INVALID_ORIGIN
 * error shape the 2FA tests assert. A blanket chain gate would block
 * legitimate 2FA requests Better Auth accepts and mask its error.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/context.ts";
import { AppError } from "../shared/errors.ts";
import {
  parseSessionCookie,
  resolveRequestEnv,
  trustedOriginsOf,
} from "./shared.ts";

export function csrfGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // SCOPE (old app.ts called this gate at exactly three sites —
    // sign-out ~L1507, change-password ~L1542, the admin block
    // ~L2988). Every other /api/auth/* endpoint (2FA setup/verify,
    // OAuth, ...) is guarded by Better Auth's own originCheckMiddleware,
    // which uses a NORMALIZED trusted list (trailing-slash stripped,
    // API_URL/APP_URL/BETTER_AUTH_URL included, wildcards) and its own
    // INVALID_ORIGIN error shape. A blanket chain gate here would
    // block legitimate 2FA requests that Better Auth accepts (its
    // trusted list is broader than raw TRUSTED_ORIGINS) and would mask
    // Better Auth's INVALID_ORIGIN error with the app envelope — which
    // is exactly what broke the two-factor-origin suite when the live
    // path was wired to Hono. So the gate applies ONLY to the three
    // old-handler sites; /api/auth/* otherwise passes through to
    // Better Auth's own check.
    const pathname = c.req.path.replace(/\/+$/, "") || "/";
    const isGatedPath =
      pathname === "/api/auth/sign-out" ||
      pathname === "/api/auth/change-password" ||
      pathname.startsWith("/api/v1/admin");
    if (!isGatedPath) {
      await next();
      return;
    }
    const env = resolveRequestEnv(c);
    const trustedOrigins = trustedOriginsOf(env);
    const sessionCookie = parseSessionCookie(c.req.header("Cookie") ?? null);
    if (sessionCookie) {
      const methodUpper = c.req.method.toUpperCase();
      if (methodUpper !== "GET" && methodUpper !== "HEAD") {
        const origin = c.req.header("Origin") ?? null;
        const referer = c.req.header("Referer") ?? null;
        const fetchSite = c.req.header("Sec-Fetch-Site") ?? null;
        const refererOrigin = (() => {
          if (!referer) return null;
          try {
            return new URL(referer).origin;
          } catch {
            return "invalid";
          }
        })();
        const crossSite =
          (origin !== null && !trustedOrigins.includes(origin)) ||
          (origin === null &&
            refererOrigin !== null &&
            !trustedOrigins.includes(refererOrigin)) ||
          (origin === null && refererOrigin === null && fetchSite === "cross-site");
        if (crossSite) {
          throw new AppError(
            "FORBIDDEN",
            `Cross-origin state-changing request from untrusted origin '${origin ?? refererOrigin ?? "cross-site"}' blocked by CSRF policy.`,
            403
          );
        }
      }
    }
    await next();
  };
}
