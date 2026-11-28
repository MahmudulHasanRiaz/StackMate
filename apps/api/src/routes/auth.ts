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
import { createErrorEnvelope, createSuccessEnvelope } from "../../../../packages/contracts/src/index.ts";
import { sha256Hex, verifyTokenHash } from "../platform/crypto/index.ts";
import { and } from "drizzle-orm";
import type { StackMateBindings } from "../env.ts";
import { AppError } from "../shared/errors.ts";
import { acceptStaffInvitation, bootstrapInitialSuperAdmin, ensureBetterAuthIdentity, resolveStaffPrincipal, resolveTokenPepper, signInStaffSession, signOutStaffSession, storeSupportsBetterAuth } from "../modules/identity/service.ts";
import { requestVerificationEmail, type VerificationEmailResult } from "../modules/identity/email-verification.ts";
import type { StackMateDataStore } from "../platform/db/store.ts";
import { appendAuditLog } from "../modules/audit/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../types/context.ts";
import { jsonResponse, jsonResponseWithCookies, readJsonBody, getClientIp, extractBearerToken, setupTokenMatches, assertSameSiteCookieMutation, getBetterAuth } from "../shared/http.ts";
import { capTokenAttempts } from "../shared/idempotency.ts";

/**
 * OD-06: best-effort verification-email send (twin of the helper in
 * routes/admin/users.ts — route modules stay self-contained; hoisting
 * to shared/http.ts is a later cleanup, not this slice). Never throws:
 * without a Drizzle-backed store (the in-memory test adapter) there
 * is no SMTP / Better Auth to send through, so the honest answer is
 * "not configured". The public resend caller answers 200 either way.
 */
async function sendVerificationEmailBestEffort(
  store: StackMateDataStore,
  env: StackMateBindings,
  email: string
): Promise<VerificationEmailResult> {
  try {
    const db = (
      store as unknown as {
        drizzleDb?: Parameters<typeof requestVerificationEmail>[0]["db"];
      }
    ).drizzleDb;
    if (!db || !storeSupportsBetterAuth(store)) {
      return {
        sent: false,
        error: "Email is not configured. Set up SMTP in Settings → Email.",
      };
    }
    const auth = await getBetterAuth(env, store);
    return await requestVerificationEmail({ db, env, auth, email });
  } catch (err) {
    return {
      sent: false,
      error:
        err instanceof Error
          ? err.message
          : "Verification email could not be sent.",
    };
  }
}
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
    // C-1: per-(account, IP) lockout — 10 failed sign-ins in 15 minutes
    // lock the (account, IP) pair's sign-in (429). The probe runs BEFORE the
    // password check so a locked pair never burns a bcrypt
    // hash; failures increment afterwards, a success clears the
    // bucket. Keyed by email hash + IP hash (never the raw email or
    // IP) so the bucket key leaks nothing. Unknown emails accumulate too,
    // so a 429 reveals nothing about whether the account exists.
    // OD-12 (2026-11-28): lockout is per (account, IP), not per account —
    // an attacker from one IP only locks that IP's attempts; the real user
    // from a different IP can still sign in.
    const normalizedSignInEmail = body.email.trim().toLowerCase();
    const signInLockoutKey = `signin-fail:${createHash("sha256").update(normalizedSignInEmail, "utf8").digest("hex")}:${createHash("sha256").update(clientIp, "utf8").digest("hex")}`;
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
  app.post("/api/auth/resend-verification", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const body = (await readJsonBody(c)) as { email?: unknown };
    // Input validation only (422) — never enumeration: every other
    // outcome answers the same generic 200 below, whether the address
    // is unknown, already verified, or suspended.
    if (!body || typeof body !== "object" || typeof body.email !== "string") {
      throw new AppError("VALIDATION_ERROR", "email must be a valid email address.", 422);
    }
    const email = body.email.trim().toLowerCase();
    if (
      email.length === 0 ||
      email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      throw new AppError("VALIDATION_ERROR", "email must be a valid email address.", 422);
    }
    // OD-06: per-IP + per-email-hash buckets (sign-in lockout key
    // style — sha256 of the normalized email, never the raw email).
    // A tripped bucket NEVER changes the outward answer: the send is
    // silently skipped and the endpoint still returns 200 { ok: true },
    // so a 429 can never leak whether the address exists or was
    // recently requested. The per-email bucket is counted only when
    // a send is actually attempted, so a prober cannot burn a
    // victim's resend budget with unknown-address requests.
    const emailBucketKey = `resend-verification-email:${createHash("sha256").update(email, "utf8").digest("hex")}`;
    const ipBucketKey = `resend-verification-ip:${clientIp}`;
    const limited =
      (await store.isRateLimited(emailBucketKey, 1, 60_000)) ||
      (await store.isRateLimited(ipBucketKey, 10, 60_000));
    if (!limited) {
      const user = store.state.users.find((u) => u.email === email);
      if (user && !user.email_verified && user.status === "active") {
        // Best-effort: a send failure is invisible here by design.
        await sendVerificationEmailBestEffort(store, env, email).catch(() => ({
          sent: false,
        }));
        await store.checkRateLimit(emailBucketKey, 1, 60_000).catch(() => {});
      }
      await store.checkRateLimit(ipBucketKey, 10, 60_000).catch(() => {});
    }
    return jsonResponse(c, { ok: true });
  });
  app.get("/api/auth/verify-email", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    // OD-06: GET /api/auth/verify-email MUST reach Better Auth.
    // The /api/auth/* fallback's M-10 gate
    // (checkBetterAuthFallbackAccess) 404s every path that is neither
    // public nor a known session path, and verify-email is in neither
    // set — so without this explicit route the verification link in
    // the email would 404. This route registers before the fallback
    // (registerAuthRoutes runs first in routes/index.ts), so it wins.
    // JSON bodies are re-emitted in the StackMate envelope exactly
    // like the fallback does; non-JSON responses (the 302 to the
    // callbackURL on success, the redirect with ?error= on a bad
    // token) pass through untouched.
    const auth = await getBetterAuth(env, store);
    const response = await auth.handler(request);
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/json")) {
      return response;
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return response;
    }
    const headers = new Headers();
    const cookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    if (response.ok) {
      return new Response(
        JSON.stringify(createSuccessEnvelope(parsed, requestId)),
        { status: response.status, headers }
      );
    }
    const flat = parsed as { code?: unknown; message?: unknown } | null;
    const flatCode = typeof flat?.code === "string" ? flat.code : "";
    const flatMessage = typeof flat?.message === "string" ? flat.message : "";
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
      : response.status === 401
        ? "UNAUTHORIZED"
        : response.status === 403
          ? "FORBIDDEN"
          : response.status === 404
            ? "NOT_FOUND"
            : response.status === 429
              ? "RATE_LIMIT_EXCEEDED"
              : response.status === 400 ||
                  response.status === 422
                ? "VALIDATION_ERROR"
                : "INTERNAL_ERROR";
    return new Response(
      JSON.stringify(
        createErrorEnvelope(
          mappedCode,
          flatMessage || `Better Auth request failed with status ${response.status}.`,
          requestId,
          flatCode && flatCode !== mappedCode ? { better_auth_code: flatCode } : null
        )
      ),
      { status: response.status, headers }
    );
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
