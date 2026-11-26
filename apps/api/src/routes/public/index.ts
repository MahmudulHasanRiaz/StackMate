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
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, pagedCollectionResponse, parseListQuery, getClientIp } from "../../shared/http.ts";
export function registerPublicRoutes(app: Hono<AppEnv>): void {
  // NOTE (wiring): the block-level public rate limit (app.ts §4,
  // 120/min per IP, tracking ingest excepted with its own per-site +
  // per-IP buckets) is applied ONCE by the chain `rateLimit`
  // middleware. The `app.use("/api/v1/public/*", ...)` duplicate that
  // used to live here counted every public request twice against the
  // same bucket. Removed.
  app.get("/api/v1/public/sites/:siteKey/products", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const siteKeyHeader = request.headers.get("X-StackMate-Site-Key")?.trim();
    const PUBLIC_CATALOG_CACHE_HEADERS = {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=15",
    };
    const siteKey = c.req.param("siteKey")!;
    if (siteKeyHeader && siteKeyHeader !== siteKey) {
      throw new AppError("FORBIDDEN", "X-StackMate-Site-Key mismatch.", 403);
    }
    // B-01: targeted reads only — site by key + public catalog, no
    // full-state load. Safe on a createTargeted store.
    const site = await store.findIntegratedSiteByKey(siteKey);
    if (!site || site.status !== "active") throw new AppError("UNAUTHORIZED", "Invalid or inactive site key.", 401);

    // B-11: the old `store.queryMetrics.cachedQueries += 1` here
    // was false — the data comes from targeted reads, never a cached
    // read path, so the counter over-reported cached reads. Removed;
    // OD-04 (wire real HYPERDRIVE_CACHED or delete it) is still open.
    const catalog = await store.loadPublicCatalog();
    const allowedProducts = catalog.products
      .filter((p) => p.status === "active" && site.product_ids.includes(p.id))
      .map((p) => ({
        slug: p.slug,
        code: p.code,
        name: p.name,
        description: p.description,
        product_type: p.product_type,
        website_url: p.website_url,
        documentation_url: p.documentation_url,
      }));
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, allowedProducts, limit, page, null, 200, PUBLIC_CATALOG_CACHE_HEADERS);
  });
  app.get("/api/v1/public/sites/:siteKey/products/:productSlug/packages", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const siteKeyHeader = request.headers.get("X-StackMate-Site-Key")?.trim();
    const PUBLIC_CATALOG_CACHE_HEADERS = {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=15",
    };
    const siteKey = c.req.param("siteKey")!;
    const productSlug = c.req.param("productSlug")!;
    // B-01: targeted reads only (see the products-list handler).
    const site = await store.findIntegratedSiteByKey(siteKey);
    if (!site || site.status !== "active") throw new AppError("UNAUTHORIZED", "Invalid or inactive site key.", 401);
    const catalog = await store.loadPublicCatalog();
    const product = catalog.products.find(
      (p) => p.slug === productSlug && p.status === "active"
    );
    if (!product || !site.product_ids.includes(product.id)) {
      throw new AppError("NOT_FOUND", "Published product not found for this site.", 404);
    }

    const packages = catalog.product_packages
      .filter((pkg) => pkg.product_id === product.id && pkg.status === "active")
      .map((pkg) => {
        const publishedVer = catalog.package_versions.find(
          (v) => v.id === pkg.current_version_id && v.status === "published"
        );
        if (!publishedVer) return null;
        const prices = catalog.package_prices
          .filter(
            (pr) => pr.package_version_id === publishedVer.id && pr.status === "active"
          )
          .map((pr) => ({
            id: pr.id,
            price_key: pr.price_key,
            price_kind: pr.price_kind,
            amount_minor: pr.amount_minor,
            currency_code: pr.currency_code,
            interval_unit: pr.interval_unit,
            interval_count: pr.interval_count,
            trial_days: pr.trial_days,
            setup_fee_minor: pr.setup_fee_minor,
          }));
        return {
          package_key: pkg.package_key,
          name: pkg.name,
          description: pkg.description,
          package_version_id: publishedVer.id,
          version_number: publishedVer.version_number,
          features: publishedVer.features.map((f) => ({
            feature_key: f.feature_key_snapshot,
            value_type: f.value_type_snapshot,
            entitlement_value: f.entitlement_value,
            unit: f.unit_snapshot,
          })),
          prices,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, packages, limit, page, null, 200, PUBLIC_CATALOG_CACHE_HEADERS);
  });
  app.get("/api/v1/public/sites/:siteKey/products/:productSlug", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const siteKeyHeader = request.headers.get("X-StackMate-Site-Key")?.trim();
    const PUBLIC_CATALOG_CACHE_HEADERS = {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=15",
    };
    const siteKey = c.req.param("siteKey")!;
    const productSlug = c.req.param("productSlug")!;
    if (siteKeyHeader && siteKeyHeader !== siteKey) {
      throw new AppError("FORBIDDEN", "X-StackMate-Site-Key mismatch.", 403);
    }
    // B-01: targeted reads only (see the products-list handler).
    const site = await store.findIntegratedSiteByKey(siteKey);
    if (!site || site.status !== "active") throw new AppError("UNAUTHORIZED", "Invalid or inactive site key.", 401);
    const catalog = await store.loadPublicCatalog();
    const product = catalog.products.find(
      (p) => p.slug === productSlug && p.status === "active"
    );
    if (!product || !site.product_ids.includes(product.id)) {
      throw new AppError("NOT_FOUND", "Published product not found for this site.", 404);
    }
    const packages = catalog.product_packages
      .filter((pkg) => pkg.product_id === product.id && pkg.status === "active")
      .map((pkg) => {
        const publishedVer = catalog.package_versions.find(
          (v) => v.id === pkg.current_version_id && v.status === "published"
        );
        if (!publishedVer) return null;
        return {
          package_key: pkg.package_key,
          name: pkg.name,
          description: pkg.description,
          package_version_id: publishedVer.id,
          version_number: publishedVer.version_number,
          features: publishedVer.features.map((f) => ({
            feature_key: f.feature_key_snapshot,
            value_type: f.value_type_snapshot,
            entitlement_value: f.entitlement_value,
            unit: f.unit_snapshot,
          })),
          prices: catalog.package_prices
            .filter(
              (pr) => pr.package_version_id === publishedVer.id && pr.status === "active"
            )
            .map((pr) => ({
              id: pr.id,
              price_key: pr.price_key,
              price_kind: pr.price_kind,
              amount_minor: pr.amount_minor,
              currency_code: pr.currency_code,
              interval_unit: pr.interval_unit,
              interval_count: pr.interval_count,
              trial_days: pr.trial_days,
              setup_fee_minor: pr.setup_fee_minor,
            })),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return jsonResponse(c, {
      slug: product.slug,
      code: product.code,
      name: product.name,
      description: product.description,
      product_type: product.product_type,
      website_url: product.website_url,
      documentation_url: product.documentation_url,
      features: catalog.product_features
        .filter((f) => f.product_id === product.id && f.status === "active")
        .map((f) => ({
          feature_key: f.feature_key,
          name: f.name,
          description: f.description,
          value_type: f.value_type,
          unit: f.unit,
          default_value: f.default_value,
        })),
      packages,
    }, 200, PUBLIC_CATALOG_CACHE_HEADERS);
  });
  app.get("/api/v1/public/sites/:siteKey/packages/:packageVersionId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const siteKeyHeader = request.headers.get("X-StackMate-Site-Key")?.trim();
    const PUBLIC_CATALOG_CACHE_HEADERS = {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=15",
    };
    const siteKey = c.req.param("siteKey")!;
    const packageVersionId = c.req.param("packageVersionId")!;
    if (siteKeyHeader && siteKeyHeader !== siteKey) {
      throw new AppError("FORBIDDEN", "X-StackMate-Site-Key mismatch.", 403);
    }
    // B-01: targeted reads only (see the products-list handler).
    const site = await store.findIntegratedSiteByKey(siteKey);
    if (!site || site.status !== "active") throw new AppError("UNAUTHORIZED", "Invalid or inactive site key.", 401);
    const catalog = await store.loadPublicCatalog();
    const version = catalog.package_versions.find(
      (v) => v.id === packageVersionId && v.status === "published"
    );
    if (!version) throw new AppError("NOT_FOUND", "Published package version not found.", 404);
    const pkg = catalog.product_packages.find(
      (p) => p.id === version.package_id && p.status === "active"
    );
    if (!pkg) throw new AppError("NOT_FOUND", "Published package version not found.", 404);
    const product = catalog.products.find(
      (p) => p.id === pkg.product_id && p.status === "active"
    );
    if (!product || !site.product_ids.includes(product.id)) {
      throw new AppError("NOT_FOUND", "Published package version not found for this site.", 404);
    }
    return jsonResponse(c, {
      package_key: pkg.package_key,
      name: pkg.name,
      description: pkg.description,
      package_version_id: version.id,
      version_number: version.version_number,
      product_slug: product.slug,
      product_code: product.code,
      features: version.features.map((f) => ({
        feature_key: f.feature_key_snapshot,
        value_type: f.value_type_snapshot,
        entitlement_value: f.entitlement_value,
        unit: f.unit_snapshot,
      })),
      prices: catalog.package_prices
        .filter((pr) => pr.package_version_id === version.id && pr.status === "active")
        .map((pr) => ({
          id: pr.id,
          price_key: pr.price_key,
          price_kind: pr.price_kind,
          amount_minor: pr.amount_minor,
          currency_code: pr.currency_code,
          interval_unit: pr.interval_unit,
          interval_count: pr.interval_count,
          trial_days: pr.trial_days,
          setup_fee_minor: pr.setup_fee_minor,
        })),
    }, 200, PUBLIC_CATALOG_CACHE_HEADERS);
  });
}
