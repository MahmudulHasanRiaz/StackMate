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

import { StackMateDataStore } from "../../platform/db/store.ts";
import { listMediaAssets } from "../../modules/media/service.ts";
import { DEFAULT_STORAGE_SETTINGS, loadStorageSettings, saveStorageSettings } from "../../platform/storage/settings.ts";
import { AppError } from "../../shared/errors.ts";
import { assertStaffPermissionAudited } from "../../modules/identity/service.ts";
import { appendAuditLog } from "../../modules/audit/service.ts";
import { getReminderSettings, saveReminderSettings } from "../../modules/reminders/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, readJsonBody, readJsonBodyLenient } from "../../shared/http.ts";

function requireMediaDb(store: StackMateDataStore) {
  const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
  if (!maybeDrizzle.drizzleDb) {
    throw new AppError("STORE_UNAVAILABLE", "Media library requires a database.", 503);
  }
  return maybeDrizzle.drizzleDb as Parameters<typeof listMediaAssets>[0];
}

export function registerAdminSettingsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/storage-settings", async (c) => {
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
    const settings = await loadStorageSettings(requireMediaDb(store)).catch(() => null);
    return jsonResponse(c, settings ?? DEFAULT_STORAGE_SETTINGS);
  });
  app.put("/api/v1/admin/storage-settings", async (c) => {
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
      driver?: "r2" | "local";
      local_path?: string | null;
    };
    const saved = await saveStorageSettings(requireMediaDb(store), body);
    await store
      .withTransaction((state) => {
        appendAuditLog(state, {
          actor_type: "staff",
          actor_user_id: principal.user.id,
          action: "storage.settings.updated",
          resource_type: "storage_settings",
          resource_id: "storage-settings",
          outcome: "success",
          request_id: requestId,
          changes: { driver: saved.driver, local_path: saved.local_path },
        });
      })
      .catch(() => {});
    return jsonResponse(c, saved);
  });
  app.get("/api/v1/admin/reminder-settings", async (c) => {
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
    return jsonResponse(c, getReminderSettings(store.state));
  });
  app.put("/api/v1/admin/reminder-settings", async (c) => {
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
    const body = await readJsonBody(c);
    const db = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
      | Parameters<typeof saveReminderSettings>[0]
      | undefined;
    if (!db) {
      throw new AppError(
        "STORE_UNAVAILABLE",
        "Reminder settings require the database store.",
        503
      );
    }
    const saved = await saveReminderSettings(db, body);
    // Best-effort audit (same shape as general settings): the
    // settings save itself already succeeded.
    await store
      .withTransaction((state) => {
        appendAuditLog(state, {
          actor_type: "staff",
          actor_user_id: principal.user.id,
          action: "settings.reminder_settings.updated",
          resource_type: "general_settings",
          resource_id: "reminder-settings",
          outcome: "success",
          request_id: requestId,
          changes: { ...saved },
        });
      })
      .catch(() => {});
    return jsonResponse(c, saved);
  });
}
