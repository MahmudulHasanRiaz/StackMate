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

import { authenticateSignedServerRequest } from "../../modules/integrations/service.ts";
import { ingestExternalTrackingEvent } from "../../modules/tracking/service.ts";
import { testWebhookForSite } from "../../modules/webhooks/service.ts";
import { ingestLead } from "../../modules/leads/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, getClientIp, readCappedText, parseJsonText } from "../../shared/http.ts";
export function registerIntegrationEventsRoutes(app: Hono<AppEnv>): void {
  app.post("/api/v1/integrations/sites/:siteKey/tracking/events", async (c) => {
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
      requiredScope: "tracking.events.write",
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
    const res = await ingestExternalTrackingEvent(
      store,
      siteKey,
      parseJsonText(rawBodyText)
    );
    return jsonResponse(c, res, 202);
  });
  app.post("/api/v1/integrations/sites/:siteKey/leads", async (c) => {
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
    const { site } = await authenticateSignedServerRequest(store, {
      siteKey,
      requiredScope: "leads.create",
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
    const result = await ingestLead(store, site, parseJsonText(rawBodyText), requestId);
    return jsonResponse(c, result, result.created ? 201 : 200);
  });
  app.post("/api/v1/integrations/sites/:siteKey/webhook-test", async (c) => {
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
      requiredScope: "webhooks.test",
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
    const res = await testWebhookForSite(store, siteKey, {
      encryptionKey: env.ENCRYPTION_KEY_V1,
      allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
    });
    return jsonResponse(c, res);
  });
}
