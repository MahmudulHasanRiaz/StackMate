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

import { and } from "drizzle-orm";
import { AppError } from "../../shared/errors.ts";
import { activateLicenseInstallation, deactivateLicenseInstallation, validateLicenseInstallationTargeted } from "../../modules/licensing/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, readJsonBody, getClientIp } from "../../shared/http.ts";
import { runIdempotentCommand } from "../../shared/idempotency.ts";
export function registerLicensesRoutes(app: Hono<AppEnv>): void {
  // §6.5 rule — license credentials must never arrive in the query.
  // (The block-level license rate limit, 120/min per IP, is applied
  // ONCE by the chain `rateLimit` middleware; the duplicate
  // `checkRateLimit` call that used to live here counted every
  // license request twice against the same bucket. Removed — wiring.)
  app.use("/api/v1/licenses/*", async (c, next) => {
    const params = new URL(c.req.url).searchParams;
    if (params.has("license_key") || params.has("key")) {
      throw new AppError(
        "VALIDATION_ERROR",
        "License credentials must never be passed in URL query parameters.",
        400,
      );
    }
    await next();
  });

  app.get("/api/v1/licenses/signing-keys", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const keys = Array.from(store.signingKeys.values()).map((k) => k.publicKeyJwk);
    return jsonResponse(c, { keys });
  });
  app.post("/api/v1/licenses/activate", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const body = await readJsonBody(c);
    // A-04: activation is idempotent per Idempotency-Key. The
    // service itself is naturally idempotent per installation
    // (same installation_id → same activation row, no second
    // seat consumed), so a replay RE-RUNS it for a fresh
    // entitlement token instead of returning a stored one — the
    // token is a bearer credential and is never stored in the
    // idempotency row (A-03 class). The row still guards
    // key-reuse-with-a-different-payload (409).
    const activated = await runIdempotentCommand(c, {
      scope: "license_activate",
      key: request.headers.get("Idempotency-Key"),
      payload: body,
      statusCode: 200,
      fn: () =>
        activateLicenseInstallation(store, body, {
          verifierSecret: env.LICENSE_VERIFIER_SECRET,
          issuerUrl: env.API_URL,
          requestId,
        }),
      redactForStore: (result) => ({ ...result, entitlement_token: null }),
      reissueOnReplay: () =>
        activateLicenseInstallation(store, body, {
          verifierSecret: env.LICENSE_VERIFIER_SECRET,
          issuerUrl: env.API_URL,
          requestId,
        }),
    });
    return jsonResponse(c, activated.body, 200);
  });
  app.post("/api/v1/licenses/validate", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const body = await readJsonBody(c);
    // B-01: targeted validate — lookup + checks run on
    // findLicenseForValidation (no full-state load), safe on a
    // createTargeted store. Activate/deactivate stay on the legacy
    // transactional path: seat changes + audit rows need a
    // transaction, and no targeted mutation exists for them.
    const result = await validateLicenseInstallationTargeted(store, body, {
      verifierSecret: env.LICENSE_VERIFIER_SECRET,
      issuerUrl: env.API_URL,
    });
    return jsonResponse(c, result, 200);
  });
  app.post("/api/v1/licenses/deactivate", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = getClientIp(request);
    const body = await readJsonBody(c);
    const result = await deactivateLicenseInstallation(store, body, {
      verifierSecret: env.LICENSE_VERIFIER_SECRET,
      requestId,
    });
    return jsonResponse(c, result, 200);
  });
}
