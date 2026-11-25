/**
 * Scheduled (cron) jobs — extracted from apps/api/src/app.ts
 * `handleScheduled` (Hono migration wiring step).
 *
 * The Worker `scheduled` handler is NOT an HTTP request, so it does not
 * go through the Hono app. This module owns the two cron jobs
 * (transactional outbox drain + renewal/expiry sweep with reminder
 * mail) as a plain function of `(store, env)` — the caller
 * (`createStackMateApp` in app.ts) resolves env + the request-scoped
 * store and closes the store in `finally`, exactly like the old
 * `handleScheduled` did. No behaviour is changed here, only the form:
 * the jobs moved out so app.ts can become composition-only (~200
 * lines) without losing the cron path.
 *
 * Jobs (in order — the sweep never blocks the drain):
 * 1. Outbox drain (`processTransactionalOutboxBatch`) with the real
 *    webhook transport (C-2: without it the dispatcher records
 *    "simulated", never "delivered"). Meta CAPI events stay simulated
 *    by design (Batch 4 builds the real Meta client).
 * 2. Renewal + expiry sweep (`runRenewalExpirySweep`, ADR-0009) with
 *    reminder mail via SMTP (B-15: SMTP settings loaded ONCE per tick).
 *
 * A-05 guard (cron lease, platform/cron-lease.ts): one lease per job
 * per tick — outbox_drain + renewal_sweep are independent jobs, so a
 * stuck drain never blocks the sweep and vice versa. A job whose lease
 * is still held by a previous tick is SKIPPED (logged), never run
 * twice. Each lease releases with a run summary in the inner finally,
 * BEFORE the caller closes the store's pg client (the release itself
 * needs the DB). No drizzleDb (in-memory/test store) → no lease, the
 * tick runs unguarded as today.
 */
import type { StackMateBindings } from "./env.ts";
import { StackMateDataStore } from "./platform/db/store.ts";
import {
  CRON_JOB_OUTBOX_DRAIN,
  CRON_JOB_RENEWAL_SWEEP,
  releaseCronLease,
  tryAcquireCronLease,
} from "./platform/cron-lease.ts";
import {
  createRealWebhookTransport,
  processTransactionalOutboxBatch,
} from "./modules/webhooks/service.ts";
import {
  markSweepRemindersSent,
  runRenewalExpirySweep,
} from "./modules/renewal/sweep.ts";
import {
  loadSmtpSettings,
  type ResolvedSmtpSettings,
} from "./modules/auth-config/service.ts";
import { type sendStackMateEmail } from "./modules/email/service.ts";
import { sendEmailViaSmtp } from "./shared/http.ts";

export interface ScheduledJobResult {
  claimed: number;
  delivered: number;
  // C-2/D-6: the dispatcher also counts simulated deliveries.
  simulated: number;
  // Q3: events with no subscribed active endpoint.
  skipped: number;
  retrying: number;
  dead_lettered: number;
}

/**
 * Run one cron tick: outbox drain, then renewal/expiry sweep with
 * reminder mail. Never throws for a job failure — a failed sweep or
 * reminder send is logged and retried on the next tick, and the drain
 * result is always returned (a skipped drain answers with the zeroed
 * report shape, never a different object). The caller owns the store
 * lifecycle (resolve before, close after).
 */
