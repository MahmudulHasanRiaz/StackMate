/**
 * Renewal + expiry automation (ADR-0009, PRD §12/§13).
 *
 * Runs from the Worker's every-minute cron (handleScheduled), AFTER the
 * outbox drain, and never fails the drain: the sweep catches per-item
 * errors, records them in the report, and continues; a sweep failure is
 * logged, never thrown.
 *
 * One run does, in a single serialized transaction:
 * (a) date-based license activation (§4 on_date orders);
 * (b) missed-schedule suspension / catch-up reactivation (§4);
 * (c) installments past due → status "overdue";
 * (d) renewal detection: recurring subscriptions whose current_period_end
 *     is within the first reminder offset get a renewal invoice/order via
 *     the existing renewal logic (idempotent — never duplicated);
 * (e) subscriptions past current_period_end: active → past_due inside the
 *     grace window, → expired after it (licenses suspended at that moment,
 *     until renewal payment verifies); licenses past grace_until → expired;
 * (f) reminders per the Settings → Email rules (due + overdue offsets).
 *
 * Reminder emails are NOT sent inside the transaction: the sweep returns
 * the due reminders; the caller (app.ts cron handler) sends them via the
 * email service and then marks them sent (markSweepRemindersSent) so a
 * failed send is retried on the next run instead of silently lost.
 */
import { randomUUID } from "node:crypto";
import type {
  DatabaseState,
  OrderRecord,
  StackMateDataStore,
  SentReminderKind,
} from "../../platform/db/store.ts";
import {
  businessTodayIso,
  evaluateActivationForOrderInTx,
  evaluateSuspensionForOrderInTx,
  expireLicenseInTx,
  suspendLicensesForSubscriptionInTx,
} from "../activation/service.ts";
import { appendAuditLog } from "../audit/service.ts";
import {
  getReminderSettings,
  markReminderSentInTx,
} from "../reminders/service.ts";
import { generateRenewalInvoiceInTx } from "../subscriptions/service.ts";

export interface SweepReminder {
  kind: SentReminderKind;
  reference_id: string;
  offset_days: number;
  to_email: string;
  subject: string;
  text: string;
}

export interface SweepReport {
  run_id: string;
  ran_at: string;
  activations: number;
  suspensions: number;
  reactivations: number;
  renewals: number;
  subscriptions_expired: number;
  subscriptions_past_due: number;
  licenses_expired: number;
  installments_marked_overdue: number;
  reminders_due: SweepReminder[];
  reminders_skipped_no_email: number;
  /**
   * A-05: reminders are capped per run (SWEEP_REMINDERS_PER_RUN_CAP).
   * Reminders past the cap are NOT planned this run — they are
   * counted here and picked up by the next minute's run.
   */
  reminders_capped: number;
  errors: string[];
}

/** A-05: at most this many reminders are planned (and sent) per run. */
export const SWEEP_REMINDERS_PER_RUN_CAP = 25;

export function formatMinorBDT(minor: number): string {
  return `৳${(minor / 100).toLocaleString("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  const from = new Date(`${fromIsoDate}T00:00:00.000Z`).getTime();
  const to = new Date(`${toIsoDate}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / 86400000);
}

function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * B-03: per-tick indexes, built ONCE per sweep instead of `.find`
 * per row. The old code did `state.customers.find(...)` per reminder
 * candidate and `state.orders.find(...)` per installment, and
 * `hasSentReminder` scanned all of `sent_reminders` per candidate —
 * O(n·m) in JS every minute. The maps/set below make every lookup
 * O(1); the reminder loops then iterate only pre-filtered due rows.
 */
export interface SweepIndexes {
  customersById: Map<string, string>;
  ordersById: Map<string, OrderRecord>;
  paidByOrderId: Map<string, number>;
  sentReminderKeys: Set<string>;
}

function buildSweepIndexes(state: DatabaseState): SweepIndexes {
  const customersById = new Map<string, string>();
  for (const c of state.customers) {
    if (c.email?.trim()) customersById.set(c.id, c.email.trim());
  }
  const ordersById = new Map(state.orders.map((o) => [o.id, o]));
  const paidByOrderId = new Map<string, number>();
  for (const inst of state.order_installments) {
    paidByOrderId.set(
      inst.order_id,
      (paidByOrderId.get(inst.order_id) ?? 0) + inst.paid_amount_minor
    );
  }
  const sentReminderKeys = new Set(
    state.sent_reminders.map(
      (r) => `${r.kind}:${r.reference_id}:${r.offset_days}`
    )
  );
  return { customersById, ordersById, paidByOrderId, sentReminderKeys };
}

