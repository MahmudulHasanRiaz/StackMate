import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Scoped API tokens for external API clients (OD-13, migration 0028).
 *
 * One row per token. The raw token value (`stk_...`) is NEVER stored:
 * only `token_hash` (peppered HMAC-SHA256, `peppered:<hex>`, see
 * platform/crypto `hashTokenPeppered`) is persisted, and the value is
 * shown to its creator exactly once at creation time. `token_prefix`
 * (the first 12 characters of the value) is stored in clear so the
 * admin UI can identify a token without ever seeing the value again.
 *
 * `scopes` is the exact permission-key list the token grants
 * (a JSON array of strings from the permissions catalogue). It NEVER
 * contains `users.manage` or `api_tokens.manage` (see
 * API_TOKEN_SCOPES_EXCLUDED in modules/api-tokens/service.ts): a token
 * can never mint or manage other tokens, and can never manage staff.
 *
 * `created_by` is the staff user id that created the token. It is
 * deliberately NOT a foreign key: tokens must stay revocable and
 * listable even if the creating staff record is later removed, and
 * the admin routes always resolve the creator through the identity
 * module, never through a DB join.
 *
 * Verification is a hash scan (see modules/api-tokens/repository.ts):
 * the peppered hash cannot be derived for a WHERE clause, so the
 * verifier selects the (small) candidate set and checks each hash in
 * code with constant-time `verifyTokenHash`.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    createdBy: uuid("created_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_api_tokens_created_by").on(table.createdBy)]
);
