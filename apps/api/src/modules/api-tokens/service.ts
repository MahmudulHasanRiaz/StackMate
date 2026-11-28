/**
 * Scoped API tokens — token core (OD-13, migration 0028).
 *
 * External API clients authenticate with a bearer value
 * `stk_<32 random bytes, base64url, no padding>`. Only the peppered
 * HMAC-SHA256 hash (`peppered:<hex>`, platform/crypto
 * `hashTokenPeppered` / `verifyTokenHash` — the same pattern as staff
 * invitations) is stored; the raw value is returned exactly once, at
 * creation, and never persisted, logged, or returned again.
 *
 * Scopes model: a token grants exactly the permission keys listed in
 * its `scopes` array — a subset of the permissions catalogue
 * (db/seeds/seed-reference.ts). Two keys can NEVER be granted to a
 * token: `users.manage` and `api_tokens.manage` (see
 * API_TOKEN_SCOPES_EXCLUDED) — a token can never manage staff and can
 * never mint/manage other tokens. A creator may only grant scopes
 * they themselves hold, unless they are `super_admin` (which holds
 * everything). The route layer (Workers B/C) enforces the held-check
 * with `validateApiTokenScopes` before calling `createApiToken`;
 * `createApiToken` itself re-checks unknown/excluded scopes so a
 * direct caller cannot slip one in.
 *
 * Pepper: the route layer resolves it with `resolveTokenPepper(store,
 * env.ENCRYPTION_KEY_V1)` (modules/identity/service.ts) and passes it
 * in. When the caller passes null, this module falls back to the same
 * resolver (store's encryption secret, then process.env) — with no
 * pepper anywhere, hashing falls back to the legacy bare SHA-256 form
 * and `verifyTokenHash` still accepts it, exactly like invitations.
 *
 * Storage: all data access goes through `./repository.ts`, which uses
 * the store's `drizzleDb` handle. With no `drizzleDb` (in-memory test
 * store) creation/listing/revocation throw STORE_UNAVAILABLE and
 * verification returns null — honestly, never silently faked.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { hashTokenPeppered, verifyTokenHash } from "../../platform/crypto/index.ts";
import {
  resolveTokenPepper,
  type StaffPrincipal,
} from "../identity/service.ts";
import type { StackMateDataStore } from "../../platform/db/store.ts";
import { SEED_PERMISSIONS } from "../../../../../db/seeds/seed-reference.ts";
import { AppError } from "../../shared/errors.ts";
import {
  getApiTokenDb,
  insertApiToken,
  listApiTokenCandidates,
  getApiTokenById,
  listApiTokenRows,
  revokeApiTokenRow,
  touchApiTokenLastUsed,
} from "./repository.ts";

export const API_TOKEN_PREFIX = "stk_";

/**
 * Scopes a token may never carry: `users.manage` (staff management)
 * and `api_tokens.manage` (minting/managing other tokens). A token
 * must never be able to escalate itself or others.
 */
export const API_TOKEN_SCOPES_EXCLUDED = ["users.manage", "api_tokens.manage"];

const KNOWN_SCOPES = new Set<string>(SEED_PERMISSIONS.map((p) => p.key));