export async function runScheduledJobs(
  store: StackMateDataStore,
  env: StackMateBindings
): Promise<ScheduledJobResult> {
  const leaseDb = (store as unknown as { drizzleDb?: unknown }).drizzleDb as
    | Parameters<typeof tryAcquireCronLease>[0]
    | undefined;
  const acquireLease = async (jobKey: string): Promise<boolean> => {
    if (!leaseDb) return true;
    try {
      return await tryAcquireCronLease(leaseDb, jobKey);
    } catch (err) {
      // A lease-acquire DB failure must not kill the tick (the
      // 2026-11-16 uncaught-exception pattern) — log loudly and run
      // this job unguarded, as today.
      console.error(
        `[stackmate-cron] lease acquire failed for '${jobKey}' — running unguarded`,
        err instanceof Error ? err.message : "unknown error"
      );
      return true;
    }
  };
  const releaseLease = async (jobKey: string, summary: unknown): Promise<void> => {
    if (!leaseDb) return;
    await releaseCronLease(leaseDb, jobKey, summary).catch((err) => {
      console.error(
        `[stackmate-cron] failed to release '${jobKey}' lease`,
        err instanceof Error ? err.message : "unknown error"
      );
    });
  };

  // The await is LOAD-BEARING (cron bug 2026-11-16): `return
  // <pending promise>` runs the caller's finally block BEFORE the
  // promise settles, so without it the store close ends the store's pg
  // client while the drain is still running and the drain's first
  // BEGIN throws "Client was closed and is not queryable" — every
  // cron invocation errored (~1/min uncaught exceptions in the
  // Cloudflare metrics) and the outbox never drained on schedule.
  // C-2: the cron passes the real transport — without it the
  // dispatcher runs simulated and records "simulated" (never
  // "delivered"). Meta CAPI events stay simulated by design
  // (Batch 4 builds the real Meta client).
  let drainResult: Awaited<ReturnType<typeof processTransactionalOutboxBatch>> | null =
    null;
  if (await acquireLease(CRON_JOB_OUTBOX_DRAIN)) {
    try {
      drainResult = await processTransactionalOutboxBatch(store, {
        encryptionKey: env.ENCRYPTION_KEY_V1,
        allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
        transport: createRealWebhookTransport({
          allowHttpLocal: env.APP_ENV === "local" || env.APP_ENV === "test",
        }),
      });
    } finally {
      await releaseLease(CRON_JOB_OUTBOX_DRAIN, drainResult ?? { skipped: false });
    }
  } else {
    console.log(
      "[stackmate-cron] outbox drain skipped: previous tick still holds the lease"
    );
  }

  // Renewal + expiry sweep (ADR-0009): runs AFTER the drain, so a
  // sweep failure can never block outbox delivery. The sweep itself
  // never throws (its report carries per-item errors); the reminder
  // sends below are best-effort and a failed send is NOT marked
  // sent, so the next minute's run retries it (send-first-then-mark).
  if (await acquireLease(CRON_JOB_RENEWAL_SWEEP)) {
    let sweepSummary: Record<string, unknown> = { skipped: false };
    try {
      const sweep = await runRenewalExpirySweep(store, {
        licenseVerifierSecret: env.LICENSE_VERIFIER_SECRET,
        requestId: `cron:sweep:${new Date().toISOString()}`,
        timeZone: env.DEFAULT_TIMEZONE,
      });
      // B-15: load SMTP settings ONCE per tick (decrypt included)
      // and reuse for every reminder send, instead of one load +
      // decrypt per reminder. When SMTP is not configured the loop
      // is skipped outright — no per-reminder load at all. The
      // preloaded settings are threaded through sendEmailViaSmtp
      // (Worker B's optional param on sendStackMateEmail — not
      // landed yet, so the per-send load inside it still runs;
      // the tick-level gate + plumbing are in place).
      const smtpDb = (store as unknown as { drizzleDb?: unknown })
        .drizzleDb as Parameters<typeof sendStackMateEmail>[0] | undefined;
      let preloadedSmtp: ResolvedSmtpSettings | null = null;
      if (smtpDb) {
        preloadedSmtp = await loadSmtpSettings(smtpDb, {
          encryptionKey: env.ENCRYPTION_KEY_V1,
          keyVersion: env.ACTIVE_ENCRYPTION_KEY_VERSION,
        }).catch(() => null);
      }
      const smtpReady =
        preloadedSmtp !== null &&
        preloadedSmtp.enabled &&
        Boolean(preloadedSmtp.host) &&
        Boolean(preloadedSmtp.from_address);
      const sent: typeof sweep.reminders_due = [];
      if (sweep.reminders_due.length > 0 && !smtpReady) {
        console.log(
          "[stackmate-cron] SMTP not configured — skipping",
          sweep.reminders_due.length,
          "reminder(s) this tick"
        );
      }
      for (const reminder of sweep.reminders_due) {
        if (!smtpReady) break;
        const result = await sendEmailViaSmtp(
          store,
          env,
          {
            to: reminder.to_email,
            subject: reminder.subject,
            text: reminder.text,
          },
          preloadedSmtp
        );
        if (result.sent) sent.push(reminder);
      }
      if (sent.length > 0) await markSweepRemindersSent(store, sent);
      sweepSummary = {
        reminders_due: sweep.reminders_due.length,
        reminders_sent: sent.length,
      };
    } catch (err) {
      // Never fail the cron (and never mask the drain result) for
      // sweep or reminder-mail errors — the next run retries.
      // F-10: log the message only, never the raw error object.
      console.error(
        "[stackmate-cron] renewal sweep failed",
        err instanceof Error ? err.message : "unknown error"
      );
      sweepSummary = {
        sweep_error: err instanceof Error ? err.message : "unknown error",
      };
    } finally {
      await releaseLease(CRON_JOB_RENEWAL_SWEEP, sweepSummary);
    }
  } else {
    console.log(
      "[stackmate-cron] renewal sweep skipped: previous tick still holds the lease"
    );
  }

  // The scheduled return type is the drain report — a skipped drain
  // answers with the zeroed report shape, never a different object.
  return (
    drainResult ?? {
      claimed: 0,
      delivered: 0,
      simulated: 0,
      skipped: 0,
      retrying: 0,
      dead_lettered: 0,
    }
  );
}
