import { pgTable, uuid, text, varchar, bigint, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { customers } from "./customers.ts";

export const uploadedAssets = pgTable(
  "uploaded_assets",
  {
    id: uuid("id").primaryKey(),
    objectKey: text("object_key").notNull().unique(),
    bucketName: varchar("bucket_name", { length: 120 }).notNull(),
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 150 }).notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    visibility: text("visibility").notNull().default("private"), // private | public
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ownerCustomerId: uuid("owner_customer_id").references(() => customers.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_uploaded_assets_owner_created").on(table.ownerCustomerId, table.createdAt.desc()),
    index("idx_uploaded_assets_visibility_created").on(table.visibility, table.createdAt.desc()),
  ]
);
