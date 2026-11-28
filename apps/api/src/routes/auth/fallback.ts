/**
 * StackMate API — Hono route module (Hono migration, Phase 1).
 *
 * Converted mechanically from apps/api/src/app.ts (baseline feat e382d65):
 * same paths, methods, service calls, validation, RBAC and JSON shapes.
 * Only the HTTP plumbing changed: handlers read store/env/principal/
 * requestId from c.var (set by the Hono app middleware) and answer with
 * the same success/error envelopes. Shared HTTP plumbing lives in
 * apps/api/src/shared/http.ts.
 *
 * Middleware the Hono app MUST provide (was app.ts handleRequest/admin
 * preamble, not per-route code): request-id + standard/security headers,
 * CORS, CSRF gate, admin principal resolution, the 2FA-setup gate, the
 * admin 600/min bucket, and the AppError/SchemaValidationError ->
 * envelope mapping.
 */

import { createErrorEnvelope, createSuccessEnvelope } from "../../../../../packages/contracts/src/index.ts";
import { and } from "drizzle-orm";
import { AppError } from "../../shared/errors.ts";
import { checkBetterAuthFallbackAccess, recordTwoFactorStateChange } from "../../modules/identity/service.ts";
import { appendAuditLog } from "../../modules/audit/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { getClientIp, extractBearerToken, getBetterAuth } from "../../shared/http.ts";
export function registerAuthFallbackRoutes(app: Hono<AppEnv>): void {
  // Fallback: every other /api/auth/* path is handled by real
  // Better Auth (registered last so the explicit routes above win).
  app.all("/api/auth/*", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    if (
      pathname === "/api/auth/sign-up" ||
      pathname.startsWith("/api/auth/sign-up/")
    ) {
      throw new AppError(
        "FORBIDDEN",
        "Public self-registration is disabled. Staff accounts are provisioned by an administrator.",
        403
      );
    }

    // Direct Better Auth email sign-in is CLOSED for the same reason:
    // POST /api/auth/sign-in above is the only sign-in path. It
    // requires a StackMate staff record and rejects suspended staff
    // BEFORE any session is issued; the raw Better Auth route
    // (/api/auth/sign-in/email) checks neither, so a suspended user
    // could mint a live session through it. Admin routes re-check
    // staff status on every request, so that session could not call
    // the admin API — but the bypass is closed anyway, defence in
    // depth. Internal server-side calls use auth.api.signInEmail
    // directly and are unaffected.
    //
    // EXCEPTION (Auth + Email batch): /api/auth/sign-in/social is
    // open — it is the OAuth entry point. The databaseHooks in
    // better-auth.ts (user.create.before always false,
    // session.create.before rejects suspended staff) are the gate
    // there: a non-staff Google/GitHub login can never mint a user
    // or a session.
    if (
      pathname.startsWith("/api/auth/sign-in/") &&
      pathname !== "/api/auth/sign-in/social"
    ) {
      throw new AppError(
        "FORBIDDEN",
        "Use POST /api/auth/sign-in. Direct Better Auth sign-in routes are disabled.",
        403
      );
    }

    // Fallback: every other /api/auth/* path is handled by real Better Auth.
    //
    // UNIFIED SESSIONS (2026-11-15, Fix 2): staff sign-in, session
    // validation, sign-out and password change above all go through
    // Better Auth sessions (Drizzle `sessions` table). The custom
    // identity service only maps a Better Auth user to StackMate
    // roles/permissions and enforces suspension. The only remaining
    // seam is the in-memory test adapter (no Postgres, no Better
    // Auth) — see modules/identity/service.ts header.
    const auth = await getBetterAuth(env, store);
    // M-10 (audit fix batch): gate the Better Auth fallback the
    // same way as the custom /api/auth/* routes — unknown paths
    // 404, session paths require a live staff principal (401), and
    // 2FA-setup-required roles are held at 403 except on the setup
    // paths. The check throws and the outer catch turns it into
    // the standard JSON error envelope; it never consumes the
    // request body, so auth.handler below still reads it.
    const { principal: fallbackPrincipal } =
      await checkBetterAuthFallbackAccess(store, {
        auth,
        cookieHeader: request.headers.get("Cookie"),
        bearerToken: extractBearerToken(
          request.headers.get("Authorization")
        ),
        pathname,
      });
    const fallbackResponse = await auth.handler(request);
    // F-03: the fallback used to return Better Auth's raw Response
    // (flat `{ code, message }` errors, no standard headers). JSON
    // responses are re-emitted in the StackMate envelope with the
    // standard headers merged (Set-Cookie preserved — the session
    // cookies must survive the rewrite). Two exceptions:
    //  - non-JSON responses (OAuth 302 redirects, empty bodies)
    //    pass through untouched — wrapping would break the flow;
    //  - /api/auth/two-factor/* keeps its RAW body: the SPA's
    //    rawApiRequest reads `{ totpURI, backupCodes }` directly
    //    from enable, and the spec allows the raw shape there.
    //    Only the headers are standardized on those paths.
    // M-10: audit 2FA state changes that happen through the
    // fallback — Better Auth itself writes no StackMate audit row.
    // Only on a successful response: a failed enable/disable
    // changes nothing. recordTwoFactorStateChange never throws
    // (a failed audit write must not break the 2FA response).
    // A-13: same for update-user — a profile change through the
    // fallback writes an audit row (action
    // `identity.auth.update_user`, distinct from PATCH /me's
    // `identity.profile.name_updated`, which stays the account
    // menu's own audited path).
    if (fallbackResponse.ok && fallbackPrincipal) {
      if (
        pathname === "/api/auth/two-factor/enable" ||
        pathname === "/api/auth/two-factor/disable"
      ) {
        await recordTwoFactorStateChange(store, {
          userId: fallbackPrincipal.user.id,
          enabled: pathname === "/api/auth/two-factor/enable",
          requestId,
        });
      } else if (pathname === "/api/auth/update-user") {
        await store
          .withTransaction((state) => {
            appendAuditLog(state, {
              actor_type: "staff",
              actor_user_id: fallbackPrincipal.user.id,
              action: "identity.auth.update_user",
              resource_type: "user",
              resource_id: fallbackPrincipal.user.id,
              outcome: "success",
              request_id: requestId,
            });
          })
          .catch(() => {});
      }
    }
    const fallbackContentType =
      fallbackResponse.headers.get("Content-Type") ?? "";
    if (!fallbackContentType.includes("application/json")) {
      return fallbackResponse;
    }
    const fallbackText = await fallbackResponse.text();
    let fallbackBody: unknown = null;
    try {
      fallbackBody = JSON.parse(fallbackText);
    } catch {
      return fallbackResponse;
    }
    const fallbackHeaders = new Headers();
    const fallbackCookies =
      typeof fallbackResponse.headers.getSetCookie === "function"
        ? fallbackResponse.headers.getSetCookie()
        : [];
    for (const cookie of fallbackCookies) {
      fallbackHeaders.append("Set-Cookie", cookie);
    }
    const isTwoFactorPath = pathname.startsWith("/api/auth/two-factor/");
    if (isTwoFactorPath) {
      return new Response(JSON.stringify(fallbackBody), {
        status: fallbackResponse.status,
        headers: fallbackHeaders,
      });
    }
    if (fallbackResponse.ok) {
      return new Response(
        JSON.stringify(createSuccessEnvelope(fallbackBody, requestId)),
        { status: fallbackResponse.status, headers: fallbackHeaders }
      );
    }
    const flatError = fallbackBody as { code?: unknown; message?: unknown } | null;
    const flatCode = typeof flatError?.code === "string" ? flatError.code : "";
    const flatMessage =
      typeof flatError?.message === "string" ? flatError.message : "";
    const knownCodes = new Set([
      "VALIDATION_ERROR",
      "BAD_REQUEST",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "GONE",
      "CONFLICT",
      "RATE_LIMIT_EXCEEDED",
      "INTERNAL_ERROR",
    ]);
    const mappedCode = knownCodes.has(flatCode)
      ? (flatCode as
          | "VALIDATION_ERROR"
          | "BAD_REQUEST"
          | "UNAUTHORIZED"
          | "FORBIDDEN"
          | "NOT_FOUND"
          | "GONE"
          | "CONFLICT"
          | "RATE_LIMIT_EXCEEDED"
          | "INTERNAL_ERROR")
      : fallbackResponse.status === 401
        ? "UNAUTHORIZED"
        : fallbackResponse.status === 403
          ? "FORBIDDEN"
          : fallbackResponse.status === 404
            ? "NOT_FOUND"
            : fallbackResponse.status === 429
              ? "RATE_LIMIT_EXCEEDED"
              : fallbackResponse.status === 400 ||
                  fallbackResponse.status === 422
                ? "VALIDATION_ERROR"
                : "INTERNAL_ERROR";
    return new Response(
      JSON.stringify(
        createErrorEnvelope(
          mappedCode,
          flatMessage || `Better Auth request failed with status ${fallbackResponse.status}.`,
          requestId,
          flatCode && flatCode !== mappedCode ? { better_auth_code: flatCode } : null
        )
      ),
      { status: fallbackResponse.status, headers: fallbackHeaders }
    );
  });
}
