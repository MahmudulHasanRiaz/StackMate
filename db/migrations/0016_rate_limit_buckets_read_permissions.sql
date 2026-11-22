-- 0016 — audit fix follow-up (AUDIT-2026-11-19, C-1 + L-6):
-- (1) rate_limit_buckets table for the DB-backed rate limiter
-- (2) integrations.read + tracking.read permission keys + grants.
--
-- C-1: the API's DrizzleStore (apps/api/src/platform/db/drizzle-store.ts)
-- upserts rate-limit buckets into rate_limit_buckets with a
-- single-statement upsert (count increments, window resets iff expired).
-- The store was written against migration 0014, but 0014 never created
-- the table — until it lands the store catches 42P01 and falls back to
-- a per-isolate in-memory Map, which is weak on Workers (a fresh app
-- per request empties the bucket). This migration creates the table so
-- the DB-backed limiter actually engages. The store accesses the table
-- only via raw SQL (pgClient.query), so no Drizzle TS table is declared
-- for it — same pattern as migration 0012's media tables, which have
-- no db/schema declaration either.
--
-- L-6: GET /api/v1/admin/webhooks(+/:id/deliveries), /outbox-events and
-- /tracking/events gate on write permissions (integrations.manage /
-- tracking.manage) because no read keys existed in the catalogue.
-- This migration adds integrations.read + tracking.read (deterministic
-- UUIDs, continuing the 0000000001xx sequence after media.manage
-- ...131) and grants them: super_admin + admin hold everything (as in
-- the seed), read_only gets BOTH keys, marketing_manager gets
-- tracking.read only. db/seeds/seed-reference.ts is updated in the same
-- batch so fresh installs (in-memory store) agree. The parent switches
-- the three GET routes to the new keys in app.ts (one line each) after
-- this lands — that switch is NOT part of this migration.
--
-- All changes are additive and idempotent (CREATE TABLE IF NOT EXISTS /
-- ON CONFLICT DO NOTHING), so re-running is safe. Migrations 0000–0015
-- are NOT edited.

-- --- C-1: rate_limit_buckets ---
-- Exact shape the store's upsert expects:
--   INSERT INTO rate_limit_buckets ("key", "count", "reset_at")
--   VALUES ($1, 1, NOW() + ($2 * INTERVAL '1 millisecond'))
--   ON CONFLICT ("key") DO UPDATE SET ...
-- No defaults are needed — every statement supplies all three columns.
CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
  "key" text PRIMARY KEY,
  "count" bigint NOT NULL,
  "reset_at" timestamptz NOT NULL
);

-- --- L-6: integrations.read + tracking.read permission keys ---
INSERT INTO "permissions" ("id", "key", "description", "created_at")
VALUES
  ('00000000-0000-4000-8000-000000000132', 'integrations.read', 'View external website integrations, webhooks, and delivery records', now()),
  ('00000000-0000-4000-8000-000000000133', 'tracking.read', 'View Meta Pixel and Conversions API tracking events', now())
ON CONFLICT ("id") DO NOTHING;

-- --- L-6: grants ---
-- super_admin + admin hold every permission (seed-reference.ts grants
-- both roles SEED_PERMISSIONS.map(key)); read_only gets both read keys.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('integrations.read', 'tracking.read')
WHERE r."key" IN ('super_admin', 'admin', 'read_only')
ON CONFLICT DO NOTHING;

-- marketing_manager gets tracking.read only (it configures tracking;
-- it does not need the integrations read surface).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('tracking.read')
WHERE r."key" = 'marketing_manager'
ON CONFLICT DO NOTHING;