function customerEmailFromIndex(
  customersById: Map<string, string>,
  customerId: string
): string | null {
  return customersById.get(customerId) ?? null;
}

function reminderFor(
  indexes: {
    customersById: Map<string, string>;
    sentReminderKeys: Set<string>;
  },
  kind: SentReminderKind,
  referenceId: string,
  offsetDays: number,
  customerId: string,
  subject: string,
  text: string
): SweepReminder | null {
  if (indexes.sentReminderKeys.has(`${kind}:${referenceId}:${offsetDays}`)) {
    return null;
  }
  const to = customerEmailFromIndex(indexes.customersById, customerId);
  if (!to) return null;
  return { kind, reference_id: referenceId, offset_days: offsetDays, to_email: to, subject, text };
}

/** Plan + apply the whole sweep inside one transaction; returns the report. */
export function planSweepInTx(
  state: DatabaseState,
  now: Date,
  licenseVerifierSecret: string,
  requestId: string,
  /**
   * F-12: business timezone for every date-only boundary in the sweep
   * (activation dates, installment due dates, reminder offsets).
   * Defaults to Asia/Dhaka (the env default). Instants (created_at,
   * grace_until comparisons) stay UTC — only the `today` boundary
   * moves: at 01:00 Dhaka the UTC date is still yesterday, so a
   * UTC `today` would activate/suspend a day late.
   */
  timeZone = "Asia/Dhaka"
): SweepReport {
  const nowIso = now.toISOString();
  const today = businessTodayIso(now, timeZone);
  const settings = getReminderSettings(state);
  const report: SweepReport = {
    run_id: randomUUID(),
    ran_at: nowIso,
    activations: 0,
    suspensions: 0,
    reactivations: 0,
    renewals: 0,
    subscriptions_expired: 0,
    subscriptions_past_due: 0,
    licenses_expired: 0,
    installments_marked_overdue: 0,
    reminders_due: [],
    reminders_skipped_no_email: 0,
    reminders_capped: 0,
    errors: [],
  };
  const fail = (step: string, err: unknown) => {
    report.errors.push(`${step}: ${err instanceof Error ? err.message : String(err)}`);
  };

  // B-03: indexes built ONCE per tick; every lookup below is O(1).
  const indexes = buildSweepIndexes(state);
  // A-05: cap helper — past the cap the reminder is counted, not
  // planned; the next minute's run picks it up (it was never marked
  // sent, so nothing is lost).
  const planReminder = (r: SweepReminder | null): void => {
    if (!r) return;
    if (report.reminders_due.length >= SWEEP_REMINDERS_PER_RUN_CAP) {
      report.reminders_capped += 1;
      return;
    }
    report.reminders_due.push(r);
  };

  // (c) Installments past due → overdue (before reminders, so the overdue
  // reminder step sees the fresh status).
  for (const inst of state.order_installments) {
    if (
      (inst.status === "pending" || inst.status === "partially_paid") &&
      inst.due_date < today
    ) {
      try {
        inst.status = "overdue";
        inst.updated_at = nowIso;
        report.installments_marked_overdue += 1;
      } catch (err) {
        fail(`installment-overdue:${inst.id}`, err);
      }
    }
  }

  // (a) Date-based activation + (b) missed-schedule suspension, per order.
  for (const order of state.orders) {
    if (order.status === "cancelled") continue;
    try {
      const outcome = evaluateActivationForOrderInTx(state, order, nowIso, {
        licenseVerifierSecret,
        actorUserId: null,
        requestId,
        timeZone,
      });
      report.activations += outcome.newly_issued;
    } catch (err) {
      fail(`activation:${order.order_number}`, err);
    }
    try {
      const { suspended, reactivated } = evaluateSuspensionForOrderInTx(
        state,
        order,
        now,
        { actorUserId: null, requestId, timeZone }
      );
      report.suspensions += suspended.length;
      report.reactivations += reactivated.length;
    } catch (err) {
      fail(`suspension:${order.order_number}`, err);
    }
  }

  // (d) Renewal detection + (e) subscription lifecycle.
  const firstDueOffset = Math.max(...settings.due_offsets_days, 0);
  for (const sub of state.subscriptions) {
    if (sub.status === "cancelled" || sub.billing_kind !== "recurring") continue;
    const periodEnd = sub.current_period_end ? sub.current_period_end.slice(0, 10) : null;
    if (!periodEnd) continue;
    const graceEnd = addDays(periodEnd, sub.grace_days ?? 3);
    try {
      if (sub.status === "active") {
        // Renewal invoice when the period end is within the first offset.
        const daysUntilEnd = daysBetween(today, periodEnd);
        if (daysUntilEnd <= firstDueOffset) {
          const hadPending = sub.periods.some((p) => p.status === "pending");
          generateRenewalInvoiceInTx(state, sub, null, requestId);
          if (!hadPending) report.renewals += 1;
        }
        // Inside the grace window → past_due (license keeps working).
        if (today > periodEnd && today <= graceEnd) {
          sub.status = "past_due";
          sub.updated_at = nowIso;
          report.subscriptions_past_due += 1;
          appendAuditLog(state, {
            actor_type: "system",
            actor_user_id: null,
            action: "subscriptions.subscription.past_due",
            resource_type: "subscription",
            resource_id: sub.id,
            outcome: "success",
            request_id: requestId,
            changes: { from_status: "active", to_status: "past_due", grace_days: sub.grace_days ?? 3 },
          });
        }
      }
      // Grace exhausted → expired + suspend its licenses until renewal.
      if ((sub.status === "active" || sub.status === "past_due") && today > graceEnd) {
        const prev = sub.status;
        sub.status = "expired";
        sub.updated_at = nowIso;
        report.subscriptions_expired += 1;
        appendAuditLog(state, {
          actor_type: "system",
          actor_user_id: null,
          action: "subscriptions.subscription.expired",
          resource_type: "subscription",
          resource_id: sub.id,
          outcome: "success",
          request_id: requestId,
          changes: { from_status: prev, to_status: "expired" },
        });
        const suspended = suspendLicensesForSubscriptionInTx(
          state,
          sub.id,
          "subscription_expired_grace_exhausted",
          nowIso,
          { actorUserId: null, requestId }
        );
        report.suspensions += suspended.length;
      }
    } catch (err) {
      fail(`subscription:${sub.subscription_number}`, err);
    }
  }

  // (e, continued) Licenses past grace_until → expired.
  for (const license of state.licenses) {
    if (
      (license.status === "active" || license.status === "suspended") &&
      license.grace_until &&
      nowIso > license.grace_until
    ) {
      try {
        expireLicenseInTx(state, license, "grace_until_passed", nowIso, requestId);
        report.licenses_expired += 1;
      } catch (err) {
        fail(`license-expire:${license.license_number}`, err);
      }
    }
  }

  // (f) Reminders — single pass over unpaid installments; the order
  // lookup is O(1) via the per-tick index (was state.orders.find per
  // installment) and the paid-so-far figure comes from the pre-built
  // paidByOrderId map (was computeOrderRemaining's full scan).
  for (const inst of state.order_installments) {
    if (inst.paid_amount_minor >= inst.amount_minor) continue;
    const order = indexes.ordersById.get(inst.order_id);
    if (!order || order.status === "cancelled") continue;
    const remaining = inst.amount_minor - inst.paid_amount_minor;
    try {
      if (inst.due_date >= today) {
        // Due reminders: today == due_date - offset.
        for (const offset of settings.due_offsets_days) {
          if (daysBetween(today, inst.due_date) === offset) {
            const r = reminderFor(
              indexes,
              "installment_due",
              inst.id,
              offset,
              order.customer_id,
              `Payment due ${offset === 0 ? "today" : `in ${offset} day${offset === 1 ? "" : "s"}`} — Order ${order.order_number}`,
              `Hi,\n\nA payment of ${formatMinorBDT(remaining)} for order ${order.order_number} (installment #${inst.installment_number}) is due on ${inst.due_date}.\n\nTotal order: ${formatMinorBDT(order.total_minor)} · Paid so far: ${formatMinorBDT(indexes.paidByOrderId.get(order.id) ?? 0)}.\n\n— StackMate`
            );
            if (r) planReminder(r);
            else if (!indexes.sentReminderKeys.has(`installment_due:${inst.id}:${offset}`) && !indexes.customersById.has(order.customer_id)) report.reminders_skipped_no_email += 1;
          }
        }
      } else if (settings.overdue_enabled) {
        // Overdue reminders: today == due_date + offset.
        for (const offset of settings.overdue_offsets_days) {
          if (daysBetween(inst.due_date, today) === offset) {
            const r = reminderFor(
              indexes,
              "installment_overdue",
              inst.id,
              offset,
              order.customer_id,
              `Payment overdue — Order ${order.order_number}`,
              `Hi,\n\nA payment of ${formatMinorBDT(remaining)} for order ${order.order_number} (installment #${inst.installment_number}) was due on ${inst.due_date} and is now ${offset} day${offset === 1 ? "" : "s"} overdue. Please pay at your earliest convenience.\n\n— StackMate`
            );
            if (r) planReminder(r);
            else if (!indexes.sentReminderKeys.has(`installment_overdue:${inst.id}:${offset}`) && !indexes.customersById.has(order.customer_id)) report.reminders_skipped_no_email += 1;
          }
        }
      }
    } catch (err) {
      fail(`reminder-installment:${inst.id}`, err);
    }
  }

  for (const sub of state.subscriptions) {
    if (sub.status !== "active" || sub.billing_kind !== "recurring") continue;
    const periodEnd = sub.current_period_end ? sub.current_period_end.slice(0, 10) : null;
    if (!periodEnd) continue;
    try {
      for (const offset of settings.due_offsets_days) {
        if (daysBetween(today, periodEnd) === offset) {
          const r = reminderFor(
            indexes,
            "subscription_renewal",
            sub.id,
            offset,
            sub.customer_id,
            `Renewal due ${offset === 0 ? "today" : `in ${offset} day${offset === 1 ? "" : "s"}`} — Subscription ${sub.subscription_number}`,
            `Hi,\n\nYour subscription ${sub.subscription_number} renews on ${periodEnd}. Your renewal invoice is ready — please pay before the renewal date to keep your license active without interruption.\n\n— StackMate`
          );
          if (r) planReminder(r);
          else if (!indexes.sentReminderKeys.has(`subscription_renewal:${sub.id}:${offset}`) && !indexes.customersById.has(sub.customer_id)) report.reminders_skipped_no_email += 1;
        }
      }
    } catch (err) {
      fail(`reminder-subscription:${sub.id}`, err);
    }
  }

  return report;
}

