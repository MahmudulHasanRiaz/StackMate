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
import { sha256Hex } from "../../platform/crypto/index.ts";
import { and, eq } from "drizzle-orm";
import { passwordResetTokens as baPasswordResetTokens } from "../../../../../db/schema/auth-config.ts";
import { buildPasswordResetEmail, isSmtpConfigured } from "../../modules/email/service.ts";
import { loadAuthConfig } from "../../modules/auth-config/service.ts";
import { AppError } from "../../shared/errors.ts";
import { changeStaffPassword, createPasswordResetToken, resetStaffPasswordByToken, resolveStaffPrincipal, storePasswordResetToken, storeSupportsBetterAuth } from "../../modules/identity/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, readJsonBody, readJsonBodyLenient, getClientIp, extractBearerToken, assertSameSiteCookieMutation, getBetterAuth, sendEmailViaSmtp } from "../../shared/http.ts";
import { capTokenAttempts } from "../../shared/idempotency.ts";
export function registerAuthPasswordRoutes(app: Hono<AppEnv>): void {
  app.post("/api/auth/change-password", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    // L-1: cookie-authenticated mutation — cross-site requests
    // are blocked before any password work happens.
    assertSameSiteCookieMutation(c, request);
    const body = (await readJsonBody(c)) as {
      current_password?: string;
      new_password?: string;
    };
    if (!body.current_password || !body.new_password) {
      throw new AppError(
        "VALIDATION_ERROR",
        "current_password and new_password are required.",
        422
      );
    }
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
    const changed = await changeStaffPassword(store, principal, {
      auth,
      cookieHeader: request.headers.get("Cookie"),
      currentPassword: body.current_password,
      newPassword: body.new_password,
      requestId,
    });
    return jsonResponse(c, changed, 200);
  });
  app.post("/api/auth/forgot-password", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const body = (await readJsonBodyLenient(c)) as { email?: string };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email) {
      const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
      const user = store.state.users.find(
        (u) => u.email.toLowerCase() === email && u.status === "active"
      );
      if (user && maybeDrizzle.drizzleDb) {
        try {
          // Auth + Email fix batch: when SMTP is not configured
          // no token is minted and nothing is sent — an
          // undeliverable token row is never created. The
          // generic 200 below is the only answer either way, so
          // the endpoint still reveals nothing about the account.
          const emailReady = await isSmtpConfigured(
            maybeDrizzle.drizzleDb as Parameters<typeof isSmtpConfigured>[0],
            {
              encryptionKey: env.ENCRYPTION_KEY_V1,
              keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
            }
          ).catch(() => false);
          if (emailReady) {
            // H-5: per-email 60s cooldown, keyed by email hash.
            // A throttled resend is skipped, not an error — the
            // generic 200 below is the only answer either way.
            let cooledDown = false;
            try {
              await store.checkRateLimit(
                `forgot-password:${createHash("sha256").update(email, "utf8").digest("hex")}`,
                1,
                60_000
              );
            } catch (error) {
              if (error instanceof AppError && error.code === "RATE_LIMIT_EXCEEDED") {
                cooledDown = true;
              } else {
                throw error;
              }
            }
            if (!cooledDown) {
              const token = createPasswordResetToken(store, user.id, "password_reset");
              await storePasswordResetToken(
                store, user.id, "password_reset", token.tokenHash, token.expiresAt
              );
              await sendEmailViaSmtp(store, env, {
                to: user.email,
                ...buildPasswordResetEmail(env.APP_URL, token.rawToken),
              }).catch(() => {});
            }
          }
        } catch {
          // Fail closed + silent: the generic 200 below is the only
          // answer, whatever happened inside.
        }
      }
    }
    return jsonResponse(c, {
      message:
        "If an account exists for that email, a reset link has been sent. Check your inbox.",
    });
  });
  app.post("/api/auth/reset-password", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const body = (await readJsonBodyLenient(c)) as {
      token?: string;
      new_password?: string;
    };
    if (!body.token || !body.new_password) {
      throw new AppError("VALIDATION_ERROR", "token and new_password are required.", 422);
    }
    // A-06: per-token attempt cap (5/hour, then the token row is
    // deleted) — a brute-forced reset token cannot be retried
    // indefinitely. On the test adapter there is no token table
    // (tokens live only in Drizzle), so invalidation is a no-op
    // there and the cap alone still binds.
    await capTokenAttempts(c, `reset-attempt:${sha256Hex(body.token)}`, async () => {
      const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
        | Parameters<typeof loadAuthConfig>[0]
        | undefined;
      if (!db) return;
      await db
        .delete(baPasswordResetTokens)
        .where(
          and(
            eq(baPasswordResetTokens.tokenHash, sha256Hex(body.token!)),
            eq(baPasswordResetTokens.purpose, "password_reset")
          )
        )
        .catch(() => {});
    });
    const result = await resetStaffPasswordByToken(store, {
      token: body.token,
      newPassword: body.new_password,
      requestId,
    });
    return jsonResponse(c, { user_id: result.user_id, email: result.email });
  });
}
