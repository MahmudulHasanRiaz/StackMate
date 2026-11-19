import { pgTable, uuid, text, varchar, bigint, integer, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";

/**
 * Media library (PLAN §31 / ADR-0011).
 *
 * `media_assets` is the library's own table — deliberately separate from
 * `uploaded_assets` (payment evidence): library files carry folders,
 * tags, image dimensions, and their OWN storage driver per row, so a
 * driver switch never orphans a library file (reads always use the
 * row's driver). The object key is server-generated
 * (`media/<yyyy>/<mm>/<uuid>-<sanitized-name>`); only the key, never
 * a public URL, is stored — objects stay private and are served only
 * through the authenticated content endpoint.
 *
 * `storage_settings` is a SINGLETON row (id `default`) holding the
 * selected storage driver (`r2` | `local`) + the local root path.
 * Runtime-applied, edited from Settings → Storage. Default `r2`.
 */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectKey: text("object_key").notNull().unique(),
    driver: text("driver").notNull().default("r2"), // r2 | local
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 150 }).notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    width: integer("width"),
    height: integer("height"),
    /** Sibling thumbnail objects (PLAN §34 / ADR-0012): 320px + 64px
     * WebP variants generated in the browser at upload. Nullable —
     * rows uploaded before migration 0013 have no thumbnail and the
     * UI falls back to the full original. */
    thumbObjectKey: text("thumb_object_key"),
    thumbSmallObjectKey: text("thumb_small_object_key"),
    thumbByteSize: integer("thumb_byte_size"),
    thumbSmallByteSize: integer("thumb_small_byte_size"),
    folder: varchar("folder", { length: 120 }).notNull().default(""),
    tags: text("tags").array().notNull().default([]),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_media_assets_folder_created").on(table.folder, table.createdAt.desc()),
    index("idx_media_assets_mime_created").on(table.mimeType, table.createdAt.desc()),
    index("idx_media_assets_created").on(table.createdAt.desc()),
  ]
);

export const storageSettings = pgTable("storage_settings", {
  id: text("id").primaryKey(), // always "default"
  driver: text("driver").notNull().default("r2"), // r2 | local
  localPath: text("local_path"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
