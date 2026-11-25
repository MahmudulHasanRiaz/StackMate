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
import { authenticateSignedServerRequest } from "../../modules/integrations/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { pagedCollectionResponse, parseListQuery, getClientIp } from "../../shared/http.ts";
export function registerIntegrationsRoutes(app: Hono<AppEnv>): void {
  // NOTE (wiring): the block-level integrations rate limit (app.ts
  // §5, 120/min per IP) is applied ONCE by the chain `rateLimit`
  // middleware. The `app.use("/api/v1/integrations/*", ...)` duplicate
  // that used to live here counted every integrations request twice
  // against the same bucket. Removed.
  app.get("/api/v1/integrations/sites/:siteKey/products", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const siteKey = c.req.param("siteKey")!;
    const { site } = await authenticateSignedServerRequest(store, {
      siteKey,
      requiredScope: "catalog.read",
      keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
      timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
      nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
      contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
      signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
      method,
      host: url.host,
      rawPathAndQuery: `${url.pathname}${url.search}`,
      rawBody: "",
      encryptionKey: env.ENCRYPTION_KEY_V1,
    });
    const items = store.state.products.filter(
      (p) => p.status === "active" && site.product_ids.includes(p.id)
    );
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, items, limit, page);
  });
  app.get("/api/v1/integrations/sites/:siteKey/products/:productSlug/packages", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const siteKey = c.req.param("siteKey")!;
    const productSlug = c.req.param("productSlug")!;
    const { site } = await authenticateSignedServerRequest(store, {
      siteKey,
      requiredScope: "catalog.read",
      keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
      timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
      nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
      contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
      signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
      method,
      host: url.host,
      rawPathAndQuery: `${url.pathname}${url.search}`,
      rawBody: "",
      encryptionKey: env.ENCRYPTION_KEY_V1,
    });
    const product = store.state.products.find(
      (p) => p.slug === productSlug && p.status === "active"
    );
    if (!product || !site.product_ids.includes(product.id)) {
      throw new AppError("NOT_FOUND", "Published product not found for this site.", 404);
    }
    const packages = store.state.product_packages
      .filter((pkg) => pkg.product_id === product.id && pkg.status === "active")
      .map((pkg) => {
        const publishedVer = store.state.package_versions.find(
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
          prices: store.state.package_prices
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
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, packages, limit, page);
  });
}
