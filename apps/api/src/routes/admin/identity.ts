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

import { AppError } from "../../shared/errors.ts";
import { assertStaffPermissionAudited, createRoleByAdmin, updateRoleByAdmin } from "../../modules/identity/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, collectionResponse, pagedCollectionResponse, parseListQuery, readJsonBody } from "../../shared/http.ts";
export function registerAdminIdentityRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/roles", async (c) => {
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
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, store.state.roles, limit, page);
  });
  app.get("/api/v1/admin/permissions", async (c) => {
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
    // L-5: the permission catalogue is readable only to staff who
    // can manage users/roles (same gate as /roles) — it leaks the
    // RBAC surface otherwise. Deliberately NOT paged (M-1): it is
    // a fixed catalogue, not a table, so it cannot grow
    // unboundedly; the role editor needs the whole list at once.
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    return collectionResponse(c, [...store.allPermissions]);
  });
  app.post("/api/v1/admin/roles", async (c) => {
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
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const body = await readJsonBody(c);
    const created = await createRoleByAdmin(store, principal, body, requestId);
    return jsonResponse(c, created, 201);
  });
  app.patch("/api/v1/admin/roles/:roleId", async (c) => {
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
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "users.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updateRoleByAdmin(
      store,
      principal,
      c.req.param("roleId")!,
      body,
      requestId
    );
    return jsonResponse(c, updated);
  });
}
