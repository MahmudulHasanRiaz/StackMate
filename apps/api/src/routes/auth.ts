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

import { createHash } from "node:crypto";
import { sha256Hex, verifyTokenHash } from "../platform/crypto/index.ts";
import { and } from "drizzle-orm";
import { AppError } from "../shared/errors.ts";
import { acceptStaffInvitation, bootstrapInitialSuperAdmin, ensureBetterAuthIdentity, resolveStaffPrincipal, resolveTokenPepper, signInStaffSession, signOutStaffSession, storeSupportsBetterAuth } from "../modules/identity/service.ts";
import { appendAuditLog } from "../modules/audit/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../types/context.ts";
import { jsonResponse, jsonResponseWithCookies, readJsonBody, getClientIp, extractBearerToken, setupTokenMatches, assertSameSiteCookieMutation, getBetterAuth } from "../shared/http.ts";
import { capTokenAttempts } from "../shared/idempotency.ts";
export function registerAuthRoutes(app: Hono<AppEnv>): void {
  // NOTE (wiring): the block-level auth rate limit (app.ts §2, 60/min
  // per IP) is applied ONCE by the chain `rateLimit` middleware
  // (middleware/rate-limit.ts, `/api/auth*` → `auth:<ip>`). The
  // `app.use("/api/auth/*", ...)` duplicate that used to live here
  // counted every auth request TWICE against the same bucket, so a
  // suite making ~34 auth requests exhausted the 60/min bucket at
  // hit #61 and 429'd (auth-email 2FA-disable test). Removed.
  app.post("/api/auth/bootstrap-super-admin", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    // TOKEN-GATED first-admin bootstrap (Security, 2026-11-15 — the
    // open endpoint it replaces let anyone who found the URL claim
    // a fresh instance, so it must never ship to production):
    //  - SETUP_TOKEN unset/empty => the endpoint does not exist:
    //    404 identical to an unknown route, so a prober cannot
    //    tell it apart from any other missing path.
    //  - SETUP_TOKEN set but the request's setupToken is missing or
    //    wrong => 403 with a generic message (no hint about the
    //    configured token). Compared in constant time.
    //  - Single-use is unchanged: bootstrapInitialSuperAdmin throws
    //    409 once a super_admin exists. Password >= 10 chars,
    //    auth rate limiting, and Better Auth provisioning are
    //    unchanged. The token is the operator-set Worker secret
    //    SETUP_TOKEN (Cloudflare dashboard, never in code).
    const configuredSetupToken = env.SETUP_TOKEN?.trim() ?? "";
    if (!configuredSetupToken) {
      throw new AppError(
        "NOT_FOUND",
        `Route '${method} ${pathname}' not found.`,
        404
      );
    }
    const body = (await readJsonBody(c)) as {
      name?: string;
      email?: string;
      password?: string;
      setupToken?: string;
    };
    // L-13(b): a non-string setupToken used to reach
    // setupTokenMatches and throw a bare TypeError (500). A
    // wrong-typed token is simply an invalid token — 403, no hint.
    if (
      typeof body.setupToken !== "string" ||
      !setupTokenMatches(body.setupToken, configuredSetupToken)
    ) {
      throw new AppError(
        "FORBIDDEN",
        "Setup token is missing or invalid.",
        403
      );
    }
    if (!body.name || !body.email || !body.password) {
      throw new AppError(
        "VALIDATION_ERROR",
        "name, email, and password are required.",
        422
      );
    }
    // L-13(b): validate the shape here so a malformed bootstrap
    // fails 422 at the route instead of a downstream 500/DB
    // error. Name is capped (users.name is unbounded text);
    // email is format-checked and capped at the varchar(320).
    const bootstrapName = body.name.trim();
    const bootstrapEmail = body.email.trim().toLowerCase();
    if (bootstrapName.length === 0 || bootstrapName.length > 200) {
      throw new AppError(
        "VALIDATION_ERROR",
        "name must be 1–200 characters.",
        422
      );
    }
    if (
      bootstrapEmail.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapEmail)
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "email must be a valid email address.",
        422
      );
    }
    const created = await bootstrapInitialSuperAdmin(store, {
      name: bootstrapName,
      email: bootstrapEmail,
      password: body.password,
      requestId,
    });
    // Provision the Better Auth identity for the same email, so the
    // first sign-in goes through Better Auth directly. Best-effort:
    // if provisioning fails here, sign-in lazily migrates the
    // account (see identity/service.ts) and never duplicates it.
    if (storeSupportsBetterAuth(store)) {
      await ensureBetterAuthIdentity(store, {
        userId: created.user.id,
        email: bootstrapEmail,
        password: body.password,
      }).catch(() => {});
    }
    return jsonResponse(c, created, 201);
  });
  app.post("/api/auth/sign-in", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const body = (await readJsonBody(c)) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      throw new AppError("VALIDATION_ERROR", "email and password are required.", 422);
    }
    // C-1: per-account lockout — 10 failed sign-ins in 15 minutes
    // lock the account's sign-in (429). The probe runs BEFORE the
    // password check so a locked account never burns a bcrypt
    // hash; failures increment afterwards, a success clears the
    // bucket. Keyed by email hash (never the raw email) so the
    // bucket key leaks nothing. Unknown emails accumulate too,
    // so a 429 reveals nothing about whether the account exists.
    // F-08 / OD-12 (owner decision pending — behaviour
    // deliberately UNCHANGED here): per-account lockout is also
    // an account-lockout DoS — anyone who knows a staff email
    // can lock that account for 15 minutes at will, repeatedly,
    // and the per-IP bucket does not stop it because the lockout
    // key is per-email. Options for the owner: accept the
    // trade-off (documented), add a CAPTCHA / proof-of-work /
    // IP-reputation step before counting failures toward the
    // lockout, or lock out per (account, IP) instead of per
    // account alone. Do not "fix" this unilaterally — it
    // changes the sign-in security posture.
    const normalizedSignInEmail = body.email.trim().toLowerCase();
    const signInLockoutKey = `signin-fail:${createHash("sha256").update(normalizedSignInEmail, "utf8").digest("hex")}`;
    if (await store.isRateLimited(signInLockoutKey, 10, 15 * 60_000)) {
      throw new AppError(
        "RATE_LIMIT_EXCEEDED",
        "Too many failed sign-in attempts for this account. Try again later.",
        429
      );
    }
    const auth = storeSupportsBetterAuth(store)
      ? await getBetterAuth(env, store)
      : null;
    let signedIn: Awaited<ReturnType<typeof signInStaffSession>>;
    try {
      signedIn = await signInStaffSession(
        store,
        {
          email: body.email,
          password: body.password,
          ipAddress: clientIp,
          userAgent: request.headers.get("User-Agent"),
          requestId,
        },
        auth
      );
    } catch (error) {
      // Count the failure; the 10th failure answers 429 instead
      // of the underlying 401 (the account just locked).
      await store.checkRateLimit(signInLockoutKey, 10, 15 * 60_000);
      throw error;
    }
    // Success clears the failure bucket, so typos never lock a
    // legitimate user out. Best-effort: a reset failure must
    // never break a successful sign-in.
    await store.resetRateLimit(signInLockoutKey).catch(() => {});
    // A-01: the session token is cookie-only — it is NEVER
    // returned in the JSON body (the SPA never reads the field;
    // any XSS/script/extension/proxy logging bodies could steal
    // a live staff session from it). The cookie below (Better
    // Auth set_cookie, or the HttpOnly stackmate_session cookie
    // on the test-adapter path) is the only channel.
    const payload = {
      expires_at: signedIn.expires_at,
      principal: signedIn.principal,
    };
    // 2FA challenge (Auth + Email batch): the password was right
    // but TOTP is on — no session exists yet, so the SPA shows the
    // TOTP prompt instead of signing in. The plugin's verification
    // cookie is forwarded in set_cookie, as in the normal path.
    if (signedIn.two_factor_redirect) {
      const challengePayload = {
        two_factor_redirect: true,
        principal: signedIn.principal,
      };
      if (auth) {
        return jsonResponseWithCookies(c, challengePayload, 200, signedIn.set_cookie);
      }
      return jsonResponse(c, challengePayload, 200);
    }
    if (auth) {
      // Better Auth path: forward the signed session cookie(s) it issued.
      return jsonResponseWithCookies(c, payload, 200, signedIn.set_cookie);
    }
    const isProd = env.APP_ENV === "production" || env.APP_ENV === "staging";
    const cookieName = isProd ? "__Host-stackmate_session" : "stackmate_session";
    const cookieValue = `${cookieName}=${signedIn.session_token}; Path=/; HttpOnly; SameSite=Lax${isProd ? "; Secure" : ""}`;
    return jsonResponse(c, payload, 200, { "Set-Cookie": cookieValue });
  });
  app.post("/api/auth/sign-out", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    // L-1: signing out is a cookie-authenticated mutation — a
    // cross-site page must not be able to log the admin out.
    assertSameSiteCookieMutation(c, request);
    const cookieHeader = request.headers.get("Cookie");
    const bearerToken = extractBearerToken(request.headers.get("Authorization"));
    const auth = storeSupportsBetterAuth(store)
      ? await getBetterAuth(env, store)
      : null;
    const result = await signOutStaffSession(store, {
      auth,
      cookieHeader,
      bearerToken,
    });
    return jsonResponseWithCookies(c, { signed_out: true }, 200, [
      ...result.set_cookie,
      "stackmate_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
    ]);
  });
  app.get("/api/auth/session", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const auth = storeSupportsBetterAuth(store)
      ? await getBetterAuth(env, store)
      : null;
    const principal = await resolveStaffPrincipal(store, {
      auth,
      cookieHeader: request.headers.get("Cookie"),
      bearerToken: extractBearerToken(request.headers.get("Authorization")),
    });
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "No active staff session.", 401);
    }
    return jsonResponse(c, { principal });
  });
  app.post("/api/auth/accept-invitation", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    // Public invitation acceptance (Batch 1): no session required —
    // the invitation token IS the credential. Rate-limited like
    // sign-in (60/min per IP, checked at the top of this block).
    // No email is sent anywhere in this flow: invitations are
    // created by an admin who delivers the one-time link to the
    // invitee out of band (there is no email system yet — Batch 5).
    const body = (await readJsonBody(c)) as {
      token?: string;
      name?: string;
      password?: string;
    };
    if (!body.token || !body.name || !body.password) {
      throw new AppError(
        "VALIDATION_ERROR",
        "token, name, and password are required.",
        422
      );
    }
    // A-06: per-token attempt cap (5/hour, then the invitation
    // is expired) — a brute-forced invitation token cannot be
    // retried indefinitely.
    await capTokenAttempts(c, `invite-attempt:${sha256Hex(body.token)}`, async () => {
      const pepper = resolveTokenPepper(store, env.ENCRYPTION_KEY_V1);
      await store.withTransaction((state) => {
        const invitation = (state.staff_invitations ?? []).find(
          (i) =>
            i.status === "pending" &&
            verifyTokenHash(body.token!, i.token_hash, pepper)
        );
        if (invitation) {
          invitation.status = "expired";
          invitation.updated_at = new Date().toISOString();
          appendAuditLog(state, {
            actor_type: "system",
            action: "identity.invitation.expired",
            resource_type: "staff_invitation",
            resource_id: invitation.id,
            outcome: "success",
            request_id: requestId,
            changes: { email: invitation.email, reason: "too_many_attempts" },
          });
        }
      });
    });
    const accepted = await acceptStaffInvitation(
      store,
      {
        token: body.token,
        name: body.name,
        password: body.password,
      },
      requestId
    );
    // Provision the Better Auth identity for the same email, so the
    // invitee can sign in directly. Best-effort, as in bootstrap:
    // if provisioning fails here, sign-in lazily migrates.
    if (storeSupportsBetterAuth(store)) {
      await ensureBetterAuthIdentity(store, {
        userId: accepted.user.id,
        email: accepted.user.email,
        password: body.password,
      }).catch(() => {});
    }
    return jsonResponse(c, accepted, 201);
  });
}
