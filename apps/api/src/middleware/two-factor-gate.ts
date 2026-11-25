/**
 * Two-factor-setup gate middleware — app.ts admin block ~L3005-3021.
 *
 * When the 2FA policy requires setup and the user has not set it up,
 * the session exists but cannot use the admin API at all: every admin
 * endpoint returns 403 TWO_FACTOR_SETUP_REQUIRED except GET
 * /api/v1/admin/me (the SPA needs the principal to render the
 * forced-setup wizard). This was enforced in app.ts's admin-block
 * preamble, so no route could forget it — and the Hono routes rely on
 * it the same way (routes/admin/core.ts: "Middleware the Hono app MUST
 * provide ... the 2FA-setup gate"). It lives here, in the chain, not
 * in `rbac`: `rbac` only checks the permission list, and a restricted
 * user must get TWO_FACTOR_SETUP_REQUIRED (not the RBAC FORBIDDEN)
 * so the SPA can tell "set up 2FA" apart from "you lack permission".
 *
 * Position in the chain: AFTER `authContext` (which sets the
 * principal) and BEFORE `rateLimit` — app.ts threw the gate before
 * the admin 600/min bucket (rate-limit.ts returns no bucket for a
 * restricted principal on a non-/me admin path for exactly this
 * reason). The gate needs no store: it reads only `c.var.principal`.
 *
 * Scope: /api/v1/admin/* only (the old handler's admin block). The
 * /api/auth/* fallback has its own equivalent gate in
 * `checkBetterAuthFallbackAccess` (service.ts); public/license/
 * integration routes are never gated by it.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/context.ts";
import { AppError } from "../shared/errors.ts";

export function twoFactorGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal =
      (c.var as Partial<AppEnv["Variables"]>).principal ?? null;
    const pathname = c.req.path.replace(/\/+$/, "") || "/";
    const method = c.req.method.toUpperCase();
    const isTwoFactorAllowedPath =
      method === "GET" && pathname === "/api/v1/admin/me";
    if (
      pathname.startsWith("/api/v1/admin") &&
      principal?.two_factor_setup_required &&
      !isTwoFactorAllowedPath
    ) {
      throw new AppError(
        "TWO_FACTOR_SETUP_REQUIRED",
        "Two-factor authentication setup is required for your role. Complete setup to continue.",
        403
      );
    }
    await next();
  };
}
