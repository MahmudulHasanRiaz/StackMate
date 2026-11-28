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

import { loadAuthConfig } from "../modules/auth-config/service.ts";
import { DEFAULT_GENERAL_SETTINGS, loadGeneralSettings, publicViewOf } from "../modules/general-settings/service.ts";
import { isSuperAdminProvisioned } from "../modules/identity/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../types/context.ts";
import { jsonResponse, getClientIp } from "../shared/http.ts";

const DEFAULT_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="12" fill="#141414"/>' +
  '<text x="32" y="44" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="700" fill="#00E599" text-anchor="middle">S</text>' +
  "</svg>";

export function registerMetaRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/health", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    return jsonResponse(c, {
      status: "ok",
      service: "stackmate-api",
      environment: env.APP_ENV,
      default_currency: env.DEFAULT_CURRENCY,
      default_timezone: env.DEFAULT_TIMEZONE,
      hyperdrive: {
        uncached_binding_configured: Boolean(env.HYPERDRIVE_NO_CACHE?.connectionString),
        cached_binding_configured: Boolean(env.HYPERDRIVE_CACHED?.connectionString),
        query_metrics: store.queryMetrics,
      },
      timestamp: new Date().toISOString(),
    });
  });
  app.get("/api/v1/ready", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    return jsonResponse(c, {
      status: "ok",
      service: "stackmate-api",
      environment: env.APP_ENV,
      default_currency: env.DEFAULT_CURRENCY,
      default_timezone: env.DEFAULT_TIMEZONE,
      hyperdrive: {
        uncached_binding_configured: Boolean(env.HYPERDRIVE_NO_CACHE?.connectionString),
        cached_binding_configured: Boolean(env.HYPERDRIVE_CACHED?.connectionString),
        query_metrics: store.queryMetrics,
      },
      timestamp: new Date().toISOString(),
    });
  });
  app.get("/api/v1/setup-status", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const provisioned = await isSuperAdminProvisioned(store);
    return jsonResponse(c, { setup_required: !provisioned });
  });
  app.get("/api/v1/auth-config", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
    if (!maybeDrizzle.drizzleDb) {
      return jsonResponse(c, { oauth_providers: [], email_configured: false });
    }
    const config = await loadAuthConfig(
      maybeDrizzle.drizzleDb as Parameters<typeof loadAuthConfig>[0],
      { encryptionKey: env.ENCRYPTION_KEY_V1, keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION },
      env.HYPERDRIVE_NO_CACHE.connectionString
    ).catch(() => undefined);
    return jsonResponse(c, {
      oauth_providers: (config?.oauth ?? [])
        .filter((p) => p.enabled && p.clientId && p.clientSecret)
        .map((p) => p.provider),
      email_configured: config?.smtp.enabled ?? false,
    });
  });
  app.get("/api/v1/general-config", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
    if (!maybeDrizzle.drizzleDb) {
      return jsonResponse(c, { ...DEFAULT_GENERAL_SETTINGS });
    }
    const row = await loadGeneralSettings(
      maybeDrizzle.drizzleDb as Parameters<typeof loadGeneralSettings>[0]
    ).catch(() => null);
    return jsonResponse(c, publicViewOf(row));
  });
  app.get("/api/v1/favicon", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    // A-16: SVGs are served with the same sandbox CSP + nosniff
    // as media SVGs (a stored SVG must never execute, even opened
    // top-level directly). nosniff applies to every favicon type.
    const defaultFavicon = () =>
      new Response(DEFAULT_FAVICON_SVG, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
        },
      });
    const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
    if (!maybeDrizzle.drizzleDb) return defaultFavicon();
    const row = await loadGeneralSettings(
      maybeDrizzle.drizzleDb as Parameters<typeof loadGeneralSettings>[0]
    ).catch(() => null);
    if (!row?.faviconObjectKey) {
      return defaultFavicon();
    }
    const bucket = (store as unknown as { r2Bucket?: unknown }).r2Bucket as
      | { get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null> }
      | undefined;
    const obj = await bucket?.get(row.faviconObjectKey);
    if (!obj) return defaultFavicon();
    const bytes = await obj.arrayBuffer();
    const faviconContentType = row.faviconContentType ?? "image/png";
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": faviconContentType,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        ...(faviconContentType === "image/svg+xml"
          ? { "Content-Security-Policy": "sandbox" }
          : {}),
      },
    });
  });
}
