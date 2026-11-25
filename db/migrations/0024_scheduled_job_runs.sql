-- 0024 — scheduled_job_runs table (audit 2026-11-25, Batch E-21
-- follow-up: scheduled-jobs visibility).
--
-- The every-minute cron runs the outbox drain + renewal/expiry sweep,
-- but no durable per-run record exists — failed-job inspection lives
-- only per outbox event, not per job/run. This table is the storage
-- for one row per job run (job_key + started/finished + status +
-- summary + error) so the Jobs/Runs view (Worker B/A2) can list runs.
-- It is storage only: no cron behaviour changes in this migration.
--
-- Shape (fixed by the fix plan — do not extend here):
--   id uuid PK default gen_random_uuid()
--   job_key text NOT NULL
--   started_at timestamptz NOT NULL default now()
--   finished_at timestamptz (NULL while running)
--   status text NOT NULL (no CHECK — the writer owns the vocabulary;
--     known values: running | succeeded | failed)
--   summary jsonb (per-run report counts/errors)
--   error text (failure detail, NULL on success)
-- Index (job_key, started_at DESC): the Runs view lists one job's
-- runs newest-first.
--
-- Declared in db/schema/jobs.ts (same shape) so drizzle-kit generate
-- reproduces it. Deliberately NOT added to the DrizzleStore
-- buildLoadStateQuery full-state load: job runs are append-only
-- history and are read with direct drizzleDb queries only.
--
-- All changes are additive and idempotent (CREATE TABLE / CREATE
-- INDEX IF NOT EXISTS), so re-running is safe. Migrations 0000–0023
-- are NOT edited.

CREATE TABLE IF NOT EXISTS "scheduled_job_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_key" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "status" text NOT NULL,
  "summary" jsonb,
  "error" text
);

CREATE INDEX IF NOT EXISTS "idx_scheduled_job_runs_job_started" ON "scheduled_job_runs" ("job_key", "started_at" DESC);
