/**
 * Cron overlap guard (A-05) — DB-row lease, no new service.
 *
 * `handleScheduled` (app.ts, Worker A2 wiring) calls
 * `tryAcquireCronLease` once per job per tick and `releaseCronLease`
 * when the job finishes. A tick whose predecessor still holds a live
 * lease is SKIPPED, so a slow drain/sweep can never overlap itself
 * and send the same reminders twice.
 *
 * Table `scheduled_job_runs` (Worker C migration — definition assumed
 * here; do not invent a different shape):
 *   id uuid PK default gen_random_uuid(), job_key text NOT NULL,
 *   started_at timestamptz NOT NULL default now(),
 *   finished_at timestamptz, status text NOT NULL, summary jsonb,
 *   error text; index (job_key, started_at DESC).
 *
 * Lease semantics: one atomic INSERT ... SELECT ... WHERE NOT EXISTS
 * claims the lease only when no `running` row for the job started
 * within the staleness window. A `running` row older than
 * CRON_LEASE_STALE_MS is presumed crashed/stuck and no longer blocks
 * a new run (a tick should take seconds; 10 minutes is far past any
 * healthy tick). The lease is a plain row, not an advisory lock, so
 * it survives across store instances and Worker isolates.
 *
 * Missing table (42P01 — Worker C's migration not applied yet):
 * tryAcquire logs LOUDLY and returns true (fail-open: the cron runs
 * unguarded, exactly as today). It must never 500 the cron.
 * Direct drizzle queries only — the store's full-state load is never
 * involved.
 */
import { sql, type SQL } from "drizzle-orm";

/** Minimal shape of the drizzle DB handle the lease needs. */
export interface CronLeaseDb {
  execute: (query: SQL) => Promise<{
    rows?: unknown[];
    rowCount?: number | null;
  }>;
}

/** A `running` row older than this no longer blocks a new run. */
export const CRON_LEASE_STALE_MS = 10 * 60 * 1000;

/** Job keys used by handleScheduled (one lease per job per tick). */
export const CRON_JOB_OUTBOX_DRAIN = "outbox_drain";
export const CRON_JOB_RENEWAL_SWEEP = "renewal_sweep";

function isMissingTable(error: unknown): boolean {
  return (error as { code?: string })?.code === "42P01";
}

/**
 * Claim the lease for `jobKey`. Returns true when this caller owns
 * the run and may proceed; false when a previous run still holds a
 * live lease (caller must skip the job this tick).
 */
export async function tryAcquireCronLease(
  db: CronLeaseDb,
  jobKey: string
): Promise<boolean> {
  try {
    const res = await db.execute(
      sql`INSERT INTO scheduled_job_runs (job_key, status)
          SELECT ${jobKey}, 'running'
           WHERE NOT EXISTS (
             SELECT 1 FROM scheduled_job_runs
              WHERE job_key = ${jobKey}
                AND status = 'running'
                AND started_at > NOW() - (${CRON_LEASE_STALE_MS} * INTERVAL '1 millisecond')
           )
          RETURNING id`
    );
    const claimed =
      (res.rowCount ?? 0) > 0 || (res.rows?.length ?? 0) > 0;
    return claimed;
  } catch (error) {
    if (isMissingTable(error)) {
      // Worker C's migration has not landed yet — run unguarded (as
      // today) but say so loudly on every tick, never silently.
      console.error(
        `[stackmate-cron] CRON LEASE UNAVAILABLE: scheduled_job_runs table is missing ` +
          `— job '${jobKey}' ran WITHOUT an overlap guard. Apply the scheduled_job_runs migration.`
      );
      return true;
    }
    throw error;
  }
}

/**
 * Release the lease for `jobKey`, marking the latest `running` row
 * finished with the given summary (stored as jsonb). A no-op when no
 * running row exists (e.g. the lease was never acquired).
 */
export async function releaseCronLease(
  db: CronLeaseDb,
  jobKey: string,
  summary: unknown
): Promise<void> {
  try {
    await db.execute(
      sql`UPDATE scheduled_job_runs
             SET finished_at = NOW(),
                 status = 'completed',
                 summary = ${JSON.stringify(summary ?? null)}::jsonb
           WHERE id = (
             SELECT id FROM scheduled_job_runs
              WHERE job_key = ${jobKey} AND status = 'running'
              ORDER BY started_at DESC LIMIT 1
           )`
    );
  } catch (error) {
    if (isMissingTable(error)) {
      console.error(
        `[stackmate-cron] CRON LEASE RELEASE SKIPPED: scheduled_job_runs table is missing ` +
          `— job '${jobKey}' finished without releasing a lease.`
      );
      return;
    }
    throw error;
  }
}
