import { randomUUID } from "node:crypto";
import { addBillingIntervalUTC } from "../../../../../packages/contracts/src/index.ts";
import { randomOpaqueToken } from "../../platform/crypto/index.ts";
import type {
  DatabaseState,
  InvoiceRecord,
  OrderItemRecord,
  OrderRecord,
  StackMateDataStore,
  SubscriptionRecord,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { generateInvoiceForOrderInTx } from "../commerce/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export function createOrExtendSubscriptionInTx(
  state: DatabaseState,
  order: OrderRecord,
  orderItem: OrderItemRecord,
  // Nullable since 0009: date-based activation (cron sweep) fulfills without
  // a payment transaction; the period's payment_transaction_id stays null.
  paymentTransactionId: string | null
): SubscriptionRecord {
  const nowIso = new Date().toISOString();
  // Check if this order is a renewal order for an existing pending subscription period
  for (const sub of state.subscriptions) {
    const pendingPeriod = sub.periods.find(
      (p) => p.renewal_order_id === order.id && p.status === "pending"
    );
    if (pendingPeriod) {
      pendingPeriod.status = "active";
      pendingPeriod.payment_transaction_id = paymentTransactionId;
      pendingPeriod.activated_at = nowIso;
      sub.status = "active";
      sub.current_period_start = pendingPeriod.period_start;
      sub.current_period_end = pendingPeriod.period_end;
      sub.next_renewal_at = pendingPeriod.period_end;
      sub.updated_at = nowIso;

      // Extend linked license validity & snapshot
      const linkedLicense = state.licenses.find((l) => l.subscription_id === sub.id);
      if (linkedLicense) {
        linkedLicense.status = "active";
        linkedLicense.expires_at = pendingPeriod.period_end;
        const product = state.products.find((pr) => pr.id === sub.product_id);
        const graceHours = product?.offline_grace_hours ?? 72;
        linkedLicense.grace_until = new Date(
          new Date(pendingPeriod.period_end).getTime() + graceHours * 3600 * 1000
        ).toISOString();
        linkedLicense.updated_at = nowIso;
      }

      state.outbox_events.push({
        id: randomUUID(),
        event_key: `subscription.renewed:${sub.id}:period:${pendingPeriod.period_number}`,
        aggregate_type: "subscription",
        aggregate_id: sub.id,
        event_type: "subscription.renewed",
        payload: {
          subscription_number: sub.subscription_number,
          period_number: pendingPeriod.period_number,
          current_period_end: sub.current_period_end,
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

      return sub;
    }
  }

  state.sequence_counters.subscription += 1;
  const subNumber = `SUB-${state.sequence_counters.subscription}`;
  const isRecurring =
    orderItem.price_kind_snapshot === "recurring" &&
    Boolean(orderItem.interval_unit_snapshot) &&
    Boolean(orderItem.interval_count_snapshot);

  const periodEnd = isRecurring
    ? addBillingIntervalUTC(
        nowIso,
        orderItem.interval_unit_snapshot!,
        orderItem.interval_count_snapshot!
      )
    : null;

  const subId = randomUUID();
  const initialPeriodId = randomUUID();
  const sub: SubscriptionRecord = {
    id: subId,
    subscription_number: subNumber,
    customer_id: order.customer_id,
    product_id: orderItem.product_id,
    source_order_item_id: orderItem.id,
    source_package_version_id: orderItem.package_version_id,
    status: "active",
    billing_kind:
      orderItem.price_kind_snapshot === "free" ? "one_time" : orderItem.price_kind_snapshot,
    interval_unit: orderItem.interval_unit_snapshot,
    interval_count: orderItem.interval_count_snapshot,
    currency_code: orderItem.currency_code,
    unit_amount_minor: orderItem.unit_amount_minor,
    grace_days: order.grace_days ?? 3,
    current_period_start: nowIso,
    current_period_end: periodEnd,
    next_renewal_at: periodEnd,
    cancel_at_period_end: false,
    cancelled_at: null,
    periods: [
      {
        id: initialPeriodId,
        subscription_id: subId,
        period_number: 1,
        period_start: nowIso,
        period_end: periodEnd ?? new Date(Date.now() + 100 * 365 * 86400 * 1000).toISOString(),
        status: "active",
        renewal_order_id: order.id,
        invoice_id: null,
        payment_transaction_id: paymentTransactionId,
        activated_at: nowIso,
        created_at: nowIso,
      },
    ],
    created_at: nowIso,
    updated_at: nowIso,
  };

  state.subscriptions.push(sub);
  state.outbox_events.push({
    id: randomUUID(),
    event_key: `subscription.created:${sub.id}`,
    aggregate_type: "subscription",
    aggregate_id: sub.id,
    event_type: "subscription.created",
    payload: {
      subscription_number: sub.subscription_number,
      status: sub.status,
      current_period_end: sub.current_period_end,
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

  return sub;
}

/**
 * In-transaction core of renewal-invoice generation (extracted 2026-11-17
 * for the renewal sweep, ADR-0009). Idempotent: a pending period with a
 * renewal order already returns the existing order + invoice instead of
 * creating a duplicate. Does NOT extend the active period — that happens
 * when the renewal payment is verified and approved.
 */
export function generateRenewalInvoiceInTx(
  state: DatabaseState,
  sub: SubscriptionRecord,
  actorUserId: string | null,
  requestId: string
): {
  subscription: SubscriptionRecord;
  renewal_order: OrderRecord;
  renewal_invoice: InvoiceRecord;
  checkout_access_token_reference: string;
} {
  if (sub.billing_kind !== "recurring" || !sub.interval_unit || !sub.interval_count) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Only recurring subscriptions generate renewal invoices.",
      422
    );
  }

  // Check if a pending renewal period already exists
  const existingPending = sub.periods.find((p) => p.status === "pending");
  if (existingPending && existingPending.renewal_order_id) {
    const existingOrder = state.orders.find((o) => o.id === existingPending.renewal_order_id)!;
    const existingInvoice = state.invoices.find((i) => i.order_id === existingOrder.id)!;
    return {
      subscription: sub,
      renewal_order: existingOrder,
      renewal_invoice: existingInvoice,
      checkout_access_token_reference: existingOrder.public_reference,
    };
  }

  const sourceOrderItem = state.orders
    .flatMap((o) => o.items)
    .find((it) => it.id === sub.source_order_item_id);
  if (!sourceOrderItem) {
    throw new AppError("NOT_FOUND", "Original subscription order item not found.", 404);
  }

  const nextPeriodNumber = sub.periods.reduce((max, p) => Math.max(max, p.period_number), 0) + 1;
  const nextStart = sub.current_period_end ?? new Date().toISOString();
  const nextEnd = addBillingIntervalUTC(nextStart, sub.interval_unit, sub.interval_count);
  const now = new Date().toISOString();

  state.sequence_counters.order += 1;
  const renewalOrderId = randomUUID();
  const renewalOrderItemId = randomUUID();
  const clonedItem: OrderItemRecord = {
    ...structuredClone(sourceOrderItem),
    id: renewalOrderItemId,
    order_id: renewalOrderId,
    entitlement_snapshot: {
      ...structuredClone(sourceOrderItem.entitlement_snapshot),
      id: randomUUID(),
      order_item_id: renewalOrderItemId,
      created_at: now,
    },
    created_at: now,
  };

  const renewalOrder: OrderRecord = {
    id: renewalOrderId,
    order_number: `ORD-${state.sequence_counters.order}`,
    public_reference: randomOpaqueToken("SMO", 18),
    customer_id: sub.customer_id,
    source: "admin",
    integrated_site_id: null,
    status: "awaiting_payment",
    payment_status: "unpaid",
    currency_code: sub.currency_code,
    subtotal_minor: clonedItem.line_subtotal_minor,
    discount_minor: clonedItem.line_discount_minor,
    tax_minor: clonedItem.line_tax_minor,
    total_minor: clonedItem.line_total_minor,
    customer_note: `Renewal for ${sub.subscription_number} (Period #${nextPeriodNumber})`,
    internal_note: null,
    items: [clonedItem],
    attribution: null,
    created_by_user_id: actorUserId,
    activation_mode: "on_full_payment",
    activation_percent: null,
    activation_date: null,
    suspend_on_missed_schedule: false,
    grace_days: sub.grace_days ?? 3,
    payment_method_id: null,
    lead_id: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    cancelled_at: null,
  };
  state.orders.push(renewalOrder);

  const renewalInvoice = generateInvoiceForOrderInTx(state, renewalOrder, "renewal", sub.id);

  sub.periods.push({
    id: randomUUID(),
    subscription_id: sub.id,
    period_number: nextPeriodNumber,
    period_start: nextStart,
    period_end: nextEnd,
    status: "pending",
    renewal_order_id: renewalOrder.id,
    invoice_id: renewalInvoice.id,
    payment_transaction_id: null,
    activated_at: null,
    created_at: now,
  });

  appendAuditLog(state, {
    actor_type: actorUserId ? "staff" : "system",
    actor_user_id: actorUserId,
    action: "subscriptions.renewal_invoice.created",
    resource_type: "subscription",
    resource_id: sub.id,
    outcome: "success",
    request_id: requestId,
    changes: {
      period_number: nextPeriodNumber,
      renewal_order_id: renewalOrder.id,
      renewal_invoice_id: renewalInvoice.id,
    },
  });

  return {
    subscription: sub,
    renewal_order: renewalOrder,
    renewal_invoice: renewalInvoice,
    checkout_access_token_reference: renewalOrder.public_reference,
  };
}

/**
 * Generates an idempotent manual-payment renewal order and invoice for a recurring subscription (PRD §12.4, Database Design §21.3).
 * Does NOT extend active subscription period until the customer's manual payment is verified and approved.
 *
 * A-02: the idempotency key is NEVER defaulted to a constant. When the
 * caller passes no usable key, one is derived from the NEXT period
 * (`ren_<id>_period_<n>`): a pending period re-derives its own number
 * (so a retry replays that period's invoice), while a fresh renewal
 * derives the next number (so the second manual renewal creates a NEW
 * order/invoice instead of replaying the first forever).
 */
export async function generateSubscriptionRenewalInvoice(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  subscriptionId: string,
  idempotencyKey: string | null | undefined,
  requestId: string
): Promise<{
  replayed: boolean;
  subscription: SubscriptionRecord;
  renewal_order: OrderRecord;
  renewal_invoice: InvoiceRecord;
  checkout_access_token_reference: string;
}> {
  assertStaffPermission(actor, "subscriptions.manage");
  const providedKey = idempotencyKey?.trim() ?? "";
  const effectiveKey =
    providedKey.length > 0
      ? providedKey
      : deriveRenewalIdempotencyKey(store, subscriptionId);
  const res = await store.executeIdempotent(
    `subscription_renewal:${subscriptionId}`,
    effectiveKey,
    { subscription_id: subscriptionId },
    201,
    (state) => {
      const sub = state.subscriptions.find((s) => s.id === subscriptionId);
      if (!sub) throw new AppError("NOT_FOUND", "Subscription not found.", 404);
      return generateRenewalInvoiceInTx(state, sub, actor.user.id, requestId);
    }
  );

  return {
    replayed: res.replayed,
    ...res.body,
  };
}

/**
 * A-02: derive the renewal idempotency key from the next period, read
 * from the store's loaded state (the same state the renewal transaction
 * snapshots — a pending period re-derives its own number, so a retry
 * replays instead of minting a duplicate; a missing subscription falls
 * back to a per-subscription key and the transaction still 404s).
 */
function deriveRenewalIdempotencyKey(
  store: StackMateDataStore,
  subscriptionId: string
): string {
  const sub = store.state.subscriptions.find((s) => s.id === subscriptionId);
  if (!sub) return `ren_${subscriptionId}`;
  const pending = sub.periods.find((p) => p.status === "pending");
  const nextPeriodNumber = pending
    ? pending.period_number
    : sub.periods.reduce((max, p) => Math.max(max, p.period_number), 0) + 1;
  return `ren_${subscriptionId}_period_${nextPeriodNumber}`;
}

export async function transitionSubscriptionStatus(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  subscriptionId: string,
  action: "pause" | "resume" | "cancel",
  requestId: string
): Promise<SubscriptionRecord> {
  assertStaffPermission(actor, "subscriptions.manage");
  return store.withTransaction((state) => {
    const sub = state.subscriptions.find((s) => s.id === subscriptionId);
    if (!sub) throw new AppError("NOT_FOUND", "Subscription not found.", 404);
    const prev = sub.status;
    const now = new Date().toISOString();

    if (action === "pause") {
      if (sub.status !== "active") {
        throw new AppError("CONFLICT", "Only active subscriptions can be paused.", 409);
      }
      sub.status = "paused";
    } else if (action === "resume") {
      if (sub.status !== "paused") {
        throw new AppError("CONFLICT", "Only paused subscriptions can be resumed.", 409);
      }
      sub.status = "active";
    } else if (action === "cancel") {
      sub.status = "cancelled";
      sub.cancelled_at = now;
    }
    sub.updated_at = now;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: `subscriptions.subscription.${action}`,
      resource_type: "subscription",
      resource_id: sub.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_status: prev, to_status: sub.status },
    });
    return sub;
  });
}