/** Run the sweep in one transaction; never throws (errors land in the report). */
export async function runRenewalExpirySweep(
  store: StackMateDataStore,
  options: {
    now?: Date;
    licenseVerifierSecret: string;
    requestId?: string;
    /** Business timezone for date-only boundaries (F-12). Defaults to Asia/Dhaka. */
    timeZone?: string | undefined;
  }
): Promise<SweepReport> {
  const now = options.now ?? new Date();
  const requestId = options.requestId ?? `cron:sweep:${now.toISOString()}`;
  try {
    return await store.withTransaction((state) =>
      planSweepInTx(
        state,
        now,
        options.licenseVerifierSecret,
        requestId,
        options.timeZone ?? "Asia/Dhaka"
      )
    );
  } catch (err) {
    // The transaction itself failed — return an empty report carrying the error.
    return {
      run_id: randomUUID(),
      ran_at: now.toISOString(),
      activations: 0,
      suspensions: 0,
      reactivations: 0,
      renewals: 0,
      subscriptions_expired: 0,
      subscriptions_past_due: 0,
      licenses_expired: 0,
      installments_marked_overdue: 0,
      reminders_due: [],
      reminders_skipped_no_email: 0,
      reminders_capped: 0,
      errors: [`sweep-transaction: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/** Mark reminders sent (after the caller emailed them). One transaction. */
export async function markSweepRemindersSent(
  store: StackMateDataStore,
  reminders: SweepReminder[],
  now: Date = new Date()
): Promise<void> {
  if (reminders.length === 0) return;
  const nowIso = now.toISOString();
  await store.withTransaction((state) => {
    for (const r of reminders) {
      markReminderSentInTx(state, r.kind, r.reference_id, r.offset_days, nowIso);
    }
  });
}
