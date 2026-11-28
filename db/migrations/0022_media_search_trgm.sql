-- 0022 — audit 2026-11-25 C-03: media search indexes.
--
-- Media search is a leading-wildcard ILIKE plus a per-row unnest
-- (apps/api/src/modules/media/service.ts): `%q%` cannot use a B-tree
-- index, and the tag search unnests the tags array for every row
-- scanned. Media list is the one endpoint that queries SQL directly
-- (not the in-memory store), so this is the one place where a missing
-- index is already a live cost; it degrades linearly with library
-- size. This migration adds:
--   - a pg_trgm GIN index on original_filename (serves %q% ILIKE via
--     trigram similarity), and
--   - a GIN index on tags (serves the array-membership search without
--     unnesting every row).
-- The %q% pattern stays behind the trigram index — no query change
-- needed in the service.
--
-- Extension dependency (DB spec §10 rule: document any extension
-- dependency and its portability impact before adoption):
-- pg_trgm is a PostgreSQL contrib extension, available on Neon /
-- Hyperdrive Postgres and on stock PostgreSQL 16. It is Postgres-only:
-- the MySQL second-dialect direction (owner decision 2026-11-18)
-- cannot use it — a MySQL media-search implementation needs its own
-- full-text index instead. No application code depends on pg_trgm
-- functions directly; only these two indexes use it, so dropping the
-- extension later only costs the filename trigram index (the tags GIN
-- index is extension-free).
--
-- Both indexes are also declared in db/schema/media.ts (same names)
-- so drizzle-kit generate reproduces them — see db/schema/README.md.
--
-- All changes are additive and idempotent (CREATE EXTENSION /
-- CREATE INDEX IF NOT EXISTS), so re-running is safe. Migrations
-- 0000–0021 are NOT edited.

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE INDEX IF NOT EXISTS "idx_media_assets_original_filename_trgm"
  ON "media_assets" USING gin ("original_filename" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_media_assets_tags_gin"
  ON "media_assets" USING gin ("tags");
