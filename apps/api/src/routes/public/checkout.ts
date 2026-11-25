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
import { verifyCheckoutAccessToken } from "../../platform/crypto/index.ts";
import { and } from "drizzle-orm";
import { resolveStorageDriver } from "../../platform/storage/driver.ts";
import { AppError } from "../../shared/errors.ts";
import { createPublicCheckoutOrder } from "../../modules/commerce/service.ts";
import { submitManualPaymentClaim, toPublicPaymentMethodDto, uploadPrivatePaymentEvidence } from "../../modules/payments/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, pagedCollectionResponse, parseListQuery, readJsonBody, getClientIp, extractBearerToken, driverDepsForRequest } from "../../shared/http.ts";
export function registerPublicCheckoutRoutes(app: Hono<AppEnv>): void {
  app.post("/api/v1/public/sites/:siteKey/checkout/orders", async (c) => {
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
    if (!siteKeyHeader || siteKeyHeader !== siteKey) {
      throw new AppError(
        "UNAUTHORIZED",
        "Matching X-StackMate-Site-Key header is required.",
        401
      );
    }
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Idempotency-Key header is required for checkout order creation.",
        400
      );
    }
    const rawBody = await readJsonBody(c);
    const result = await createPublicCheckoutOrder(store, {
      siteKey,
      idempotencyKey,
      checkoutTokenSecret: env.CHECKOUT_TOKEN_SECRET,
      rawBody,
      requestId,
    });
    const { replayed: _, ...payload } = result;
    return jsonResponse(c, payload, result.replayed ? 200 : 201);
  });
  app.get("/api/v1/public/sites/:siteKey/checkout/orders/:publicReference", async (c) => {
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
    const publicReference = c.req.param("publicReference")!;
    const site = store.state.integrated_sites.find(
      (s) => s.site_key === siteKey && s.status === "active"
    );
    if (!site) throw new AppError("UNAUTHORIZED", "Invalid site key.", 401);
    const bearer = extractBearerToken(request.headers.get("Authorization"));
    if (!bearer) {
      throw new AppError("UNAUTHORIZED", "Checkout access token is required.", 401);
    }
    const tokenClaims = verifyCheckoutAccessToken(bearer, env.CHECKOUT_TOKEN_SECRET);
    if (tokenClaims.ref !== publicReference || tokenClaims.sid !== site.id) {
      throw new AppError(
        "FORBIDDEN",
        "Checkout access token is not valid for this order or site.",
        403
      );
    }
    const order = store.state.orders.find(
      (o) => o.id === tokenClaims.oid && o.public_reference === publicReference
    );
    if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);

    return jsonResponse(c, {
      public_reference: order.public_reference,
      order_number: order.order_number,
      status: order.status,
      payment_status: order.payment_status,
      currency_code: order.currency_code,
      subtotal_minor: order.subtotal_minor,
      discount_minor: order.discount_minor,
      tax_minor: order.tax_minor,
      total_minor: order.total_minor,
      created_at: order.created_at,
      created_date_display: formatDisplayDateDDMMYYYY(order.created_at, env.DEFAULT_TIMEZONE),
      items: order.items.map((it) => ({
        product_name: it.product_name_snapshot,
        package_name: it.package_name_snapshot,
        quantity: it.quantity,
        line_total_minor: it.line_total_minor,
      })),
    });
  });
  app.get("/api/v1/public/sites/:siteKey/checkout/orders/:publicReference/payment-methods", async (c) => {
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
    const publicReference = c.req.param("publicReference")!;
    const site = store.state.integrated_sites.find(
      (s) => s.site_key === siteKey && s.status === "active"
    );
    if (!site) throw new AppError("UNAUTHORIZED", "Invalid site key.", 401);
    const bearer = extractBearerToken(request.headers.get("Authorization"));
    if (!bearer) throw new AppError("UNAUTHORIZED", "Checkout access token required.", 401);
    const tokenClaims = verifyCheckoutAccessToken(bearer, env.CHECKOUT_TOKEN_SECRET);
    if (tokenClaims.ref !== publicReference || tokenClaims.sid !== site.id) {
      throw new AppError("FORBIDDEN", "Checkout token scope mismatch.", 403);
    }

    const activeMethods = store.state.payment_methods
      .filter((m) => m.is_enabled)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((m) => toPublicPaymentMethodDto(store, m));
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, activeMethods, limit, page);
  });
  app.post("/api/v1/public/sites/:siteKey/checkout/orders/:publicReference/payment-evidence", async (c) => {
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
    const publicReference = c.req.param("publicReference")!;
    const site = store.state.integrated_sites.find(
      (s) => s.site_key === siteKey && s.status === "active"
    );
    if (!site) throw new AppError("UNAUTHORIZED", "Invalid site key.", 401);
    const bearer = extractBearerToken(request.headers.get("Authorization"));
    if (!bearer) throw new AppError("UNAUTHORIZED", "Checkout access token required.", 401);
    const tokenClaims = verifyCheckoutAccessToken(bearer, env.CHECKOUT_TOKEN_SECRET);
    if (tokenClaims.ref !== publicReference || tokenClaims.sid !== site.id) {
      throw new AppError("FORBIDDEN", "Checkout token scope mismatch.", 403);
    }
    const order = store.state.orders.find((o) => o.id === tokenClaims.oid);
    if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);

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
    const bytes = new Uint8Array(Buffer.from(body.content_base64, "base64"));
    // Storage driver (PLAN §31): evidence lands on the selected
    // driver (R2 or Local); resolveStorageDriver fails closed in
    // staging/production when no real R2 bucket is configured.
    const evidenceDriver = await resolveStorageDriver(driverDepsForRequest(store, env));
    const asset = await uploadPrivatePaymentEvidence(store, {
      orderId: order.id,
      customerId: order.customer_id,
      filename: body.filename,
      contentType: body.content_type,
      bytes,
      bucketName: evidenceDriver.name === "r2" ? env.R2_BUCKET_NAME : "local",
      driver: evidenceDriver,
      // Public checkout route: actor null — its authorization is
      // the site key + checkout token + order reference, verified
      // by this route before the call.
      actor: null,
      requestId,
    });
    return jsonResponse(c, 
      {
        evidence_asset_id: asset.id,
        original_filename: asset.original_filename,
        content_type: asset.content_type,
        byte_size: asset.byte_size,
        checksum_sha256: asset.checksum_sha256,
        visibility: asset.visibility,
      },
      201
    );
  });
  app.post("/api/v1/public/sites/:siteKey/checkout/orders/:publicReference/payment-submissions", async (c) => {
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
    const publicReference = c.req.param("publicReference")!;
    const site = store.state.integrated_sites.find(
      (s) => s.site_key === siteKey && s.status === "active"
    );
    if (!site) throw new AppError("UNAUTHORIZED", "Invalid site key.", 401);
    const bearer = extractBearerToken(request.headers.get("Authorization"));
    if (!bearer) throw new AppError("UNAUTHORIZED", "Checkout access token required.", 401);
    const tokenClaims = verifyCheckoutAccessToken(bearer, env.CHECKOUT_TOKEN_SECRET);
    if (tokenClaims.ref !== publicReference || tokenClaims.sid !== site.id) {
      throw new AppError("FORBIDDEN", "Checkout token scope mismatch.", 403);
    }
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Idempotency-Key header is required for payment submission.",
        400
      );
    }
    const rawBody = await readJsonBody(c);
    const submitted = await submitManualPaymentClaim(store, {
      orderPublicReference: publicReference,
      idempotencyKey,
      rawBody,
      requestId,
    });
    const { replayed: _, ...payload } = submitted;
    return jsonResponse(c, payload, submitted.replayed ? 200 : 201);
  });
}
