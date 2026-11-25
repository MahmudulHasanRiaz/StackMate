/**
 * Admin license routes (Hono) — Hono migration Phase 1.
 *
 * Converted verbatim from the hand-rolled dispatcher in
 * apps/api/src/app.ts (baseline feat e382d65, lines ~6160–6460):
 * admin license list/detail, manual grants, signing-key lifecycle
 * (list/rotate/revoke), activations (list/deactivate/transfer),
 * suspend/resume/revoke actions, entitlement snapshots. Service
 * layer, validators and envelopes are unchanged — only the HTTP
 * plumbing moved. Auth / CSRF / rate-limit middleware (Worker 3,
 * hono/*) provides c.var.requestId / env / store / principal; the
 * per-route permission checks below are preserved from app.ts.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
  formatDisplayDateDDMMYYYY,
} from "../../../../../packages/contracts/src/index.ts";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import { appendAuditLog } from "../../modules/audit/service.ts";
import {
  appendLicenseEntitlementSnapshotByAdmin,
  createManualLicenseGrantByAdmin,
  deactivateLicenseActivationByAdmin,
  transferActivation,
  transitionLicenseStatusByAdmin,
} from "../../modules/licensing/service.ts";

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

function parseTimestampSort(
  query: Record<string, string | undefined>,
  field: string
): "desc" | "asc" {
  return query.sort === `${field}:asc` ? "asc" : "desc";
}

function sortByTimestamp<T extends { id: string }>(
  items: T[],
  field: string,
  direction: "desc" | "asc"
): T[] {
  const timeOf = (row: T): number => {
    const n = new Date(
      String((row as Record<string, unknown>)[field] ?? "")
    ).getTime();
    return Number.isFinite(n) ? n : 0;
  };
  return [...items].sort((a, b) => {
    const byTime = timeOf(a) - timeOf(b);
    if (byTime !== 0) return direction === "desc" ? -byTime : byTime;
    return a.id.localeCompare(b.id);
  });
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

export function registerAdminLicensesRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/licenses", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
    // Never expose license_key_hash or raw keys in list responses (API Spec §12.3)
    const query = c.req.query();
    const { q, limit, page } = parseListQuery(query);
    const filteredLicenses = store.state.licenses.filter(
      (l) =>
        includesQuery(l.license_number, q) ||
        includesQuery(
          store.state.customers.find((cu) => cu.id === l.customer_id)?.name,
          q,
        ) ||
        includesQuery(
          store.state.products.find((p) => p.id === l.product_id)?.code,
          q,
        ),
    );
    // Dashboard ordering: sort BEFORE the ?limit=100 window slices
    // (same gap as orders — the expiring-licenses panel sorts
    // client-side over the loaded set).
    const items = sortByTimestamp(
      filteredLicenses,
      "created_at",
      parseTimestampSort(query, "created_at"),
    ).map((l) => {
    const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = l;
    const customer = store.state.customers.find((cu) => cu.id === l.customer_id);
    const product = store.state.products.find((p) => p.id === l.product_id);
    return {
      ...safe,
      customer_name: customer?.name ?? null,
      product_code: product?.code ?? null,
      product_name: product?.name ?? null,
      active_activations_count: l.activations.filter((a) => a.status === "active").length,
      expires_date_display: l.expires_at
        ? formatDisplayDateDDMMYYYY(l.expires_at, env.DEFAULT_TIMEZONE)
        : "Lifetime",
      };
    });
    return pagedCollection(c, items, limit, page);
  });

  app.post("/api/v1/admin/licenses/manual-grants", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = await readJsonBody(c);
    const granted = await createManualLicenseGrantByAdmin(
      store,
      principal,
      body,
      env.LICENSE_VERIFIER_SECRET,
      requestId
    );
    return ok(c, granted, 201);
  });

  // E-05: signing-key lifecycle admin API (PRD §13.5; API spec
  // §16.6). Rotation/revocation exist only as store methods
  // until now — these routes expose them, permission-gated and
  // audit-logged. Placed BEFORE the :licenseId detail match:
  // GET /admin/licenses/signing-keys would otherwise match
  // licenseId="signing-keys" and 404.
  // List: public JWKs (never private material) + status per key
  // (active vs retired — revoked keys leave the store, so they
  // never appear here, same as the public endpoint).
  app.get("/api/v1/admin/licenses/signing-keys", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
    const keys = store.listPublicSigningKeys();
    return ok(c, {
      active_key_id: store.activeSigningKeyId,
      keys: keys.map((jwk) => ({
        key_id: (jwk as { kid?: unknown }).kid ?? null,
        status:
          (jwk as { kid?: unknown }).kid === store.activeSigningKeyId
            ? "active"
            : "retired",
        public_key_jwk: jwk,
      })),
    });
  });

  app.post("/api/v1/admin/licenses/signing-keys/rotate", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as { key_id?: unknown };
    const requestedId =
      typeof body.key_id === "string" && body.key_id.trim().length > 0
        ? body.key_id.trim()
        : undefined;
    // The store derives a fresh id when none is given
    // (DrizzleStore); the in-memory store needs an explicit one,
    // so derive the same shape here when absent.
    const nextKeyId =
      requestedId ??
      `key-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const rotated = await store.rotateSigningKey(nextKeyId);
    await store.withTransaction((state) => {
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: principal.user.id,
        action: "licenses.signing_key.rotated",
        resource_type: "signing_key",
        resource_id: rotated.keyId,
        outcome: "success",
        request_id: requestId,
        changes: { key_id: rotated.keyId },
      });
    });
    return ok(
      c,
      {
        key_id: rotated.keyId,
        status: "active",
        public_key_jwk: rotated.publicKeyJwk,
      },
      201
    );
  });

  app.post("/api/v1/admin/licenses/signing-keys/:keyId/revoke", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // Revoke is irreversible for that key id — licenses.revoke,
    // like license revocation. The active key can never be
    // revoked (rotate first); the store enforces it with 409.
    await assertStaffPermissionAudited(store, principal, "licenses.revoke", requestId);
    const keyId = c.req.param("keyId");
    await store.revokeSigningKey(keyId);
    await store.withTransaction((state) => {
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: principal.user.id,
        action: "licenses.signing_key.revoked",
        resource_type: "signing_key",
        resource_id: keyId,
        outcome: "success",
        request_id: requestId,
        changes: { key_id: keyId },
      });
    });
    return ok(c, { revoked: true, key_id: keyId });
  });

  // Batch 1: license detail + activations.
  // NOTE: GET /api/v1/admin/licenses/manual-grants would also match
  // this pattern with licenseId="manual-grants" — but that path has
  // no GET route, so a 404 here is correct; the POST above runs first.
  app.get("/api/v1/admin/licenses/:licenseId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
    const lic = store.state.licenses.find(
      (l) => l.id === c.req.param("licenseId")
    );
    if (!lic) throw new AppError("NOT_FOUND", "License not found.", 404);
    const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = lic;
    const customer = store.state.customers.find((cu) => cu.id === lic.customer_id);
    const product = store.state.products.find((p) => p.id === lic.product_id);
    return ok(c, {
      ...safe,
      customer_name: customer?.name ?? null,
      customer_email: customer?.email ?? null,
      product_code: product?.code ?? null,
      product_name: product?.name ?? null,
      active_activations_count: lic.activations.filter((a) => a.status === "active")
        .length,
      expires_date_display: lic.expires_at
        ? formatDisplayDateDDMMYYYY(lic.expires_at, env.DEFAULT_TIMEZONE)
        : "Lifetime",
      entitlement_snapshots: lic.snapshots,
    });
  });

  app.get("/api/v1/admin/licenses/:licenseId/activations", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
    const lic = store.state.licenses.find(
      (l) => l.id === c.req.param("licenseId")
    );
    if (!lic) throw new AppError("NOT_FOUND", "License not found.", 404);
    const { limit, page } = parseListQuery(c.req.query());
    return pagedCollection(c, lic.activations, limit, page);
  });

  app.post("/api/v1/admin/licenses/:licenseId/activations/:activationId/deactivate", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as { reason?: string };
    const result = await deactivateLicenseActivationByAdmin(
      store,
      principal,
      c.req.param("licenseId"),
      c.req.param("activationId"),
      body,
      requestId
    );
    return ok(c, result);
  });

  app.post("/api/v1/admin/licenses/:licenseId/activations/:activationId/transfer", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // E-03: audited activation transfer (Roadmap Stage 6 exit;
    // API spec §12.2).
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = await readJsonBody(c);
    const result = await transferActivation(
      store,
      principal,
      c.req.param("licenseId"),
      c.req.param("activationId"),
      body,
      requestId
    );
    return ok(c, result);
  });

  app.post("/api/v1/admin/licenses/:licenseId/:action", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    const action = c.req.param("action");
    if (action !== "suspend" && action !== "resume" && action !== "revoke") {
      // app.ts falls through to 404 for any other :action value.
      throw new AppError(
        "NOT_FOUND",
        `Route 'POST /api/v1/admin/licenses/${c.req.param("licenseId")}/${action}' not found.`,
        404
      );
    }
    // M-9: revoke is irreversible — it needs licenses.revoke;
    // suspend/resume need licenses.manage.
    await assertStaffPermissionAudited(
      store,
      principal,
      action === "revoke" ? "licenses.revoke" : "licenses.manage",
      requestId
    );
    const body = (await readJsonBodyLenient(c)) as { reason?: string };
    const updated = await transitionLicenseStatusByAdmin(
      store,
      principal,
      c.req.param("licenseId"),
      action,
      body.reason ?? "Admin lifecycle command",
      requestId
    );
    const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = updated;
    return ok(c, safe);
  });

  app.post("/api/v1/admin/licenses/:licenseId/entitlement-snapshots", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = (await readJsonBody(c)) as {
      reason: string;
      entitlements: Record<string, unknown>;
    };
    const snap = await appendLicenseEntitlementSnapshotByAdmin(
      store,
      principal,
      c.req.param("licenseId"),
      {
        reason: body.reason,
        entitlements: body.entitlements,
        requestId,
      }
    );
    return ok(c, snap, 201);
  });
}
