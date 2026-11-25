import { pgTable, text, bigint, timestamp, index } from "drizzle-orm/pg-core";

/**
 * DB-backed rate-limit buckets (migration 0016, audit C-1).
 *
 * The API's DrizzleStore upserts one row per bucket key (count +
 * window reset) with a single atomic statement; the store accesses
 * the table only via raw SQL (pgClient.query), so this declaration
 * exists for schema completeness — check-migrations, drizzle-kit
 * generate, and direct drizzleDb reads — not for the limiter's hot
 * path, which stays raw SQL.
 *
 * CORRECTION (audit 2026-11-25 C-06): migration 0016's header claims
 * this table follows "the same pattern as migration 0012's media
 * tables, which have no db/schema declaration either". That is wrong:
 * `media_assets` IS declared in db/schema/media.ts (and
 * `storage_settings` too). Migration 0016 itself is NOT edited — an
 * applied migration is never rewritten — this declaration + note is
 * the correction. The `reset_at` index is migration 0021 (audit C-06).
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").primaryKey(),
    count: bigint("count", { mode: "number" }).notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_rate_limit_buckets_reset_at").on(table.resetAt),
  ]
);
