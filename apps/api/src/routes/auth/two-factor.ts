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
import { buildTwoFactorRecoveryEmail, isSmtpConfigured } from "../../modules/email/service.ts";
import { loadAuthConfig } from "../../modules/auth-config/service.ts";
import { AppError } from "../../shared/errors.ts";
import { createPasswordResetToken, recoverTwoFactorByToken, storePasswordResetToken } from "../../modules/identity/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, readJsonBodyLenient, getClientIp, getBetterAuth, sendEmailViaSmtp } from "../../shared/http.ts";
import { capTokenAttempts } from "../../shared/idempotency.ts";
export function registerAuthTwoFactorRoutes(app: Hono<AppEnv>): void {
  app.post("/api/auth/two-factor/recover", async (c) => {
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
      if (user && user.two_factor_enabled && maybeDrizzle.drizzleDb) {
        try {
          // Same rule as forgot-password (fix batch): no token is
          // minted when SMTP is not configured. Generic 200 below
          // either way.
          const emailReady = await isSmtpConfigured(
            maybeDrizzle.drizzleDb as Parameters<typeof isSmtpConfigured>[0],
            {
              encryptionKey: env.ENCRYPTION_KEY_V1,
              keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
            }
          ).catch(() => false);
          if (emailReady) {
            // H-5 (same class as forgot-password): per-email 60s
            // cooldown on recovery mail. Throttled resends are
            // skipped, not errors — the generic 200 below is the
            // only answer either way.
            let cooledDown = false;
            try {
              await store.checkRateLimit(
                `two-factor-recovery:${createHash("sha256").update(email, "utf8").digest("hex")}`,
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
              const token = createPasswordResetToken(store, user.id, "two_factor_recovery");
              await storePasswordResetToken(
                store, user.id, "two_factor_recovery", token.tokenHash, token.expiresAt
              );
              await sendEmailViaSmtp(store, env, {
                to: user.email,
                ...buildTwoFactorRecoveryEmail(env.APP_URL, token.rawToken),
              }).catch(() => {});
            }
          }
        } catch {
          // Generic 200 below, whatever happened inside.
        }
      }
    }
    return jsonResponse(c, {
      message:
        "If 2FA is enabled for that email, a recovery link has been sent. Check your inbox.",
    });
  });
  app.post("/api/auth/two-factor/recover/confirm", async (c) => {
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
      password?: string;
    };
    if (!body.token || !body.password) {
      throw new AppError("VALIDATION_ERROR", "token and password are required.", 422);
    }
    // A-06: per-token attempt cap (5/hour, then the recovery
    // token row is deleted) — same rule as reset-password.
    await capTokenAttempts(c, `recovery-attempt:${sha256Hex(body.token)}`, async () => {
      const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
        | Parameters<typeof loadAuthConfig>[0]
        | undefined;
      if (!db) return;
      await db
        .delete(baPasswordResetTokens)
        .where(
          and(
            eq(baPasswordResetTokens.tokenHash, sha256Hex(body.token!)),
            eq(baPasswordResetTokens.purpose, "two_factor_recovery")
          )
        )
        .catch(() => {});
    });
    const auth = await getBetterAuth(env, store);
    const result = await recoverTwoFactorByToken(
      store,
      { token: body.token, password: body.password, requestId },
      auth
    );
    return jsonResponse(c, { user_id: result.user_id, email: result.email });
  });
}
