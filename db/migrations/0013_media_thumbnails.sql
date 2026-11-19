-- 0013 — media thumbnails (PLAN §34 / ADR-0012, owner order 2026-11-18).
--
-- Thumbnails are generated in the BROWSER at upload (canvas → WebP)
-- and stored as sibling objects next to the original; the row records
-- their keys + byte sizes so the content endpoint can serve them
-- without a second storage lookup. All four columns are nullable and
-- additive (expand-and-contract): rows uploaded before this migration
-- simply have no thumbnail (thumb_url null) and the UI falls back to
-- the full original. No permission/grant changes, no data rewrite.
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "thumb_object_key" text;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "thumb_small_object_key" text;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "thumb_byte_size" integer CHECK ("thumb_byte_size" IS NULL OR "thumb_byte_size" > 0);
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "thumb_small_byte_size" integer CHECK ("thumb_small_byte_size" IS NULL OR "thumb_small_byte_size" > 0);
