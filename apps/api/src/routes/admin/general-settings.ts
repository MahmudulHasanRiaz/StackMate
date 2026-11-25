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

import { and } from "drizzle-orm";
import { StackMateDataStore } from "../../platform/db/store.ts";
import { DEFAULT_GENERAL_SETTINGS, loadGeneralSettings, publicViewOf, saveGeneralSettings, storeFavicon } from "../../modules/general-settings/service.ts";
import { resolveStorageDriver } from "../../platform/storage/driver.ts";
import { AppError } from "../../shared/errors.ts";
import { assertStaffPermissionAudited, type StaffPrincipal } from "../../modules/identity/service.ts";
import { appendAuditLog } from "../../modules/audit/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, readJsonBody, readJsonBodyLenient, driverDepsForRequest } from "../../shared/http.ts";

function requireGeneralSettingsDb(store: StackMateDataStore) {
  const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
  if (!maybeDrizzle.drizzleDb) {
    throw new AppError("STORE_UNAVAILABLE", "General settings require a database.", 503);
  }
  return maybeDrizzle.drizzleDb as Parameters<typeof loadGeneralSettings>[0];
}

function auditGeneralSettingsChange(
  store: StackMateDataStore,
  principal: StaffPrincipal,
  requestId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  return store
    .withTransaction((state) => {
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: principal.user.id,
        action: "general.settings.updated",
        resource_type: "general_settings",
        resource_id: "general-settings",
        outcome: "success",
        request_id: requestId,
        changes,
      });
    })
    .catch(() => {});
}

export function registerAdminGeneralSettingsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/general-settings", async (c) => {
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
    const row = await loadGeneralSettings(requireGeneralSettingsDb(store));
    return jsonResponse(c, row ? { ...publicViewOf(row), favicon_content_type: row.faviconContentType, favicon_byte_size: row.faviconByteSize } : { ...DEFAULT_GENERAL_SETTINGS, favicon_content_type: null, favicon_byte_size: null });
  });
  app.put("/api/v1/admin/general-settings", async (c) => {
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
      app_name?: string;
      app_title?: string;
      app_description?: string;
      support_email?: string;
      clear_favicon?: boolean;
    };
    const saved = await saveGeneralSettings(requireGeneralSettingsDb(store), body);
    const changes: Record<string, unknown> = {};
    if (body.app_name !== undefined) changes.app_name = body.app_name.trim();
    if (body.app_title !== undefined) changes.app_title = body.app_title.trim();
    if (body.app_description !== undefined) changes.app_description = body.app_description;
    if (body.support_email !== undefined) changes.support_email = body.support_email.trim();
    if (body.clear_favicon === true) changes.favicon_cleared = true;
    await auditGeneralSettingsChange(store, principal, requestId, changes);
    return jsonResponse(c, saved);
  });
  app.post("/api/v1/admin/general-settings/favicon", async (c) => {
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
    const body = (await readJsonBody(c)) as {
      filename?: string;
      content_type?: string;
      content_base64?: string;
    };
    if (!body.filename || !body.content_type || !body.content_base64) {
      throw new AppError(
        "VALIDATION_ERROR",
        "filename, content_type, and content_base64 are required.",
        422
      );
    }
    // Storage driver (PLAN §31): the favicon lands on the selected
    // driver (R2 or Local); resolveStorageDriver fails closed in
    // staging/production when no real R2 bucket is configured.
    const faviconDriver = await resolveStorageDriver(driverDepsForRequest(store, env));
    const bytes = new Uint8Array(Buffer.from(body.content_base64, "base64"));
    const stored = await storeFavicon(requireGeneralSettingsDb(store), faviconDriver, {
      filename: body.filename,
      contentType: body.content_type,
      bytes,
      bucketName: faviconDriver.name === "r2" ? env.R2_BUCKET_NAME : "local",
    });
    await auditGeneralSettingsChange(store, principal, requestId, { favicon_uploaded: true, content_type: stored.content_type });
    return jsonResponse(c, stored, 201);
  });
}
