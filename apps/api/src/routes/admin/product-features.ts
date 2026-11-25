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
import { assertStaffPermissionAudited } from "../../modules/identity/service.ts";
import { archiveProductFeatureByAdmin, createProductFeature, createProductFeaturesBulk, updateProductFeatureByAdmin, withFeatureUsage } from "../../modules/catalog/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, pagedCollectionResponse, parseListQuery, includesQuery, readJsonBody } from "../../shared/http.ts";
export function registerProductFeaturesRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/products/:productId/features", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "products.read", requestId);
    const { q, limit, page } = parseListQuery(url.searchParams);
    const items = store.state.product_features
      .filter((f) => f.product_id === c.req.param("productId"))
      .filter((f) => includesQuery(f.name, q) || includesQuery(f.feature_key, q))
      .map((f) => withFeatureUsage(store.state, f));
    return pagedCollectionResponse(c, items, limit, page);
  });
  app.post("/api/v1/admin/products/:productId/features", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "features.manage", requestId);
    const body = await readJsonBody(c);
    const created = await createProductFeature(
      store,
      principal,
      c.req.param("productId")!,
      body,
      requestId
    );
    return jsonResponse(c, withFeatureUsage(store.state, created), 201);
  });
  app.post("/api/v1/admin/products/:productId/features/bulk", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "features.manage", requestId);
    const body = await readJsonBody(c);
    const result = await createProductFeaturesBulk(
      store,
      principal,
      c.req.param("productId")!,
      body,
      requestId,
    );
    return jsonResponse(c, result, 201);
  });
  app.get("/api/v1/admin/products/:productId/features/:featureId", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "products.read", requestId);
    const feature = store.state.product_features.find(
      (f) =>
        f.id === c.req.param("featureId") &&
        f.product_id === c.req.param("productId")
    );
    if (!feature) throw new AppError("NOT_FOUND", "Product feature not found.", 404);
    return jsonResponse(c, withFeatureUsage(store.state, feature));
  });
  app.patch("/api/v1/admin/products/:productId/features/:featureId", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "features.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updateProductFeatureByAdmin(
      store,
      principal,
      c.req.param("productId")!,
      c.req.param("featureId")!,
      body,
      requestId
    );
    return jsonResponse(c, updated);
  });
  app.post("/api/v1/admin/products/:productId/features/:featureId/archive", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "features.manage", requestId);
    const archived = await archiveProductFeatureByAdmin(
      store,
      principal,
      c.req.param("productId")!,
      c.req.param("featureId")!,
      requestId
    );
    return jsonResponse(c, archived);
  });
}
