-- StackMate Migration 0005: Staff invitations (staff_invitations)
--
-- Why this migration exists: API Spec §8 requires staff invitations
-- (POST /api/v1/admin/users/invitations), and there is no email system to
-- send them with. An admin creates an invitation and receives its
-- single-use token ONCE; the invitee redeems it via
-- POST /api/auth/accept-invitation. Only the SHA-256 hash of the token is
-- stored — the raw token is never persisted (same rule as the first-admin
-- SETUP_TOKEN and license-key verifiers).
--
--   staff_invitations ........... ONE row per invitation. status is
--                                 'pending' | 'accepted' | 'revoked' |
--                                 'expired'. Exactly ONE pending invitation
--                                 may exist per email (partial unique index
--                                 below); inviting the same email again
--                                 requires revoking/expiring the pending one
--                                 first. Tokens expire 7 days after creation
--                                 (enforced at redemption time; an expired
--                                 pending invitation is marked 'expired' when
--                                 it is observed past expiry).
--
-- All changes are additive (one new table + three indexes) and idempotent,
-- so re-running is safe. No existing table is altered.

CREATE TABLE IF NOT EXISTS "staff_invitations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "email" varchar(320) NOT NULL,
  "name" varchar(200) NOT NULL,
  "role_keys" jsonb NOT NULL DEFAULT '[]',
  "token_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired')),
  "expires_at" timestamptz NOT NULL,
  "invited_by_user_id" text REFERENCES "users" ("id") ON DELETE SET NULL,
  "accepted_user_id" text REFERENCES "users" ("id") ON DELETE SET NULL,
  "accepted_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Exactly one pending invitation per email at any time.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_staff_invitations_pending_email"
  ON "staff_invitations" ("email")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "idx_staff_invitations_token_hash"
  ON "staff_invitations" ("token_hash");

CREATE INDEX IF NOT EXISTS "idx_staff_invitations_status"
  ON "staff_invitations" ("status");
