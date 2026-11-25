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

import { formatDisplayDateDDMMYYYY } from "../../../../../packages/contracts/src/index.ts";
import { AppError } from "../../shared/errors.ts";
import { assertStaffPermissionAudited } from "../../modules/identity/service.ts";
import { createProduct, updateProductMetadata, updateProductStatus } from "../../modules/catalog/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, pagedCollectionResponse, parseListQuery, includesQuery, readJsonBody } from "../../shared/http.ts";
export function registerAdminProductsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/products", async (c) => {
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
    const items = store.state.products
      .filter(
        (p) => includesQuery(p.name, q) || includesQuery(p.code, q),
      )
      .map((p) => ({
        ...p,
        features_count: store.state.product_features.filter(
          (f) => f.product_id === p.id,
        ).length,
        packages_count: store.state.product_packages.filter(
          (pkg) => pkg.product_id === p.id,
        ).length,
        created_date_display: formatDisplayDateDDMMYYYY(
          p.created_at,
          env.DEFAULT_TIMEZONE,
        ),
      }));
    return pagedCollectionResponse(c, items, limit, page);
  });
  app.post("/api/v1/admin/products", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "products.create", requestId);
    const body = await readJsonBody(c);
    const created = await createProduct(store, principal, body, requestId);
    return jsonResponse(c, created, 201);
  });
  app.get("/api/v1/admin/products/:productId", async (c) => {
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
    const product = store.state.products.find(
      (p) => p.id === c.req.param("productId")
    );
    if (!product) throw new AppError("NOT_FOUND", "Product not found.", 404);
    return jsonResponse(c, {
      ...product,
      features: store.state.product_features.filter((f) => f.product_id === product.id),
      packages: store.state.product_packages.filter((pkg) => pkg.product_id === product.id),
    });
  });
  app.patch("/api/v1/admin/products/:productId", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "products.update", requestId);
    const body = await readJsonBody(c);
    const updated = await updateProductMetadata(
      store,
      principal,
      c.req.param("productId")!,
      body,
      requestId
    );
    return jsonResponse(c, updated);
  });
  app.post("/api/v1/admin/products/:productId/publish", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "products.update", requestId);
    const updated = await updateProductStatus(
      store,
      principal,
      c.req.param("productId")!,
      "active",
      requestId
    );
    return jsonResponse(c, updated);
  });
  app.post("/api/v1/admin/products/:productId/archive", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "products.update", requestId);
    const updated = await updateProductStatus(
      store,
      principal,
      c.req.param("productId")!,
      "archived",
      requestId
    );
    return jsonResponse(c, updated);
  });
}
