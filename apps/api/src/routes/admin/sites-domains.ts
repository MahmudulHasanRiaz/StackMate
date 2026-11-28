/**
 * Admin site-domain routes (Hono) — Hono migration Phase 1.
 *
 * Split out of sites.ts (500-line cap). Domain register/challenge/
 * verify/delete. Converted verbatim from app.ts (baseline
 * feat e382d65).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import { createSuccessEnvelope } from "../../../../../packages/contracts/src/index.ts";
import {
  deleteSiteDomainByAdmin,
  generateDomainVerificationChallengeByAdmin,
  registerSiteDomainByAdmin,
  verifySiteDomainByAdmin,
} from "../../modules/integrations/service.ts";

// --- HTTP plumbing copied from app.ts handleRequest (closures there) ---

function requirePrincipal(c: Context<AppEnv>): StaffPrincipal {
  const principal = c.var.principal;
  if (!principal) {
    throw new AppError(
      "UNAUTHORIZED",
      "Valid staff authentication session required.",
      401
    );
  }
  return principal;
}

function ok<T>(c: Context<AppEnv>, data: T, status = 200): Response {
  return c.json(createSuccessEnvelope(data, c.var.requestId), status as ContentfulStatusCode);
}

const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;

async function readJsonBody(c: Context<AppEnv>): Promise<any> {
  const body = c.req.raw.body;
  if (!body) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is required and must be valid JSON.",
      400
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        "Request payload exceeds limit.",
        413
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  if (text.trim() === "") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is required and must be valid JSON.",
      400
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is not valid JSON.",
      400
    );
  }
}

// Lenient variant for handlers that treat a missing/malformed body
// as "no body". A 413 is never swallowed: an oversize body must fail
// loudly.

async function readJsonBodyLenient(c: Context<AppEnv>): Promise<any> {
  try {
    return await readJsonBody(c);
  } catch (error) {
    if (error instanceof AppError && error.code === "PAYLOAD_TOO_LARGE") throw error;
    return {};
  }
}

// A-04: dispatcher-level idempotency (see app.ts runIdempotentCommand
// header for the reserve → execute → complete protocol). Copied
// verbatim, store passed explicitly instead of closed over.

export function registerAdminSiteDomainsRoutes(app: Hono<AppEnv>): void {
  app.post("/api/v1/admin/integrated-sites/:siteId/domains", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await registerSiteDomainByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      body,
      requestId
    );
    return ok(c, updated, 201);
  });


  app.post("/api/v1/admin/integrated-sites/:siteId/domains/:domainId/verification-challenge", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const updated = await generateDomainVerificationChallengeByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      c.req.param("domainId"),
      requestId
    );
    return ok(c, updated);
  });


  app.post("/api/v1/admin/integrated-sites/:siteId/domains/:domainId/verify", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as {
      method?: string;
      reviewer_note?: string;
    };
    const updated = await verifySiteDomainByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      c.req.param("domainId"),
      body,
      requestId
    );
    return ok(c, updated);
  });


  app.delete("/api/v1/admin/integrated-sites/:siteId/domains/:domainId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const updated = await deleteSiteDomainByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      c.req.param("domainId"),
      requestId
    );
    return ok(c, updated);
  });

}
