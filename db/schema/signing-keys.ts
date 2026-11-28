import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";

/**
 * Durable license signing keys (migration 0004).
 *
 * The Ed25519 private key that signs license entitlement JWSs lives HERE
 * and nowhere else: `encryptedPrivateJwk` is the private JWK encrypted
 * with AES-256-GCM under ENCRYPTION_KEY_V1, bound to AAD
 * "signing_key:<key_id>" (see drizzle-store.ts signingKeyAadContext).
 * The public JWK is stored in clear — it is published by
 * GET /api/v1/licenses/signing-keys.
 *
 * Status lifecycle: exactly one row is 'active' (partial unique index);
 * rotation retires the old active key (it stays verifiable); revocation
 * removes a key from the verification set entirely, so tokens signed by
 * it stop verifying. `supersedesKeyId` records the rotation chain.
 *
 * signing_key_metadata (db/schema/licenses.ts, migration 0000) is KEPT
 * as the public metadata mirror: DrizzleStore keeps it in sync with this
 * table on bootstrap / rotation / revocation, in the same transaction.
 * Private material is NEVER written to signing_key_metadata.
 */
export const signingKeys = pgTable(
  "signing_keys",
  {
    id: uuid("id").primaryKey(),
    keyId: text("key_id").notNull().unique(),
    // NOTE: the column is "public_jwk" in SQL (migration 0004) and in
    // the API's raw SQL (drizzle-store.ts) — the TS property keeps the
    // longer name, but the COLUMN string must stay "public_jwk" or
    // drizzle-kit generate emits a rename of the live column.
    publicKeyJwk: jsonb("public_jwk").notNull(),
    encryptedPrivateJwk: text("encrypted_private_jwk").notNull(),
    status: text("status").notNull(), // active | retired | revoked
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    // NOTE: supersedes_key_id is a self-referencing FK in SQL only
    // (migration 0004: REFERENCES signing_keys(key_id) ON DELETE SET
    // NULL). Declaring it with .references(() => signingKeys.keyId) here
    // makes the table reference itself in its own initializer, which
    // TypeScript cannot infer — same SQL-only precedent as the
    // single-active partial unique index (see below).
    supersedesKeyId: text("supersedes_key_id"),
    rotationReason: text("rotation_reason"),
  },
  (table) => [
    // NOTE: the "exactly one active key" rule lives in SQL only
    // (migration 0004: partial unique index on a constant,
    // uq_signing_keys_single_active), like other SQL-only constraints
    // in this repo — Drizzle's index builder cannot express it.
    index("idx_signing_keys_status").on(table.status),
    check("signing_keys_status_check", sql`"status" IN ('active', 'retired', 'revoked')`),
  ]
);
