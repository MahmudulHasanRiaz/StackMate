/**
 * License activation policy (ADR-0009, PRD §12/§13).
 *
 * Per-order activation modes:
 * - on_full_payment → activate when paid >= total.
 * - on_percent → activate when paid >= percent of total.
 * - on_date → activate on that date regardless of payment.
 * - suspend_on_missed_schedule → while the license is active, a scheduled
 *   installment passing its due date unpaid suspends the license until the
 *   installment is paid (then auto-reactivates). Manual staff suspensions
 *   are never auto-reactivated — only missed-schedule ones are.
 *
 * Every activation / suspension / reactivation / expiry writes a
 * license_event row, an outbox event (license.activated / license.suspended
 * / license.reactivated / license.expired — delivered to integrated sites
 * through the existing webhook/outbox path), and an audit log entry.
 * All functions are idempotent: re-running them on an already-fulfilled,
 * already-suspended, or already-reactivated order is a no-op.
 */
import { randomUUID } from "node:crypto";
import {
  formatDisplayDateDDMMYYYY,
  parseStrictDDMMYYYYToIsoDate,
} from "../../../../../packages/contracts/src/index.ts";
import type {
  DatabaseState,
  LicenseRecord,
  OrderRecord,
  SubscriptionRecord,
} from "../../platform/db/store.ts";
import { appendAuditLog } from "../audit/service.ts";
import { computeOrderPaid } from "../customers/service.ts";
import {
  issueLicenseForOrderItemInTx,
  recordLicenseEventInTx,
} from "../licensing/service.ts";
import { createOrExtendSubscriptionInTx } from "../subscriptions/service.ts";

export interface ActivationOutcome {
  activated: boolean;
  reason: string;
  /** Licenses actually created by this call (0 on a re-run). */
  newly_issued: number;
  subscriptions: SubscriptionRecord[];
  issued_licenses: Array<{ license: LicenseRecord; issued_license_key_once: string }>;
}

export interface ActivationConfig {
  licenseVerifierSecret: string;
  /** Payment transaction id to link new subscriptions to (approval path). */
  paymentTransactionId?: string | null;
  actorUserId?: string | null;
  requestId: string;
  /**
   * Business timezone for date-only boundaries (F-12). The business
   * runs on Asia/Dhaka; callers should pass `env.DEFAULT_TIMEZONE`.
   * Defaults to Asia/Dhaka (the env default) when omitted.
   */
  timeZone?: string | undefined;
}

/**
 * Today as an ISO date-only string in the BUSINESS timezone (F-12).
 * Date-only values (activation_date, installment due_date) are business
 * dates: at 01:00 Dhaka the UTC date is still yesterday, so
 * `now.toISOString().slice(0, 10)` would activate/suspend a day late.
 * Composed from the shared strict parsers (AGENTS.md §7) — no native
 * Date.parse on ambiguous strings.
 */
export function businessTodayIso(now: Date, timeZone = "Asia/Dhaka"): string {
  return parseStrictDDMMYYYYToIsoDate(formatDisplayDateDDMMYYYY(now, timeZone));
}

/** Pure policy evaluation: is this order due for activation right now? */
export function activationDueNow(
  order: OrderRecord,
  paidMinor: number,
  now: Date,
  timeZone = "Asia/Dhaka"
): { due: boolean; reason: string } {
  if (order.activation_mode === "on_full_payment") {
    return {
      due: paidMinor >= order.total_minor,
      reason:
        paidMinor >= order.total_minor
          ? `on_full_payment: paid ${paidMinor} of ${order.total_minor}`
          : `on_full_payment: paid ${paidMinor} of ${order.total_minor} — not yet fully paid`,
    };
  }
  if (order.activation_mode === "on_percent") {
    const percent = order.activation_percent ?? 100;
    const threshold = Math.ceil((order.total_minor * percent) / 100);
    return {
      due: paidMinor >= threshold,
      reason:
        paidMinor >= threshold
          ? `on_percent ${percent}%: paid ${paidMinor} of ${order.total_minor} (threshold ${threshold})`
          : `on_percent ${percent}%: paid ${paidMinor} of ${order.total_minor} (threshold ${threshold})`,
    };
  }
  // on_date — activate on that date regardless of payment.
  const date = order.activation_date;
  if (!date) {
    return { due: false, reason: "on_date: no activation date set" };
  }
  // F-12: compare against TODAY IN THE BUSINESS TIMEZONE, not UTC.
  const today = businessTodayIso(now, timeZone);
  return {
    due: today >= date,
    reason: today >= date ? `on_date: ${date} reached` : `on_date: ${date} not yet reached`,
  };
}

