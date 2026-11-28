/**
 * Admin API-token routes (Hono) — OD-13 scoped API-token scheme.
 *
 * External API clients authenticate with a scoped bearer token
 * (`stk_` + secret, Worker B auth middleware); these admin routes let
 * staff with `api_tokens.manage` mint, list and revoke those tokens.
 *
 * The raw token `value` is returned ONLY by the create endpoint, once,
 * at mint time — it is never stored and never returned again. No
 * endpoint ever returns `token_hash`.
 *
 * Service lives in `modules/api-tokens/service.ts` (Worker A):
 * `createApiToken` / `listApiTokens` / `revokeApiToken` /
 * `validateApiTokenScopes`. The pepper comes from
 * `resolveTokenPepper(store, env.ENCRYPTION_KEY_V1)` (identity
 * service) — the existing ENCRYPTION_KEY_V1 master secret, reused.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
} from "../../../../../packages/contracts/src/index.ts";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import { assertStaffPermissionAudited } from "../../modules/identity/service.ts";
import { resolveTokenPepper } from "../../modules/identity/service.ts";
import type { StaffPrincipal } from "../../modules/identity/service.ts";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  validateApiTokenScopes,
} from "../../modules/api-tokens/service.ts";

// --- HTTP plumbing copied from sites-credentials.ts (per-file copies
// are the established pattern for admin route modules) ---

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

/** Public shape of a token row — never carries `token_hash` or `value`. */
function publicToken(row: {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}) {
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.token_prefix,
    scopes: row.scopes,
    created_by: row.created_by,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

function validateCreateBody(body: any): {
  name: string;
  scopes: string[];
  expiresAt: string | null;
} {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > 100) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Token name is required and must be at most 100 characters.",
      400
    );
  }
  const scopes = body?.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.some((s: unknown) => typeof s !== "string" || s.trim().length === 0)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "At least one scope is required (scopes must be a non-empty array of permission keys).",
      400
    );
  }
  const expiresRaw = body?.expires_at;
  let expiresAt: string | null = null;
  if (expiresRaw !== undefined && expiresRaw !== null && expiresRaw !== "") {
    if (typeof expiresRaw !== "string") {
      throw new AppError(
        "VALIDATION_ERROR",
        "expires_at must be an ISO 8601 date string.",
        400
      );
    }
    const parsed = new Date(expiresRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError(
        "VALIDATION_ERROR",
        "expires_at must be a valid ISO 8601 date.",
        400
      );
    }
    if (parsed.getTime() <= Date.now()) {
      throw new AppError(
        "VALIDATION_ERROR",
        "expires_at must be a future date.",
        400
      );
    }
    expiresAt = parsed.toISOString();
  }
  return { name, scopes, expiresAt };
}

export function registerAdminApiTokensRoutes(app: Hono<AppEnv>): void {
  // NOTE (OD-13): permission is enforced INSIDE each handler via
  // `assertStaffPermissionAudited` (the sites-credentials.ts pattern),
  // NOT as an `rbac()` middleware argument. Hono 4.13 calls #addRoute
  // once per handler argument, so `app.post(path, rbac(...), handler)`
  // registers the route TWICE in `app.routes` and trips the
  // hono-routes conformance "no duplicate" gate. Single-handler +
  // in-handler check keeps one entry per route and still audits
  // denials (the rbac() guard uses the same audited variant).
  app.post(
    "/api/v1/admin/api-tokens",
    async (c) => {
      const store = c.var.store;
      const env = c.var.env;
      const principal = requirePrincipal(c);
      await assertStaffPermissionAudited(store, principal, "api_tokens.manage", c.var.requestId);
      const body = await readJsonBody(c);
      const { name, scopes, expiresAt } = validateCreateBody(body);
      // Scope allowlist + caller-held check, against the CALLER's own
      // permissions/roles: a token can never grant more than its
      // creator holds, and excluded scopes (users.manage,
      // api_tokens.manage) can never be minted at all.
      validateApiTokenScopes(scopes, principal.permissions, principal.roles);
      const pepper = resolveTokenPepper(store, env.ENCRYPTION_KEY_V1) ?? null;
      const { record, value } = await createApiToken(store, {
        name,
        scopes,
        expiresAt,
        createdBy: principal.user.id,
        pepper,
      });
      // The `value` is returned ONLY here, at mint time — never again.
      return ok(
        c,
        {
          token: {
            id: record.id,
            name: record.name,
            token_prefix: record.token_prefix,
            scopes: record.scopes,
            expires_at: record.expires_at,
            created_at: record.created_at,
            value,
          },
        },
        201
      );
    }
  );

  app.get("/api/v1/admin/api-tokens", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    await assertStaffPermissionAudited(store, principal, "api_tokens.manage", c.var.requestId);
    const { q, limit, page } = parseListQuery(c.req.query());
    const rows = await listApiTokens(store);
    const filtered = rows
      .filter(
        (row) =>
          q === "" ||
          row.name.toLowerCase().includes(q) ||
          row.token_prefix.toLowerCase().includes(q)
      )
      .map(publicToken);
    return pagedCollection(c, filtered, limit, page);
  });

  app.post(
    "/api/v1/admin/api-tokens/:id/revoke",
    async (c) => {
      const store = c.var.store;
      const principal = requirePrincipal(c);
      await assertStaffPermissionAudited(store, principal, "api_tokens.manage", c.var.requestId);
      // Idempotent: revoking an already-revoked token returns the
      // record unchanged. The service throws NOT_FOUND (404) for an
      // unknown id.
      const revoked = await revokeApiToken(store, { id: c.req.param("id") });
      return ok(c, { token: publicToken(revoked) });
    }
  );
}
