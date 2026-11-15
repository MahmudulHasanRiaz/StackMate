-- StackMate Migration 0004: Durable license signing keys (signing_keys)
--
-- Why this migration exists: until now the Ed25519 private key that signs
-- license entitlement JWSs lived only in the LICENSE_SIGNING_PRIVATE_JWK
-- env var, or was generated PER PROCESS when no JWK was configured
-- (drizzle-store.ts header note 4). Every worker restart / isolate
-- recycled the verification key, so previously issued entitlement tokens
-- stopped verifying. This table makes PostgreSQL the source of truth for
-- signing keys:
--
--   signing_keys .................. ONE row per key version. The private
--                                     JWK is stored encrypted with
--                                     AES-256-GCM (ENCRYPTION_KEY_V1) and
--                                     bound to AAD "signing_key:<key_id>"
--                                     (see apps/api/src/platform/crypto and
--                                     drizzle-store.ts signingKeyAadContext).
--                                     The public JWK is stored in clear
--                                     (jsonb) — it is published by
--                                     GET /api/v1/licenses/signing-keys.
--   status ........................ 'active' | 'retired' | 'revoked'.
--                                     Exactly ONE row may be 'active' at a
--                                     time (partial unique index below).
--                                     Retired keys stay verifiable (their
--                                     public JWKs stay published, their
--                                     private material stays decryptable);
--                                     revoked keys are removed from the
--                                     store's verification set and from the
--                                     JWKS endpoint, so their tokens stop
--                                     verifying.
--   supersedes_key_id ............. rotation chain: the new active key
--                                     points at the key it replaced.
--   rotation_reason ............... free-text reason recorded at rotation.
--
-- signing_key_metadata (migration 0000) is KEPT as-is: it remains the
-- public metadata mirror (key_id, public JWK, status, activated/retired
-- timestamps) that older code reads. DrizzleStore keeps it in sync with
-- signing_keys on bootstrap / rotation / revocation (same transaction),
-- so the two tables can never diverge. The private material lives ONLY
-- in signing_keys.encrypted_private_jwk — never in signing_key_metadata.
--
-- All changes are additive (one new table + two indexes) and idempotent,
-- so re-running is safe. No existing table is altered. If this migration
-- has not been applied, DrizzleStore fails closed at boot with a clear
-- "apply migration 0004" error instead of silently generating a
-- per-process key.

CREATE TABLE IF NOT EXISTS "signing_keys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "key_id" text NOT NULL UNIQUE,
  "public_jwk" jsonb NOT NULL,
  "encrypted_private_jwk" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('active', 'retired', 'revoked')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "activated_at" timestamptz,
  "retired_at" timestamptz,
  "supersedes_key_id" text REFERENCES "signing_keys" ("key_id") ON DELETE SET NULL,
  "rotation_reason" text
);

-- Exactly one active key at any time. (A partial unique index on a
-- constant is the standard way to express "at most one row matches".)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_signing_keys_single_active"
  ON "signing_keys" ((true))
  WHERE "status" = 'active';

CREATE INDEX IF NOT EXISTS "idx_signing_keys_status"
  ON "signing_keys" ("status");
