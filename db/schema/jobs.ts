import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Scheduled job runs (migration 0024, audit 2026-11-25 E-21 follow-up).
 *
 * One row per run of a scheduled job (the every-minute cron's outbox
 * drain + renewal/expiry sweep, and any later job): job_key + start /
 * finish + status + a JSON summary of the run report (counts/errors)
 * + error detail on failure. Storage for the Jobs/Runs view — no cron
 * behaviour lives here.
 *
 * Deliberately NOT part of the DrizzleStore `buildLoadStateQuery`
 * full-state load: job runs are append-only history and are read with
 * direct `drizzleDb` queries only (Worker B/A2), never through the
 * per-request full-state snapshot.
 */
export const scheduledJobRuns = pgTable(
  "scheduled_job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobKey: text("job_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull(), // running | succeeded | failed (writer-owned vocabulary, no CHECK)
    summary: jsonb("summary"),
    error: text("error"),
  },
  (table) => [
    index("idx_scheduled_job_runs_job_started").on(table.jobKey, table.startedAt.desc()),
  ]
);
