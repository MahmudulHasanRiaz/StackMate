-- 0012 — media library + storage driver settings (PLAN §31 / ADR-0011,
-- owner order 2026-11-18).
--
-- media_assets is the library's own table — separate from uploaded_assets
-- (payment evidence): library files carry folders, tags, image
-- dimensions, and their OWN storage driver per row, so a driver switch
-- never orphans a library file (reads always use the row's driver).
-- The object key is server-generated; only the key is stored — objects
-- stay private and are served only through the authenticated content
-- endpoint. storage_settings is a singleton row (id 'default') holding
-- the selected driver (r2 | local) + the local root path.
CREATE TABLE IF NOT EXISTS "media_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "object_key" text NOT NULL UNIQUE,
  "driver" text NOT NULL DEFAULT 'r2' CHECK ("driver" IN ('r2', 'local')),
  "original_filename" varchar(255) NOT NULL,
  "mime_type" varchar(150) NOT NULL,
  "byte_size" bigint NOT NULL CHECK ("byte_size" > 0),
  "checksum_sha256" varchar(64) NOT NULL,
  "width" integer CHECK ("width" IS NULL OR "width" > 0),
  "height" integer CHECK ("height" IS NULL OR "height" > 0),
  "folder" varchar(120) NOT NULL DEFAULT '',
  "tags" text[] NOT NULL DEFAULT '{}',
  "uploaded_by_user_id" text REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_media_assets_folder_created"
  ON "media_assets" ("folder", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_media_assets_mime_created"
  ON "media_assets" ("mime_type", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_media_assets_created"
  ON "media_assets" ("created_at" DESC);

CREATE TABLE IF NOT EXISTS "storage_settings" (
  "id" text PRIMARY KEY,
  "driver" text NOT NULL DEFAULT 'r2' CHECK ("driver" IN ('r2', 'local')),
  "local_path" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- --- Media permissions + role grants --------------------------------------
-- New permission rows (deterministic UUIDs continue the 0003 sequence;
-- 0009 used ...126–...129).
INSERT INTO "permissions" ("id", "key", "description", "created_at")
VALUES
  ('00000000-0000-4000-8000-000000000130', 'media.view', 'View the media library and download files', now()),
  ('00000000-0000-4000-8000-000000000131', 'media.manage', 'Upload, rename, move, and delete media files', now())
ON CONFLICT ("id") DO NOTHING;

-- Grants: super_admin + admin + support_staff get both (media is working
-- content, like tickets/leads); read_only gets view only.
-- finance_manager / license_manager / product_manager / marketing_manager
-- intentionally get none.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('media.view', 'media.manage')
WHERE r."key" IN ('super_admin', 'admin', 'support_staff')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('media.view')
WHERE r."key" = 'read_only'
ON CONFLICT DO NOTHING;