export interface ApiTokenRecord {
  id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  scopes: string[];
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

type ApiTokenPublic = Omit<ApiTokenRecord, "token_hash">;

function publicRecord(record: ApiTokenRecord): ApiTokenPublic {
  return {
    id: record.id,
    name: record.name,
    token_prefix: record.token_prefix,
    scopes: [...record.scopes],
    created_by: record.created_by,
    expires_at: record.expires_at,
    revoked_at: record.revoked_at,
    last_used_at: record.last_used_at,
    created_at: record.created_at,
  };
}

function noDrizzleDbError(): AppError {
  return new AppError(
    "STORE_UNAVAILABLE",
    "API tokens require a PostgreSQL-backed store (drizzleDb); this store has none.",
    503
  );
}

/** "stk_" + 32 random bytes, base64url, no padding (47 chars total). */
export function generateApiTokenValue(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isApiTokenValue(v: string): boolean {
  return typeof v === "string" && v.startsWith(API_TOKEN_PREFIX);
}

/** Unknown / excluded / empty checks shared by create + validate. */
function assertAssignableScopes(scopes: string[]): void {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new AppError("VALIDATION_ERROR", "At least one scope is required.", 400);
  }
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.trim().length === 0) {
      throw new AppError("VALIDATION_ERROR", "Scopes must be non-empty strings.", 400);
    }
    if (API_TOKEN_SCOPES_EXCLUDED.includes(scope)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Scope '${scope}' cannot be granted to an API token.`,
        400
      );
    }
    if (!KNOWN_SCOPES.has(scope)) {
      throw new AppError("VALIDATION_ERROR", `Unknown scope '${scope}'.`, 400);
    }
  }
}

/**
 * Throws on: unknown scope, excluded scope, or a scope the creator
 * does not hold. A `super_admin` creator bypasses the held-check
 * (they hold every permission by definition). The held-check failure
 * is a 403 FORBIDDEN; unknown/excluded scopes are 400
 * VALIDATION_ERROR.
 */
export function validateApiTokenScopes(
  scopes: string[],
  creatorPermissions: string[],
  creatorRoles: string[] = []
): void {
  assertAssignableScopes(scopes);
  if (Array.isArray(creatorRoles) && creatorRoles.includes("super_admin")) return;
  const held = new Set<string>(creatorPermissions ?? []);
  for (const scope of scopes) {
    if (!held.has(scope)) {
      throw new AppError(
        "FORBIDDEN",
        `Creator does not hold scope '${scope}', so it cannot be granted to an API token.`,
        403
      );
    }
  }
}

export async function createApiToken(
  store: StackMateDataStore,
  input: {
    name: string;
    scopes: string[];
    expiresAt: string | null;
    createdBy: string;
    pepper: string | null;
  }
): Promise<{ record: ApiTokenRecord; value: string }> {
  const db = getApiTokenDb(store);
  if (!db) throw noDrizzleDbError();

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Token name is required.", 400);
  }
  if (name.length > 100) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Token name must be at most 100 characters.",
      400
    );
  }
  if (
    typeof input.createdBy !== "string" ||
    input.createdBy.trim().length === 0
  ) {
    throw new AppError("VALIDATION_ERROR", "createdBy is required.", 400);
  }
  // Unknown/excluded scopes are rejected here too (the held-check is
  // the route layer's job via validateApiTokenScopes, before this).
  assertAssignableScopes(input.scopes);

  let expiresAt: string | null = null;
  if (input.expiresAt !== null && input.expiresAt !== undefined) {
    const ms = Date.parse(input.expiresAt);
    if (Number.isNaN(ms)) {
      throw new AppError("VALIDATION_ERROR", "expiresAt must be a valid ISO date.", 400);
    }
    expiresAt = new Date(ms).toISOString();
  }

  const value = generateApiTokenValue();
  const pepper = resolveTokenPepper(store, input.pepper ?? null);
  const tokenHash = hashTokenPeppered(value, pepper);
  const record = await insertApiToken(db, {
    id: randomUUID(),
    name,
    tokenPrefix: value.slice(0, 12),
    tokenHash,
    scopes: [...input.scopes],
    createdBy: input.createdBy.trim(),
    expiresAt,
  });
  // `value` is returned exactly once, here. It is never stored.
  return { record, value };
}

/**
 * Returns the token record on success, or null on: wrong prefix, no
 * hash match, revoked, expired, or no `drizzleDb`. The `last_used_at`
 * touch is best-effort — its failure never fails authentication.
 */
export async function verifyApiToken(
  store: StackMateDataStore,
  input: { rawToken: string; pepper: string | null; nowMs?: number }
): Promise<ApiTokenRecord | null> {
  const rawToken = input.rawToken;
  if (!isApiTokenValue(rawToken)) return null;
  const db = getApiTokenDb(store);
  if (!db) return null;
  const pepper = resolveTokenPepper(store, input.pepper ?? null);
  const candidates = await listApiTokenCandidates(db);
  let matchedId: string | null = null;
  for (const candidate of candidates) {
    if (verifyTokenHash(rawToken, candidate.token_hash, pepper)) {
      matchedId = candidate.id;
      break;
    }
  }
  if (!matchedId) return null;
  const record = await getApiTokenById(db, matchedId);
  if (!record) return null;
  if (record.revoked_at !== null) return null;
  const nowMs = input.nowMs ?? Date.now();
  if (record.expires_at !== null && Date.parse(record.expires_at) <= nowMs) {
    return null;
  }
  try {
    await touchApiTokenLastUsed(db, record.id);
    record.last_used_at = new Date(nowMs).toISOString();
  } catch {
    // Best-effort only: a failed touch must never fail auth.
  }
  return record;
}

export async function listApiTokens(
  store: StackMateDataStore
): Promise<ApiTokenPublic[]> {
  const db = getApiTokenDb(store);
  if (!db) throw noDrizzleDbError();
  const rows = await listApiTokenRows(db);
  return rows.map(publicRecord);
}

export async function revokeApiToken(
  store: StackMateDataStore,
  input: { id: string }
): Promise<ApiTokenPublic> {
  const db = getApiTokenDb(store);
  if (!db) throw noDrizzleDbError();
  const existing = await getApiTokenById(db, input.id);
  if (!existing) {
    throw new AppError("NOT_FOUND", "API token not found.", 404);
  }
  // Idempotent: an already-revoked token returns its record unchanged
  // (original revoked_at kept), never an error.
  if (existing.revoked_at !== null) return publicRecord(existing);
  const revoked = await revokeApiTokenRow(db, input.id);
  // The row existed and was live a moment ago; a null here means a
  // concurrent revoke won the race — re-read and return that record.
  if (!revoked) {
    const reread = await getApiTokenById(db, input.id);
    if (!reread) throw new AppError("NOT_FOUND", "API token not found.", 404);
    return publicRecord(reread);
  }
  return publicRecord(revoked);
}

/**
 * The staff principal an API token authenticates as. Roles are ALWAYS
 * empty — a token is never `super_admin` and never gets the
 * super-admin bypass — and permissions are exactly the token's scopes.
 */
export function buildApiTokenPrincipal(token: ApiTokenRecord): StaffPrincipal {
  const principalId = `api-token:${token.id}`;
  return {
    user: {
      id: principalId,
      name: token.name,
      email: "",
      status: "active",
      avatar_url: null,
      email_verified: true,
    },
    session_id: principalId,
    roles: [],
    permissions: [...token.scopes],
    two_factor_enabled: false,
    two_factor_setup_required: false,
  };
}
