-- StackMate Migration 0008: General (app-wide) settings — owner order 2026-11-16.
--
-- Why this migration exists: Settings → General holds the app-wide
-- configuration the admin edits from the panel (App Name, App Title,
-- Favicon, App Description, Support Email). It must be runtime-applied —
-- an admin save reaches the UI immediately with no redeploy — so it lives
-- in the database, not in env vars or code (ADR-0008, same pattern as the
-- auth-config tables in migration 0007).
--
--   general_settings ............. SINGLETON row (id "default"). Every
--                                 value renders somewhere visible (no dead
--                                 stored values): app_name → sidebar/topbar
--                                 brand + document-title fallback;
--                                 app_title → the browser tab; favicon_* →
--                                 the uploaded favicon stored in R2 under a
--                                 server-side key, served publicly via
--                                 GET /api/v1/favicon (only the R2 object
--                                 key + content type + size live here —
--                                 never the bytes, never a data URL);
--                                 app_description → meta description +
--                                 the login page tagline; support_email →
--                                 the login page contact for staff who
--                                 cannot sign in.
--                                 Admin edits are never overwritten by
--                                 seeds: no seed writes this row.
CREATE TABLE IF NOT EXISTS "general_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "app_name" text NOT NULL DEFAULT 'StackMate',
  "app_title" text NOT NULL DEFAULT 'StackMate Admin',
  "app_description" text NOT NULL DEFAULT '',
  "support_email" text NOT NULL DEFAULT '',
  "favicon_object_key" text,
  "favicon_content_type" text,
  "favicon_byte_size" integer,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