/** Fulfillment for one order's items (extracted from the approval flow). */
export function fulfillOrderItemsInTx(
  state: DatabaseState,
  order: OrderRecord,
  nowIso: string,
  licenseVerifierSecret: string,
  paymentTransactionId?: string | null
): {
  subscriptions: SubscriptionRecord[];
  issued_licenses: Array<{ license: LicenseRecord; issued_license_key_once: string }>;
  /** Licenses actually created by this call (not pre-existing ones). */
  newly_issued_licenses: LicenseRecord[];
} {
  const subscriptions: SubscriptionRecord[] = [];
  const issued_licenses: Array<{ license: LicenseRecord; issued_license_key_once: string }> = [];
  const preExistingLicenseIds = new Set(state.licenses.map((l) => l.id));

  for (const item of order.items) {
    if (item.fulfillment_type_snapshot === "digital_service") {
      // ADR-0003: Service order does not issue a software license.
      // Idempotent: never queue the same fulfillment intent twice.
      const alreadyQueued = state.outbox_events.some(
        (e) => e.event_key === `service_fulfillment.queued:${item.id}`
      );
      if (!alreadyQueued) {
        state.outbox_events.push({
          id: randomUUID(),
          event_key: `service_fulfillment.queued:${item.id}`,
          aggregate_type: "order_item",
          aggregate_id: item.id,
          event_type: "service.fulfillment_requested",
          payload: {
            order_id: order.id,
            order_item_id: item.id,
            product_id: item.product_id,
          },
          status: "pending",
          attempt_count: 0,
          available_at: nowIso,
          locked_until: null,
          locked_by: null,
          last_error_code: null,
          created_at: nowIso,
          processed_at: null,
        });
      }
      continue;
    }

    // createOrExtend is NOT idempotent for fresh orders — skip items that
    // already have a subscription (issueLicense already is idempotent).
    const existingSub = state.subscriptions.find(
      (s) => s.source_order_item_id === item.id
    );
    const sub =
      existingSub ??
      createOrExtendSubscriptionInTx(state, order, item, paymentTransactionId ?? null);
    subscriptions.push(sub);

    // Renewal guard (pre-existing gap in the old approval flow): a renewal
    // order's item is a CLONE with a fresh id, so issueLicense's own
    // source_order_item_id guard misses and it would mint a DUPLICATE
    // license. A license already linked to this subscription is reused —
    // unless it was revoked, in which case a fresh one is issued.
    const linkedLicense = state.licenses.find(
      (l) => l.subscription_id === sub.id && l.status !== "revoked"
    );
    if (linkedLicense) {
      issued_licenses.push({
        license: linkedLicense,
        issued_license_key_once:
          linkedLicense.issued_raw_key_once ?? linkedLicense.license_key_hint,
      });
      continue;
    }

    const { license, rawKeyOnce } = issueLicenseForOrderItemInTx(
      state,
      order,
      item,
      sub,
      licenseVerifierSecret
    );
    issued_licenses.push({ license, issued_license_key_once: rawKeyOnce });
  }
  return {
    subscriptions,
    issued_licenses,
    newly_issued_licenses: issued_licenses
      .map((x) => x.license)
      .filter((l) => !preExistingLicenseIds.has(l.id)),
  };
}

function pushLicenseOutboxEvent(
  state: DatabaseState,
  license: LicenseRecord,
  eventType: "license.activated" | "license.suspended" | "license.reactivated" | "license.expired",
  reason: string,
  nowIso: string,
  /**
   * F-06: the outbox key is deterministic — the license_events row id
   * this outbox event describes. The same license event never queues
   * twice (a re-run finds the existing event row and skips), so the
   * unique `event_key` can never collide or defeat dedup the way
   * `Date.now()` did.
   */
  licenseEventId: string
): void {
  const product = state.products.find((p) => p.id === license.product_id);
  state.outbox_events.push({
    id: randomUUID(),
    event_key: `${eventType}:${license.id}:${licenseEventId}`,
    aggregate_type: "license",
    aggregate_id: license.id,
    event_type: eventType,
    payload: {
      license_number: license.license_number,
      product: product ? { id: product.id, name: product.name } : { id: license.product_id },
      status: license.status,
      expires_at: license.expires_at,
      grace_until: license.grace_until,
      reason,
    },
    status: "pending",
    attempt_count: 0,
    available_at: nowIso,
    locked_until: null,
    locked_by: null,
    last_error_code: null,
    created_at: nowIso,
    processed_at: null,
  });
}

