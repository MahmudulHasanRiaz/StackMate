/**
 * Admin integrated-site routes (Hono) — Hono migration Phase 1.
 *
 * Site list/create/detail/lifecycle/products. Credentials live in
 * sites-credentials.ts, domains in sites-domains.ts, tracking-config
 * in sites-tracking.ts. Converted verbatim from app.ts (baseline
 * feat e382d65) — only the HTTP plumbing moved; service layer
 * unchanged.
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
  assignProductToSiteByAdmin,
  registerIntegratedSiteByAdmin,
  removeProductFromSiteByAdmin,
  revokeIntegratedSiteByAdmin,
  suspendIntegratedSiteByAdmin,
  updateIntegratedSiteByAdmin,
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

const includesQuery = (
  haystack: string | null | undefined,
  q: string
): boolean => (!q ? true : (haystack ?? "").toLowerCase().includes(q));

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

export function registerAdminSitesRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/integrated-sites", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const { q, limit, page } = parseListQuery(c.req.query());
    const sites = store.state.integrated_sites
      .filter(
        (s) =>
          includesQuery(s.name, q) ||
          includesQuery(s.site_key, q) ||
          s.domains.some((d) => includesQuery(d.domain, q)),
      )
      .map((s) => ({
        ...s,
        credentials: store.state.site_credentials
          .filter((cr) => cr.integrated_site_id === s.id)
          .map(({ secret_ciphertext: _c, secret_hash: _h, ...safeCred }) => safeCred),
        tracking: store.state.tracking_configurations
          .filter((tc) => tc.integrated_site_id === s.id)
          .map(({ access_token_ciphertext: _a, ...safeTc }) => safeTc),
      }));
    return pagedCollection(c, sites, limit, page);
  });


  app.post("/api/v1/admin/integrated-sites", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const body = await readJsonBody(c);
    const created = await registerIntegratedSiteByAdmin(store, principal, body, {
      encryptionKey: env.ENCRYPTION_KEY_V1,
      keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
      requestId,
    });
    return ok(c, created, 201);
  });

  // Batch 1: site detail + lifecycle + products + credentials + domains.


  app.get("/api/v1/admin/integrated-sites/:siteId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const site = store.state.integrated_sites.find(
      (s) => s.id === c.req.param("siteId")
    );
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    return ok(c, {
      ...site,
      credentials: store.state.site_credentials
        .filter((cr) => cr.integrated_site_id === site.id)
        .map(({ secret_ciphertext: _c, secret_hash: _h, ...safeCred }) => safeCred),
      tracking: store.state.tracking_configurations
        .filter((tc) => tc.integrated_site_id === site.id)
        .map(({ access_token_ciphertext: _a, ...safeTc }) => safeTc),
    });
  });


  app.patch("/api/v1/admin/integrated-sites/:siteId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updateIntegratedSiteByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      body,
      requestId
    );
    return ok(c, updated);
  });


  app.post("/api/v1/admin/integrated-sites/:siteId/suspend", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const suspended = await suspendIntegratedSiteByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      requestId
    );
    return ok(c, suspended);
  });


  app.post("/api/v1/admin/integrated-sites/:siteId/revoke", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const revoked = await revokeIntegratedSiteByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      requestId
    );
    return ok(c, revoked);
  });


  app.post("/api/v1/admin/integrated-sites/:siteId/products", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const body = (await readJsonBody(c)) as { product_id: string };
    if (!body.product_id) {
      throw new AppError("VALIDATION_ERROR", "product_id is required.", 422);
    }
    const updated = await assignProductToSiteByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      body.product_id,
      requestId
    );
    return ok(c, updated);
  });


  app.delete("/api/v1/admin/integrated-sites/:siteId/products/:productId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "integrations.manage", requestId);
    const updated = await removeProductFromSiteByAdmin(
      store,
      principal,
      c.req.param("siteId"),
      c.req.param("productId"),
      requestId
    );
    return ok(c, updated);
  });

}
