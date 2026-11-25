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
import { createNewPackageVersion, createPackagePrice, createProductPackageWithDraftVersion, disablePackagePriceByAdmin, publishPackageVersion, retirePackageVersionByAdmin, updatePackagePriceByAdmin, updateProductPackageByAdmin } from "../../modules/catalog/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, pagedCollectionResponse, parseListQuery, includesQuery, readJsonBody } from "../../shared/http.ts";
export function registerProductPackagesRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/products/:productId/packages", async (c) => {
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
    const pkgs = store.state.product_packages
      .filter((p) => p.product_id === c.req.param("productId"))
      .filter((p) => includesQuery(p.name, q))
      .map((p) => ({
        ...p,
        versions: store.state.package_versions
          .filter((v) => v.package_id === p.id)
          .map((v) => ({
            ...v,
            prices: store.state.package_prices.filter(
              (pr) => pr.package_version_id === v.id,
            ),
          })),
      }));
    return pagedCollectionResponse(c, pkgs, limit, page);
  });
  app.post("/api/v1/admin/products/:productId/packages", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
    const body = await readJsonBody(c);
    const created = await createProductPackageWithDraftVersion(
      store,
      principal,
      c.req.param("productId")!,
      body,
      requestId
    );
    return jsonResponse(c, created, 201);
  });
  app.post("/api/v1/admin/packages/:packageId/versions", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
    const body = (await readJsonBody(c)) as {
      features: Array<{ product_feature_id: string; entitlement_value: unknown }>;
      change_summary?: string;
    };
    const created = await createNewPackageVersion(
      store,
      principal,
      c.req.param("packageId")!,
      body,
      requestId
    );
    return jsonResponse(c, created, 201);
  });
  app.get("/api/v1/admin/package-versions/:versionId", async (c) => {
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
    const ver = store.state.package_versions.find(
      (v) => v.id === c.req.param("versionId")
    );
    if (!ver) throw new AppError("NOT_FOUND", "Package version not found.", 404);
    return jsonResponse(c, {
      ...ver,
      prices: store.state.package_prices.filter((pr) => pr.package_version_id === ver.id),
    });
  });
  app.post("/api/v1/admin/package-versions/:versionId/publish", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "packages.publish", requestId);
    const published = await publishPackageVersion(
      store,
      principal,
      c.req.param("versionId")!,
      requestId
    );
    return jsonResponse(c, published);
  });
  app.get("/api/v1/admin/package-versions/:versionId/prices", async (c) => {
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
    const prices = store.state.package_prices.filter(
      (pr) => pr.package_version_id === c.req.param("versionId")
    );
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, prices, limit, page);
  });
  app.post("/api/v1/admin/package-versions/:versionId/prices", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
    const body = await readJsonBody(c);
    const created = await createPackagePrice(
      store,
      principal,
      c.req.param("versionId")!,
      body,
      requestId
    );
    return jsonResponse(c, created, 201);
  });
  app.get("/api/v1/admin/packages/:packageId", async (c) => {
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
    const pkg = store.state.product_packages.find(
      (p) => p.id === c.req.param("packageId")
    );
    if (!pkg) throw new AppError("NOT_FOUND", "Package not found.", 404);
    return jsonResponse(c, {
      ...pkg,
      versions: store.state.package_versions
        .filter((v) => v.package_id === pkg.id)
        .map((v) => ({
          ...v,
          prices: store.state.package_prices.filter(
            (pr) => pr.package_version_id === v.id
          ),
        })),
    });
  });
  app.patch("/api/v1/admin/packages/:packageId", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updateProductPackageByAdmin(
      store,
      principal,
      c.req.param("packageId")!,
      body,
      requestId
    );
    return jsonResponse(c, updated);
  });
  app.post("/api/v1/admin/package-versions/:versionId/retire", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "packages.publish", requestId);
    const retired = await retirePackageVersionByAdmin(
      store,
      principal,
      c.req.param("versionId")!,
      requestId
    );
    return jsonResponse(c, retired);
  });
  app.get("/api/v1/admin/prices/:priceId", async (c) => {
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
    const price = store.state.package_prices.find(
      (pr) => pr.id === c.req.param("priceId")
    );
    if (!price) throw new AppError("NOT_FOUND", "Package price not found.", 404);
    return jsonResponse(c, price);
  });
  app.patch("/api/v1/admin/prices/:priceId", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updatePackagePriceByAdmin(
      store,
      principal,
      c.req.param("priceId")!,
      body,
      requestId
    );
    return jsonResponse(c, updated);
  });
  app.post("/api/v1/admin/prices/:priceId/disable", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
    const disabled = await disablePackagePriceByAdmin(
      store,
      principal,
      c.req.param("priceId")!,
      requestId
    );
    return jsonResponse(c, disabled);
  });
}