function auditLicenseTransition(
  state: DatabaseState,
  license: LicenseRecord,
  action: string,
  actorType: "staff" | "system",
  actorUserId: string | null,
  requestId: string,
  changes: Record<string, unknown>
): void {
  appendAuditLog(state, {
    actor_type: actorType,
    actor_user_id: actorUserId,
    action,
    resource_type: "license",
    resource_id: license.id,
    outcome: "success",
    request_id: requestId,
    changes,
  });
}

/**
 * Evaluate the activation policy for an order and fulfill when due.
 * Idempotent: when every item already has its subscription + license, the
 * fulfillment loop returns the existing rows and no duplicate outbox or
 * license_event rows are written (the activated event fires only for
 * licenses that transition to active in this call).
 */
export function evaluateActivationForOrderInTx(
  state: DatabaseState,
  order: OrderRecord,
  nowIso: string,
  config: ActivationConfig
): ActivationOutcome {
  const paid = computeOrderPaid(state, order.id);
  const { due, reason } = activationDueNow(
    order,
    paid,
    new Date(nowIso),
    config.timeZone ?? "Asia/Dhaka"
  );
  if (!due) {
    return { activated: false, reason, newly_issued: 0, subscriptions: [], issued_licenses: [] };
  }

  // Which items still need fulfillment? An item is fulfilled when a license
  // already exists for it.
  const pendingItems = order.items.filter(
    (item) =>
      item.fulfillment_type_snapshot !== "digital_service" &&
      !state.licenses.some((l) => l.source_order_item_id === item.id)
  );
  const { subscriptions, issued_licenses, newly_issued_licenses } = fulfillOrderItemsInTx(
    state,
    order,
    nowIso,
    config.licenseVerifierSecret,
    config.paymentTransactionId ?? null
  );

  // Activation events fire only for licenses created by this call — never
  // for pre-existing ones (re-running evaluation must not duplicate them).
  if (pendingItems.length > 0) {
    for (const license of newly_issued_licenses) {
      if (license.status === "active") {
        const eventRow = recordLicenseEventInTx(state, license, "activated", "system", config.actorUserId ?? null, {
          reason,
          order_id: order.id,
          activation_mode: order.activation_mode,
        }, nowIso);
        pushLicenseOutboxEvent(state, license, "license.activated", reason, nowIso, eventRow.id);
        auditLicenseTransition(
          state,
          license,
          "licenses.license.activated",
          "system",
          config.actorUserId ?? null,
          config.requestId,
          { order_id: order.id, reason }
        );
      }
    }
  }
  return { activated: true, reason, newly_issued: newly_issued_licenses.length, subscriptions, issued_licenses };
}

/** Licenses of this order currently in "active" status. */
export function activeLicensesForOrder(state: DatabaseState, orderId: string): LicenseRecord[] {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return [];
  const itemIds = new Set(order.items.map((i) => i.id));
  return state.licenses.filter(
    (l) => l.source_order_item_id !== null && itemIds.has(l.source_order_item_id) && l.status === "active"
  );
}

