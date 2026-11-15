-- StackMate Migration 0006: Tracking pixel groups
-- (tracking_configurations label + per-pixel uniqueness)
--
-- Why this migration exists: the admin used to allow ONE tracking
-- configuration per (integrated site, provider) — the unique
-- constraint uq_tracking_configurations_site_provider on
-- (integrated_site_id, provider). The owner decision 2026-11-15
-- requires MULTIPLE PIXEL GROUPS per platform: each group has its
-- own pixel ID, test code and CAPI token, with enable/disable.
-- The API + Settings UI for per-group CRUD (create/list/update/
-- delete/toggle) land with this migration.
--
--   tracking_configurations.label ... Human group name shown in the
--                                 Settings UI ("Main pixel", "Retargeting").
--                                 NULL for groups created before this
--                                 migration — the UI falls back to the
--                                 pixel ID when no label is set.
--   new unique .................. (integrated_site_id, provider,
--                                 pixel_id): one group per pixel per
--                                 provider per site.
--
-- Expand-and-contract, no data migration: every existing row already
-- satisfies the new unique — the old constraint allowed at most one
-- row per (site, provider), so no two rows can share
-- (site, provider, pixel_id). Adding a nullable column and swapping
-- the unique constraint cannot fail on existing data. All statements
-- are idempotent (IF NOT EXISTS / IF EXISTS), so re-running is safe.
-- No existing table is altered besides tracking_configurations.

ALTER TABLE "tracking_configurations" ADD COLUMN IF NOT EXISTS "label" varchar(120);

ALTER TABLE "tracking_configurations" DROP CONSTRAINT IF EXISTS "uq_tracking_configurations_site_provider";

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS: the DO block is the
-- idempotent form (same pattern as migration 0002's FK add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_tracking_configurations_site_provider_pixel'
  ) THEN
    ALTER TABLE "tracking_configurations"
      ADD CONSTRAINT "uq_tracking_configurations_site_provider_pixel"
      UNIQUE ("integrated_site_id", "provider", "pixel_id");
  END IF;
END $$;
