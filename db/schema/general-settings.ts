import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * General (app-wide) settings (Auth + Email batch, 2026-11-16 — owner
 * order: Settings → General).
 *
 * A SINGLETON row (id `default`) holding the app-wide configuration the
 * admin edits from Settings → General. Every value renders somewhere
 * visible — no dead stored values:
 *  - app_name: sidebar/topbar brand + document-title fallback.
 *  - app_title: the browser tab (document.title).
 *  - app_description: meta description + the login page tagline.
 *  - support_email: the login page contact for staff who cannot sign in.
 *  - favicon_*: the uploaded favicon (PNG/ICO/SVG, ≤256KB) stored in R2
 *    under a server-side key and served publicly via GET /api/v1/favicon.
 *    Only the R2 object key + content type + size live here — never the
 *    bytes, and never a data URL (the R2 upload pattern is reused).
 *
 * Admin edits are never overwritten by seeds: no seed writes this row.
 */
export const generalSettings = pgTable("general_settings", {
  id: text("id").primaryKey(), // always "default"
  appName: text("app_name").notNull().default("StackMate"),
  appTitle: text("app_title").notNull().default("StackMate Admin"),
  appDescription: text("app_description").notNull().default(""),
  supportEmail: text("support_email").notNull().default(""),
  faviconObjectKey: text("favicon_object_key"),
  faviconContentType: text("favicon_content_type"),
  faviconByteSize: integer("favicon_byte_size"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