/** Suspended licenses of this order whose last suspension was missed-schedule. */
function missedScheduleSuspendedLicenses(
  state: DatabaseState,
  orderId: string
): LicenseRecord[] {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return [];
  const itemIds = new Set(order.items.map((i) => i.id));
  return state.licenses.filter((l) => {
    if (l.source_order_item_id === null || !itemIds.has(l.source_order_item_id)) return false;
    if (l.status !== "suspended") return false;
    const events = state.license_events
      .filter((e) => e.license_id === l.id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const latest = events[0];
    return (
      latest?.event_type === "suspended" &&
      (latest.metadata as Record<string, unknown> | null)?.reason === "missed_schedule"
    );
  });
}

/** Suspend ONE license (shared by the per-order and per-subscription paths). */
export function suspendLicenseInTx(
  state: DatabaseState,
  license: LicenseRecord,
  reason: string,
  nowIso: string,
  config: { actorUserId?: string | null; requestId: string },
  extraMetadata: Record<string, unknown> = {}
): boolean {
  if (license.status !== "active") return false;
  license.status = "suspended";
  license.updated_at = nowIso;
  const eventRow = recordLicenseEventInTx(state, license, "suspended", "system", config.actorUserId ?? null, {
    reason,
    ...extraMetadata,
  }, nowIso);
  pushLicenseOutboxEvent(state, license, "license.suspended", reason, nowIso, eventRow.id);
  auditLicenseTransition(
    state,
    license,
    "licenses.license.suspended",
    "system",
    config.actorUserId ?? null,
    config.requestId,
    { reason, ...extraMetadata }
  );
  return true;
}

export function suspendLicensesForOrderInTx(
  state: DatabaseState,
  order: OrderRecord,
  reason: string,
  nowIso: string,
  config: { actorUserId?: string | null; requestId: string }
): LicenseRecord[] {
  const suspended: LicenseRecord[] = [];
  for (const license of activeLicensesForOrder(state, order.id)) {
    if (suspendLicenseInTx(state, license, reason, nowIso, config, { order_id: order.id })) {
      suspended.push(license);
    }
  }
  return suspended;
}

/** Suspend the active licenses linked to one subscription (renewal grace). */
export function suspendLicensesForSubscriptionInTx(
  state: DatabaseState,
  subscriptionId: string,
  reason: string,
  nowIso: string,
  config: { actorUserId?: string | null; requestId: string }
): LicenseRecord[] {
  const suspended: LicenseRecord[] = [];
  for (const license of state.licenses) {
    if (license.subscription_id === subscriptionId && license.status === "active") {
      if (suspendLicenseInTx(state, license, reason, nowIso, config)) {
        suspended.push(license);
      }
    }
  }
  return suspended;
}

export function reactivateLicensesForOrderInTx(
  state: DatabaseState,
  order: OrderRecord,
  reason: string,
  nowIso: string,
  config: { actorUserId?: string | null; requestId: string }
): LicenseRecord[] {
  const reactivated: LicenseRecord[] = [];
  for (const license of missedScheduleSuspendedLicenses(state, order.id)) {
    license.status = "active";
    license.updated_at = nowIso;
    const eventRow = recordLicenseEventInTx(state, license, "reactivated", "system", config.actorUserId ?? null, {
      reason,
      order_id: order.id,
    }, nowIso);
    pushLicenseOutboxEvent(state, license, "license.reactivated", reason, nowIso, eventRow.id);
    auditLicenseTransition(
      state,
      license,
      "licenses.license.reactivated",
      "system",
      config.actorUserId ?? null,
      config.requestId,
      { order_id: order.id, reason }
    );
    reactivated.push(license);
  }
  return reactivated;
}

/**
 * Missed-schedule check for one order (sweep + approval both call it):
 * suspend when the toggle is on, the license is active, and any installment
 * is past its due date with an amount still remaining; reactivate
 * missed-schedule suspensions once nothing is missed anymore.
 */
export function evaluateSuspensionForOrderInTx(
  state: DatabaseState,
  order: OrderRecord,
  now: Date,
  config: { actorUserId?: string | null; requestId: string; timeZone?: string | undefined }
): { suspended: LicenseRecord[]; reactivated: LicenseRecord[] } {
  const nowIso = now.toISOString();
  if (!order.suspend_on_missed_schedule) {
    return { suspended: [], reactivated: [] };
  }
  // F-12: the missed-schedule boundary is a BUSINESS date (Asia/Dhaka),
  // not the UTC date — an installment due "today Dhaka" is not missed
  // at 01:00 Dhaka (when UTC still says yesterday).
  const today = businessTodayIso(now, config.timeZone ?? "Asia/Dhaka");
  const missed = state.order_installments.some(
    (i) =>
      i.order_id === order.id &&
      i.due_date < today &&
      i.paid_amount_minor < i.amount_minor
  );
  if (missed) {
    const suspended = suspendLicensesForOrderInTx(
      state,
      order,
      "missed_schedule",
      nowIso,
      config
    );
    return { suspended, reactivated: [] };
  }
  const reactivated = reactivateLicensesForOrderInTx(
    state,
    order,
    "missed_schedule_caught_up",
    nowIso,
    config
  );
  return { suspended: [], reactivated };
}

/** Expire one license (sweep): status → expired + event + outbox + audit. */
export function expireLicenseInTx(
  state: DatabaseState,
  license: LicenseRecord,
  reason: string,
  nowIso: string,
  requestId: string
): void {
  if (license.status === "expired" || license.status === "revoked") return;
  license.status = "expired";
  license.updated_at = nowIso;
  const eventRow = recordLicenseEventInTx(state, license, "expired", "system", null, { reason }, nowIso);
  pushLicenseOutboxEvent(state, license, "license.expired", reason, nowIso, eventRow.id);
  auditLicenseTransition(state, license, "licenses.license.expired", "system", null, requestId, {
    reason,
  });
}
