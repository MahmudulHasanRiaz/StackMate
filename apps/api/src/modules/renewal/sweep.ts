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
  StackMateDataStore,
  SentReminderKind,
} from "../../platform/db/store.ts";
import {
  evaluateActivationForOrderInTx,
  evaluateSuspensionForOrderInTx,
  expireLicenseInTx,
  suspendLicensesForSubscriptionInTx,
} from "../activation/service.ts";
import { appendAuditLog } from "../audit/service.ts";
import { computeOrderRemaining } from "../customers/service.ts";
import {
  getReminderSettings,
  hasSentReminder,
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
  errors: string[];
}

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

function customerEmail(state: DatabaseState, customerId: string): string | null {
  const customer = state.customers.find((c) => c.id === customerId);
  return customer?.email?.trim() ? customer.email.trim() : null;
}

function reminderFor(
  state: DatabaseState,
  kind: SentReminderKind,
  referenceId: string,
  offsetDays: number,
  customerId: string,
  subject: string,
  text: string
): SweepReminder | null {
  if (hasSentReminder(state, kind, referenceId, offsetDays)) return null;
  const to = customerEmail(state, customerId);
  if (!to) return null;
  return { kind, reference_id: referenceId, offset_days: offsetDays, to_email: to, subject, text };
}

/** Plan + apply the whole sweep inside one transaction; returns the report. */
export function planSweepInTx(
  state: DatabaseState,
  now: Date,
  licenseVerifierSecret: string,
  requestId: string
): SweepReport {
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
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
    errors: [],
  };
  const fail = (step: string, err: unknown) => {
    report.errors.push(`${step}: ${err instanceof Error ? err.message : String(err)}`);
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
        { actorUserId: null, requestId }
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

  // (f) Reminders.
  for (const inst of state.order_installments) {
    if (inst.paid_amount_minor >= inst.amount_minor) continue;
    const order = state.orders.find((o) => o.id === inst.order_id);
    if (!order || order.status === "cancelled") continue;
    const remaining = inst.amount_minor - inst.paid_amount_minor;
    try {
      if (inst.due_date >= today) {
        // Due reminders: today == due_date - offset.
        for (const offset of settings.due_offsets_days) {
          if (daysBetween(today, inst.due_date) === offset) {
            const r = reminderFor(
              state,
              "installment_due",
              inst.id,
              offset,
              order.customer_id,
              `Payment due ${offset === 0 ? "today" : `in ${offset} day${offset === 1 ? "" : "s"}`} — Order ${order.order_number}`,
              `Hi,\n\nA payment of ${formatMinorBDT(remaining)} for order ${order.order_number} (installment #${inst.installment_number}) is due on ${inst.due_date}.\n\nTotal order: ${formatMinorBDT(order.total_minor)} · Paid so far: ${formatMinorBDT(order.total_minor - computeOrderRemaining(state, order))}.\n\n— StackMate`
            );
            if (r) report.reminders_due.push(r);
            else if (!hasSentReminder(state, "installment_due", inst.id, offset) && !customerEmail(state, order.customer_id)) report.reminders_skipped_no_email += 1;
          }
        }
      } else if (settings.overdue_enabled) {
        // Overdue reminders: today == due_date + offset.
        for (const offset of settings.overdue_offsets_days) {
          if (daysBetween(inst.due_date, today) === offset) {
            const r = reminderFor(
              state,
              "installment_overdue",
              inst.id,
              offset,
              order.customer_id,
              `Payment overdue — Order ${order.order_number}`,
              `Hi,\n\nA payment of ${formatMinorBDT(remaining)} for order ${order.order_number} (installment #${inst.installment_number}) was due on ${inst.due_date} and is now ${offset} day${offset === 1 ? "" : "s"} overdue. Please pay at your earliest convenience.\n\n— StackMate`
            );
            if (r) report.reminders_due.push(r);
            else if (!hasSentReminder(state, "installment_overdue", inst.id, offset) && !customerEmail(state, order.customer_id)) report.reminders_skipped_no_email += 1;
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
            state,
            "subscription_renewal",
            sub.id,
            offset,
            sub.customer_id,
            `Renewal due ${offset === 0 ? "today" : `in ${offset} day${offset === 1 ? "" : "s"}`} — Subscription ${sub.subscription_number}`,
            `Hi,\n\nYour subscription ${sub.subscription_number} renews on ${periodEnd}. Your renewal invoice is ready — please pay before the renewal date to keep your license active without interruption.\n\n— StackMate`
          );
          if (r) report.reminders_due.push(r);
          else if (!hasSentReminder(state, "subscription_renewal", sub.id, offset) && !customerEmail(state, sub.customer_id)) report.reminders_skipped_no_email += 1;
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
  options: { now?: Date; licenseVerifierSecret: string; requestId?: string }
): Promise<SweepReport> {
  const now = options.now ?? new Date();
  const requestId = options.requestId ?? `cron:sweep:${now.toISOString()}`;
  try {
    return await store.withTransaction((state) =>
      planSweepInTx(state, now, options.licenseVerifierSecret, requestId)
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
