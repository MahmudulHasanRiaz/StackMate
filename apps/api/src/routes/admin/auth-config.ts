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

import { type StackMateBindings } from "../../env.ts";
import { and } from "drizzle-orm";
import { StackMateDataStore } from "../../platform/db/store.ts";
import { buildTestEmail } from "../../modules/email/service.ts";
import { loadAuthConfig, saveOAuthProvider, saveSmtpSettings, saveTwoFactorPolicy, toAuthConfigView, type ResolvedAuthConfig } from "../../modules/auth-config/service.ts";
import { AppError } from "../../shared/errors.ts";
import { assertStaffPermissionAudited, type StaffPrincipal } from "../../modules/identity/service.ts";
import { appendAuditLog } from "../../modules/audit/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, readJsonBodyLenient, sendEmailViaSmtp } from "../../shared/http.ts";

function requireAuthConfigDb(store: StackMateDataStore) {
  const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb;
  if (!db) {
    throw new AppError(
      "STORE_UNAVAILABLE",
      "Authentication configuration needs a database-backed store.",
      503,
    );
  }
  return db as Parameters<typeof loadAuthConfig>[0];
}

function authConfigDeps(env: StackMateBindings) {
  return {
    encryptionKey: env.ENCRYPTION_KEY_V1,
    keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
  };
}

function auditAuthConfigChange(
  store: StackMateDataStore,
  principal: StaffPrincipal,
  requestId: string,
  action: string,
  changes: Record<string, unknown>,
): Promise<void> {
  return store
    .withTransaction((state) => {
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: principal.user.id,
        action,
        resource_type: "auth_config",
        resource_id: "auth-config",
        outcome: "success",
        request_id: requestId,
        changes,
      });
    })
    .catch(() => {});
}

export function registerAdminAuthConfigRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/auth-config", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const config = await loadAuthConfig(requireAuthConfigDb(store), authConfigDeps(env));
    // Serialize through the view mapper: the raw ResolvedAuthConfig
    // is camelCase (twoFactorPolicy — the page reads
    // two_factor_policy and crashed) and carries the DECRYPTED
    // OAuth secrets / SMTP password. The view is snake_case and
    // secret-free, with defaults even when nothing is configured.
    return jsonResponse(c, toAuthConfigView(config));
  });
  app.put("/api/v1/admin/auth-config/oauth", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as {
      provider?: string;
      enabled?: boolean;
      client_id?: string;
      client_secret?: string;
    };
    const saved = await saveOAuthProvider(
      requireAuthConfigDb(store),
      authConfigDeps(env),
      {
        provider: body.provider ?? "",
        enabled: body.enabled ?? false,
        client_id: body.client_id ?? null,
        client_secret: body.client_secret ?? null,
      },
      env.HYPERDRIVE_NO_CACHE.connectionString
    );
    await auditAuthConfigChange(store, principal, requestId, "auth.oauth.updated", {
      provider: saved.provider,
      enabled: saved.enabled,
      client_id_changed: Boolean(body.client_id?.trim()),
      client_secret_changed: Boolean(body.client_secret?.trim()),
    });
    return jsonResponse(c, saved);
  });
  app.put("/api/v1/admin/auth-config/two-factor-policy", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as {
      scope?: string;
      mode?: string;
    };
    const saved = await saveTwoFactorPolicy(
      requireAuthConfigDb(store),
      { scope: body.scope ?? "", mode: body.mode ?? "" },
      env.HYPERDRIVE_NO_CACHE.connectionString
    );
    await auditAuthConfigChange(store, principal, requestId, "auth.two_factor_policy.updated", {
      scope: body.scope,
      mode: body.mode,
    });
    return jsonResponse(c, saved);
  });
  app.put("/api/v1/admin/auth-config/smtp", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as {
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      tls_mode?: string;
      from_address?: string;
      from_name?: string;
      enabled?: boolean;
    };
    const saved = await saveSmtpSettings(
      requireAuthConfigDb(store),
      authConfigDeps(env),
      {
        ...(body.host !== undefined ? { host: body.host } : {}),
        ...(body.port !== undefined ? { port: body.port } : {}),
        ...(body.username !== undefined ? { username: body.username } : {}),
        password: body.password ?? null,
        ...(body.tls_mode !== undefined ? { tls_mode: body.tls_mode } : {}),
        ...(body.from_address !== undefined ? { from_address: body.from_address } : {}),
        ...(body.from_name !== undefined ? { from_name: body.from_name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
      env.HYPERDRIVE_NO_CACHE.connectionString
    );
    await auditAuthConfigChange(store, principal, requestId, "auth.smtp.updated", {
      host: saved.host,
      port: saved.port,
      tls_mode: saved.tls_mode,
      from_address: saved.from_address,
      enabled: saved.enabled,
      password_changed: Boolean(body.password?.trim()),
    });
    return jsonResponse(c, saved);
  });
  app.post("/api/v1/admin/auth-config/smtp/test", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as { to?: string };
    // Test mail goes ONLY to the admin's own address — the
    // endpoint must never become an open mail relay.
    const to = (body.to ?? principal.user.email).trim().toLowerCase();
    if (to !== principal.user.email.toLowerCase()) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Test email can only be sent to your own address.",
        422
      );
    }
    const result = await sendEmailViaSmtp(store, env, {
      to,
      ...buildTestEmail(),
    });
    if (!result.sent) {
      throw new AppError(
        "INTERNAL_ERROR",
        result.error ?? "Test email could not be sent.",
        502
      );
    }
    return jsonResponse(c, { sent: true, to });
  });
}
