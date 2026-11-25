/**
 * Admin site tracking-config routes (Hono) — Hono migration Phase 1.
 *
 * Split out of sites.ts (500-line cap). Per-site pixel groups
 * (migration 0006): PUT configure + GET/POST list/create + PATCH/
 * DELETE per group. Converted verbatim from app.ts (baseline
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
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
} from "../../../../../packages/contracts/src/index.ts";
import {
  configureSiteTrackingByAdmin,
  createTrackingConfigByAdmin,
  deleteTrackingConfigByAdmin,
  updateTrackingConfigByAdmin,
} from "../../modules/tracking/service.ts";

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

function parseListQuery(query: Record<string, string | undefined>): {
  q: string;
  limit: number;
  page: number;
} {
  const q = query.q?.trim().toLowerCase() ?? "";
  const rawLimit = Number(query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), 100)
      : 25;
  const rawPage = Number(query.page);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  return { q, limit, page };
}

function applyListPage<T>(items: T[], limit: number, page: number): T[] {
  return items.slice((page - 1) * limit, page * limit);
}

function pagedCollection<T>(
  c: Context<AppEnv>,
  filtered: T[],
  limit: number,
  page = 1,
  nextCursor: string | null = null,
  status = 200
): Response {
  return c.json(
    createCollectionEnvelope(
      applyListPage(filtered, limit, page),
      nextCursor,
      c.var.requestId,
      filtered.length
    ),
    status as ContentfulStatusCode
  );
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

export function registerAdminSiteTrackingRoutes(app: Hono<AppEnv>): void {
  app.put("/api/v1/admin/integrated-sites/:siteId/tracking", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
    const body = await readJsonBody(c);
    const cfg = await configureSiteTrackingByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      body,
      {
        encryptionKey: env.ENCRYPTION_KEY_V1,
        keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
        requestId,
      }
    );
    return ok(c, cfg);
  });

  // Pixel groups (migration 0006): per-group CRUD under Settings.
  // GET lists a site's groups (ciphertext stripped); POST creates
  // one (201, 409 on a duplicate (provider, pixel_id)); the
  // toggle is PATCH status — no redundant endpoint.


  app.get("/api/v1/admin/integrated-sites/:siteId/tracking", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
    const site = store.state.integrated_sites.find(
      (s) => s.id === c.req.param("siteId")
    );
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    const { limit, page } = parseListQuery(c.req.query());
    return pagedCollection(
      c,
      store.state.tracking_configurations
        .filter((tc) => tc.integrated_site_id === site.id)
        .map(({ access_token_ciphertext: _, ...safeTc }) => safeTc),
      limit,
      page
    );
  });


  app.post("/api/v1/admin/integrated-sites/:siteId/tracking", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
    const body = await readJsonBody(c);
    const created = await createTrackingConfigByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      body,
      {
        encryptionKey: env.ENCRYPTION_KEY_V1,
        keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
        requestId,
      }
    );
    return ok(c, created, 201);
  });


  app.patch("/api/v1/admin/integrated-sites/:siteId/tracking/:configId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updateTrackingConfigByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      c.req.param("configId"),
      body,
      {
        encryptionKey: env.ENCRYPTION_KEY_V1,
        keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
        requestId,
      }
    );
    return ok(c, updated);
  });


  app.delete("/api/v1/admin/integrated-sites/:siteId/tracking/:configId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "tracking.manage", requestId);
    const deleted = await deleteTrackingConfigByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      c.req.param("configId"),
      requestId
    );
    return ok(c, deleted);
  });

}
