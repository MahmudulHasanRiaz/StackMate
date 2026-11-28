/**
 * Scoped API tokens — Drizzle data access (OD-13, migration 0028).
 *
 * The store interface (`platform/db/store.ts`) and `drizzle-store.ts`
 * are owned by the unpushed LV-03 batch and are NOT edited here, so
 * this repository reaches Postgres through the store's `drizzleDb`
 * handle (same cast `middleware/auth.ts` uses) with drizzle `sql`
 * raw queries. No `drizzleDb` → `getApiTokenDb` returns null and the
 * service fails honestly (create/list/revoke throw STORE_UNAVAILABLE;
 * verify returns null) — never silently pretends success, never
 * stores tokens in memory.
 *
 * LOOKUP NOTE: token hashes are peppered HMAC-SHA256
 * (`peppered:<hex>`), so the hash of a presented value cannot be
 * derived for a WHERE clause — equality lookup is impossible by
 * design. `listApiTokenCandidates` therefore selects only the
 * (id, token_hash) pairs of live (non-revoked) rows and the service
 * verifies each in code with constant-time `verifyTokenHash`. That is
 * correct while this table stays small (a handful of tokens per
 * install), but it is a full scan of live tokens on EVERY verify:
 * if the table ever grows large, add a lookup key (e.g. a random
 * per-token `lookup_id` embedded in the value, or a truncated hash
 * prefix column) and select by it first. Do NOT "fix" this by
 * switching to an unpeppered hash — that would let a DB read leak
 * verifiable token material.
 */
import { sql, type SQL } from "drizzle-orm";
import type { ApiTokenRecord } from "./service.ts";

/** Minimal shape of the drizzle DB handle this repository needs. */
export interface ApiTokenDb {
  execute: (query: SQL) => Promise<{
    rows?: unknown[];
    rowCount?: number | null;
  }>;
}

/**
 * The store's drizzle handle, or null when the store has none
 * (in-memory test store). Callers must handle null honestly.
 */
export function getApiTokenDb(store: unknown): ApiTokenDb | null {
  const maybe = store as unknown as { drizzleDb?: unknown };
  if (!maybe || typeof maybe !== "object" || !maybe.drizzleDb) return null;
  return maybe.drizzleDb as ApiTokenDb;
}

type ApiTokenRow = Record<string, unknown>;

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      return [];
    }
  }
  return [];
}

function mapRow(row: ApiTokenRow): ApiTokenRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    token_prefix: String(row.token_prefix),
    token_hash: String(row.token_hash),
    scopes: toScopes(row.scopes),
    created_by: String(row.created_by),
    expires_at: toIso(row.expires_at),
    revoked_at: toIso(row.revoked_at),
    last_used_at: toIso(row.last_used_at),
    created_at: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function firstRow(result: { rows?: unknown[] }): ApiTokenRow | null {
  const rows = result.rows ?? [];
  if (rows.length === 0) return null;
  return rows[0] as ApiTokenRow;
}

export async function insertApiToken(
  db: ApiTokenDb,
  input: {
    id: string;
    name: string;
    tokenPrefix: string;
    tokenHash: string;
    scopes: string[];
    createdBy: string;
    expiresAt: string | null;
  }
): Promise<ApiTokenRecord> {
  const result = await db.execute(
    sql`INSERT INTO "api_tokens"
           ("id", "name", "token_prefix", "token_hash", "scopes", "created_by", "expires_at")
         VALUES (${input.id}, ${input.name}, ${input.tokenPrefix}, ${input.tokenHash},
                 ${JSON.stringify(input.scopes)}::jsonb, ${input.createdBy},
                 ${input.expiresAt}::timestamptz)
         RETURNING *`
  );
  const row = firstRow(result);
  if (!row) throw new Error("insertApiToken: INSERT returned no row.");
  return mapRow(row);
}

/** Live (non-revoked) tokens' ids + hashes only — the verify scan set. */
export async function listApiTokenCandidates(
  db: ApiTokenDb
): Promise<Array<{ id: string; token_hash: string }>> {
  const result = await db.execute(
    sql`SELECT "id", "token_hash" FROM "api_tokens" WHERE "revoked_at" IS NULL`
  );
  return (result.rows ?? []).map((r) => {
    const row = r as ApiTokenRow;
    return { id: String(row.id), token_hash: String(row.token_hash) };
  });
}

export async function getApiTokenById(
  db: ApiTokenDb,
  id: string
): Promise<ApiTokenRecord | null> {
  const result = await db.execute(
    sql`SELECT * FROM "api_tokens" WHERE "id" = ${id}`
  );
  const row = firstRow(result);
  return row ? mapRow(row) : null;
}

export async function listApiTokenRows(db: ApiTokenDb): Promise<ApiTokenRecord[]> {
  const result = await db.execute(
    sql`SELECT * FROM "api_tokens" ORDER BY "created_at" DESC, "id" DESC`
  );
  return (result.rows ?? []).map((r) => mapRow(r as ApiTokenRow));
}

/**
 * Marks a live token revoked. Returns the updated row, or null when
 * nothing was updated (missing id, or already revoked — the caller
 * distinguishes those via getApiTokenById first).
 */
export async function revokeApiTokenRow(
  db: ApiTokenDb,
  id: string
): Promise<ApiTokenRecord | null> {
  const result = await db.execute(
    sql`UPDATE "api_tokens"
            SET "revoked_at" = NOW()
          WHERE "id" = ${id} AND "revoked_at" IS NULL
          RETURNING *`
  );
  const row = firstRow(result);
  return row ? mapRow(row) : null;
}

/** Best-effort last-used touch; callers swallow failures (never fail auth). */
export async function touchApiTokenLastUsed(db: ApiTokenDb, id: string): Promise<void> {
  await db.execute(
    sql`UPDATE "api_tokens" SET "last_used_at" = NOW() WHERE "id" = ${id}`
  );
}
