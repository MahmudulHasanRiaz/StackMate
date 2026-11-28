-- 0028 — Scoped API tokens (OD-13, 2026-11-28).
--
-- Why: external API clients need a proper scoped API-token scheme
-- (OD-13 decision): a token grants exactly the permission scopes it
-- was created with — never users.manage, never api_tokens.manage —
-- and is verified by peppered hash only, never stored in clear.
--
-- Table `api_tokens`:
--   id ........... uuid PK, gen_random_uuid()
--   name ......... admin-chosen label (required, max 100 chars in code)
--   token_prefix . first 12 chars of the `stk_...` value, for display
--   token_hash ... peppered HMAC-SHA256 (`peppered:<hex>`, or legacy
--                  bare SHA-256 when no pepper was available); the raw
--                  value is shown ONCE at creation and never stored.
--   scopes ....... jsonb array of permission keys granted to the token
--   created_by ... staff user id that created the token (no FK: tokens
--                  must stay revocable/listable even if the creator's
--                  staff record is later removed)
--   expires_at ... nullable; a token at/past expiry never verifies
--   revoked_at ... nullable; revocation is permanent and idempotent
--   last_used_at . nullable; best-effort touch on successful verify
--   created_at ... timestamptz, default now()
--
-- Permission `api_tokens.manage` (deterministic UUID ...137,
-- continuing the 0000000001xx sequence after
-- expense_categories.manage ...136): "Create, list, and revoke scoped
-- API tokens". Granted to super_admin + admin only — admin holds every
-- permission per seed-reference.ts, and no other role mints tokens.
-- The token scopes themselves can never include this key (enforced in
-- modules/api-tokens/service.ts), so a token can never mint tokens.
--
-- All changes are additive and idempotent (IF NOT EXISTS /
-- ON CONFLICT DO NOTHING), so re-running is safe.
-- Migrations 0000–0027 are NOT edited.

-- --- Table ---
CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "token_prefix" text NOT NULL,
  "token_hash" text NOT NULL,
  "scopes" jsonb NOT NULL,
  "created_by" uuid NOT NULL,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_api_tokens_created_by" ON "api_tokens" ("created_by");

-- --- Permission key (deterministic UUID, continuing the 0000000001xx
-- sequence after expense_categories.manage ...136) ---
INSERT INTO "permissions" ("id", "key", "description", "created_at")
VALUES
  ('00000000-0000-4000-8000-000000000137', 'api_tokens.manage', 'Create, list, and revoke scoped API tokens', now())
ON CONFLICT ("id") DO NOTHING;

-- --- Grants: super_admin + admin only ---
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'api_tokens.manage'
WHERE r."key" IN ('super_admin', 'admin')
ON CONFLICT DO NOTHING;
