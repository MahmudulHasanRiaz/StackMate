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

import { ingestExternalTrackingEvent } from "../../modules/tracking/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, readJsonBody } from "../../shared/http.ts";
export function registerPublicTrackingRoutes(app: Hono<AppEnv>): void {
  app.post("/api/v1/public/sites/:siteKey/tracking/events", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const siteKeyHeader = request.headers.get("X-StackMate-Site-Key")?.trim();
    const PUBLIC_CATALOG_CACHE_HEADERS = {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=15",
    };
    const siteKey = c.req.param("siteKey")!;
    // NOTE (wiring): tracking ingest's own buckets — per-site
    // (600/min) + per-IP inside that site (60/min) — are applied ONCE
    // by the chain `rateLimit` middleware. The duplicate
    // `checkRateLimit` calls that used to live here counted every
    // ingest twice against the same buckets. Removed.
    const rawBody = await readJsonBody(c);
    // OD-15 (owner decision, 2026-11-28): tracking ingestion is
    // INTENTIONALLY NOT audit-logged. Tracking events are high-volume and
    // already stored in `tracking_events` (the authoritative record, 90-day
    // retention per OD-01); writing an `audit_logs` row per event would
    // double write volume with no compliance benefit. Audit logging is for
    // admin/auth/payment actions, not per-event tracking ingestion. This is
    // a deliberate decision, not an omission — do not "fix" it by adding
    // audit writes here.
    const result = await ingestExternalTrackingEvent(store, siteKey, rawBody);
    return jsonResponse(c, result, 202);
  });
}
