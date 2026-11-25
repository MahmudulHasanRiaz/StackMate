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
import { cancelOrderInTx, createPublicCheckoutOrder } from "../../modules/commerce/service.ts";
import { authenticateSignedServerRequest } from "../../modules/integrations/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, getClientIp, readCappedText, parseJsonText } from "../../shared/http.ts";
export function registerIntegrationOrdersRoutes(app: Hono<AppEnv>): void {
  app.post("/api/v1/integrations/sites/:siteKey/orders", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const siteKey = c.req.param("siteKey")!;
    const rawBodyText = await readCappedText(request);
    await authenticateSignedServerRequest(store, {
      siteKey,
      requiredScope: "checkout.create",
      keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
      timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
      nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
      contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
      signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
      method,
      host: url.host,
      rawPathAndQuery: `${url.pathname}${url.search}`,
      rawBody: rawBodyText,
      encryptionKey: env.ENCRYPTION_KEY_V1,
    });
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
      throw new AppError("VALIDATION_ERROR", "Idempotency-Key header is required.", 400);
    }
    const parsedJson = parseJsonText(rawBodyText);
    const result = await createPublicCheckoutOrder(store, {
      siteKey,
      idempotencyKey,
      checkoutTokenSecret: env.CHECKOUT_TOKEN_SECRET,
      rawBody: parsedJson,
      requestId,
    });
    const { replayed: _, ...payload } = result;
    return jsonResponse(c, payload, result.replayed ? 200 : 201);
  });
  app.get("/api/v1/integrations/sites/:siteKey/orders/:publicReference", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const siteKey = c.req.param("siteKey")!;
    const publicReference = c.req.param("publicReference")!;
    const { site } = await authenticateSignedServerRequest(store, {
      siteKey,
      requiredScope: "orders.read:own",
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
    // BOLA protection: site can ONLY read orders belonging to its own integrated_site_id
    const order = store.state.orders.find(
      (o) => o.public_reference === publicReference && o.integrated_site_id === site.id
    );
    if (!order) {
      throw new AppError("NOT_FOUND", "Order not found for this integrated site.", 404);
    }
    return jsonResponse(c, {
      public_reference: order.public_reference,
      order_number: order.order_number,
      status: order.status,
      payment_status: order.payment_status,
      currency_code: order.currency_code,
      total_minor: order.total_minor,
      created_at: order.created_at,
    });
  });
  app.post("/api/v1/integrations/sites/:siteKey/orders/:publicReference/cancel", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const siteKey = c.req.param("siteKey")!;
    const publicReference = c.req.param("publicReference")!;
    const rawBodyText = await readCappedText(request);
    const { site } = await authenticateSignedServerRequest(store, {
      siteKey,
      requiredScope: "orders.cancel:own",
      keyIdHeader: request.headers.get("X-StackMate-Key-Id") ?? undefined,
      timestampHeader: request.headers.get("X-StackMate-Timestamp") ?? undefined,
      nonceHeader: request.headers.get("X-StackMate-Nonce") ?? undefined,
      contentSha256Header: request.headers.get("X-StackMate-Content-SHA256") ?? undefined,
      signatureHeader: request.headers.get("X-StackMate-Signature") ?? undefined,
      method,
      host: url.host,
      rawPathAndQuery: `${url.pathname}${url.search}`,
      rawBody: rawBodyText,
      encryptionKey: env.ENCRYPTION_KEY_V1,
    });
    const body = (parseJsonText(rawBodyText || "{}")) as { reason?: string };
    const cancelled = await store.withTransaction((state) => {
      const order = state.orders.find(
        (o) => o.public_reference === publicReference && o.integrated_site_id === site.id
      );
      if (!order) {
        throw new AppError("NOT_FOUND", "Order not found for this integrated site.", 404);
      }
      return cancelOrderInTx(state, order, {
        actorType: "integration",
        integratedSiteId: site.id,
        reason: body.reason ?? "Cancelled by integrated site.",
        requestId,
      });
    });
    return jsonResponse(c, {
      public_reference: cancelled.public_reference,
      order_number: cancelled.order_number,
      status: cancelled.status,
      cancelled_at: cancelled.cancelled_at,
    });
  });
}
