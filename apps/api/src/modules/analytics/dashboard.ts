/**
 * OD-07 dashboard analytics (PRD §18).
 *
 * Pure computation over the already-loaded `DatabaseState` — the route
 * calls this with `store.state`, so the endpoint adds ZERO additional
 * DB queries on top of the full-state load the dashboard page already
 * pays for via the overview call. No Hono, no store import beyond
 * types; no targeted SQL (that would need drizzle-store.ts).
 *
 * REVENUE — the overview / P&L verified-revenue definition, reused
 * exactly: Σ total_minor over orders with payment_status === "paid"
 * AND completed_at's Dhaka calendar day inside the range
 * (parseOverviewRange; null range = all time, and a null range also
 * matches a paid order with no completed_at). Pending submissions
 * NEVER count (PRD §18) — they are not consulted at all.
 * Multi-currency caveat (same as the overview): minor units are
 * summed as-is across currencies; currency_code is the env default.
 * PRODUCT SCOPING — order-level filtering, NOT the P&L line-share
 * attribution: an order counts (with its FULL total_minor) when any
 * item's product_id matches. Deliberate difference.
 *
 * SERIES — one bucket per calendar day when the span is ≤ 92 days,
 * otherwise ISO weeks starting Monday (label = the Monday). When a
 * range is given, buckets cover every day/week of [from, to],
 * zero-filled. For a null range, buckets span min..max day present
 * in the scoped order data; empty when there is no data at all.
 * orders / paid_orders are bucketed by the CREATED_AT Dhaka day
 * (cohort, matching the overview totals); revenue_minor is bucketed
 * by the COMPLETED_AT Dhaka day (matching verified revenue). Sums
 * over the series therefore equal totals.total_orders /
 * totals.paid_orders / totals.verified_revenue_minor (when ungated;
 * null when gated). One edge: a
 * paid order with no completed_at counts in all-time revenue (null
 * range) but has no completed day — it is bucketed on its created
 * day, only in the null-range case (a bounded range never counts
 * such an order as revenue at all).
 *
 * GATING (overview precedent, M-8/F-02) — ALL order/revenue volume
 * is finance data, gated on payments.read (canSeeMoney): totals,
 * revenue_series[].orders / paid_orders, and
 * payment_method_distribution[].orders are NULL, never 0, when the
 * caller lacks payments.read. The series/distribution counts were
 * ungated before, leaking daily order volume to gated roles while
 * the totals were hidden — they are gated too. Renewal dates/counts
 * and filter options are NOT finance data and stay visible; renewal
 * amount_minor is gated.
 */
import {
  formatDisplayDateDDMMYYYY,
  isoDateOnlyInTimeZone,
} from "../../../../../packages/contracts/src/index.ts";
import type { DatabaseState } from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import {
  isTimestampInOverviewRange,
  type OverviewRange,
} from "./overview-range.ts";

export const PAYMENT_STATUSES = ["unpaid", "pending_verification", "partially_paid", "paid", "partially_refunded", "refunded"] as const;

export const SUBSCRIPTION_STATUSES = ["trialing", "pending", "active", "past_due", "paused", "cancelled", "expired"] as const;

export const ORDER_SOURCES = ["admin", "website", "api", "import"] as const;

/** Daily buckets up to and including a 92-day span; longer → weekly. */
export const DASHBOARD_WEEKLY_THRESHOLD_DAYS = 92;

/** Top-N renewal rows returned (the count itself is un-capped). */
export const DASHBOARD_RENEWALS_LIMIT = 10;

export interface DashboardRevenueSeriesPoint {
  day: string;
  revenue_minor: number | null;
  orders: number | null;
  paid_orders: number | null;
}

export interface DashboardPaymentMethodRow {
  payment_method_id: string | null;
  payment_method_name: string | null;
  revenue_minor: number | null;
  orders: number | null;
}

export interface DashboardRenewalRow {
  subscription_id: string;
  subscription_number: string;
  customer_id: string;
  customer_name: string | null;
  product_id: string;
  product_name: string | null;
  status: string;
  next_renewal_at: string | null;
  renewal_date_display: string;
  amount_minor: number | null;
  currency_code: string;
}

export interface DashboardResult {
  currency_code: string;
  range: OverviewRange | null;
  filters: { product_id: string | null; payment_status: string | null; subscription_status: string | null; source: string | null };
  filter_options: { products: Array<{ id: string; name: string; code: string }>; payment_methods: Array<{ id: string; name: string }> };
  totals: { total_customers: number; upcoming_renewals: number; verified_revenue_minor: number | null; total_orders: number | null; paid_orders: number | null };
  revenue_series: DashboardRevenueSeriesPoint[];
  payment_method_distribution: DashboardPaymentMethodRow[];
  upcoming_renewals_list: DashboardRenewalRow[];
}

export interface ComputeDashboardInput {
  range: OverviewRange | null;
  productId?: string | null;
  paymentStatus?: string | null;
  subscriptionStatus?: string | null;
  source?: string | null;
  currencyCode: string;
  timeZone: string;
  /** UTC calendar day (YYYY-MM-DD), as the overview computes it. */
  todayDay: string;
  /** True when the caller may see money (super_admin or payments.read). */
  canSeeMoney: boolean;
}

// --- E-11 renewal buckets (copied verbatim from
// platform-analytics.ts; same definitions as admin-subscriptions.ts).
// Duplicated, not imported from the route file, so this module stays
// Hono-free — keep the definitions in sync if E-11 ever changes.
// The bucket day is the UTC calendar day, exactly as the overview
// does (todayDay = new Date().toISOString().slice(0, 10)).

const RENEWAL_UPCOMING_DAYS = 30;
const renewalDayOf = (iso: string | null | undefined): string | null =>
  typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null;
const addDaysIso = (day: string, days: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const renewalBucketOf = (
  sub: { status: string; next_renewal_at: string | null },
  todayDay: string,
): "upcoming" | "due" | "overdue" | "failed" | "cancelled" | null => {
  if (sub.status === "cancelled") return "cancelled";
  if (sub.status === "past_due") return "failed";
  const day = renewalDayOf(sub.next_renewal_at);
  if (day === null) return null;
  if (day < todayDay) return "overdue";
  if (day <= addDaysIso(todayDay, 7)) return "due";
  if (day <= addDaysIso(todayDay, RENEWAL_UPCOMING_DAYS)) return "upcoming";
  return null;
};

// --- Day / week helpers ----------------------------------------------------

function daysBetweenInclusive(from: string, to: string): number {
  const fromMs = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const toMs = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDaysIso(day, 1)) days.push(day);
  return days;
}

/** Monday (YYYY-MM-DD) of the ISO week containing `day`. */
function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  // getUTCDay: 0 = Sunday … 6 = Saturday; Monday is the week start.
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** Every Monday (YYYY-MM-DD) from the week of `from` to that of `to`. */
function eachMonday(from: string, to: string): string[] {
  const mondays: string[] = [];
  for (
    let day = mondayOf(from);
    day <= mondayOf(to);
    day = addDaysIso(day, 7)
  ) {
    mondays.push(day);
  }
  return mondays;
}

function validationError(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, 400);
}

function assertEnum(
  value: string | null,
  allowed: readonly string[],
  name: string,
): void {
  if (value !== null && !allowed.includes(value)) {
    throw validationError(
      `Invalid ${name} '${value}'. Expected one of: ${allowed.join(", ")}.`,
    );
  }
}

export function computeDashboard(
  state: DatabaseState,
  input: ComputeDashboardInput,
): DashboardResult {
  const { range, timeZone, todayDay, canSeeMoney } = input;
  const productId = input.productId ?? null;
  const paymentStatus = input.paymentStatus ?? null;
  const subscriptionStatus = input.subscriptionStatus ?? null;
  const source = input.source ?? null;

  // -- Filter validation: invalid enum or unknown product → 400 ---------
  // (NOT the P&L precedent: pnl.ts answers unknown productId with
  // 404 NOT_FOUND. The OD-07 spec requires 400 VALIDATION_ERROR for
  // every bad dashboard filter, so the dashboard validates here.)
  if (productId !== null) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) {
      throw validationError(`Unknown productId '${productId}'.`);
    }
  }
  assertEnum(paymentStatus, PAYMENT_STATUSES, "paymentStatus");
  assertEnum(subscriptionStatus, SUBSCRIPTION_STATUSES, "subscriptionStatus");
  assertEnum(source, ORDER_SOURCES, "source");

  const customerById = new Map(state.customers.map((cu) => [cu.id, cu]));
  const productById = new Map(state.products.map((p) => [p.id, p]));
  const paymentMethodById = new Map(
    state.payment_methods.map((m) => [m.id, m]),
  );

  // -- Orders: all filters combine with AND ------------------------------
  const scopedOrders = state.orders.filter(
    (o) =>
      (productId === null ||
        (o.items ?? []).some((i) => i.product_id === productId)) &&
      (paymentStatus === null || o.payment_status === paymentStatus) &&
      (source === null || o.source === source),
  );
  // Cohort counts: created in range (null range = all time).
  const ordersInRange = scopedOrders.filter((o) =>
    isTimestampInOverviewRange(o.created_at, range, timeZone),
  );
  const paidOrdersInRange = ordersInRange.filter(
    (o) => o.payment_status === "paid",
  );
  // Verified revenue: paid + completed in range (null range also
  // matches a paid order with no completed_at).
  const revenueOrders = scopedOrders.filter(
    (o) =>
      o.payment_status === "paid" &&
      isTimestampInOverviewRange(o.completed_at, range, timeZone),
  );
  const verifiedRevenueMinor = revenueOrders.reduce(
    (sum, o) => sum + o.total_minor,
    0,
  );

  // -- Revenue series -------------------------------------------------------
  const createdDayOf = (iso: string): string =>
    isoDateOnlyInTimeZone(iso, timeZone);
  // Revenue day: completed day; a paid order with no completed_at
  // (all-time only) falls back to its created day — see header.
  const revenueDayOf = (o: (typeof revenueOrders)[number]): string =>
    o.completed_at !== null
      ? isoDateOnlyInTimeZone(o.completed_at, timeZone)
      : createdDayOf(o.created_at);

  let bucketLabels: string[] = [];
  let weekly = false;
  if (range !== null) {
    const spanDays = daysBetweenInclusive(range.from, range.to);
    weekly = spanDays > DASHBOARD_WEEKLY_THRESHOLD_DAYS;
    bucketLabels = weekly
      ? eachMonday(range.from, range.to)
      : eachDay(range.from, range.to);
  } else {
    const dataDays = [
      ...ordersInRange.map((o) => createdDayOf(o.created_at)),
      ...revenueOrders.map((o) => revenueDayOf(o)),
    ].sort();
    if (dataDays.length > 0) {
      const minDay = dataDays[0]!;
      const maxDay = dataDays[dataDays.length - 1]!;
      weekly =
        daysBetweenInclusive(minDay, maxDay) > DASHBOARD_WEEKLY_THRESHOLD_DAYS;
      bucketLabels = weekly
        ? eachMonday(minDay, maxDay)
        : eachDay(minDay, maxDay);
    }
  }
  const bucketKeyOf = (day: string): string => (weekly ? mondayOf(day) : day);
  const seriesByKey = new Map<string, DashboardRevenueSeriesPoint>();
  for (const label of bucketLabels) {
    seriesByKey.set(label, {
      day: label,
      revenue_minor: canSeeMoney ? 0 : null,
      // F-02: series counts are finance data — null when gated.
      orders: canSeeMoney ? 0 : null,
      paid_orders: canSeeMoney ? 0 : null,
    });
  }
  for (const o of ordersInRange) {
    const bucket = seriesByKey.get(bucketKeyOf(createdDayOf(o.created_at)));
    if (!bucket || bucket.orders === null || bucket.paid_orders === null) continue;
    bucket.orders += 1;
    if (o.payment_status === "paid") bucket.paid_orders += 1;
  }
  for (const o of revenueOrders) {
    const bucket = seriesByKey.get(bucketKeyOf(revenueDayOf(o)));
    if (!bucket || bucket.revenue_minor === null) continue;
    bucket.revenue_minor += o.total_minor;
  }
  const revenue_series = bucketLabels.map(
    (label) => seriesByKey.get(label)!,
  );

  // -- Payment-method distribution: PAID orders in range, after filters ---
  const distributionByKey = new Map<
    string | null,
    { revenue: number; orders: number }
  >();
  for (const o of revenueOrders) {
    const key = o.payment_method_id;
    const row = distributionByKey.get(key) ?? { revenue: 0, orders: 0 };
    row.revenue += o.total_minor;
    row.orders += 1;
    distributionByKey.set(key, row);
  }
  const payment_method_distribution: DashboardPaymentMethodRow[] = [
    ...distributionByKey.entries(),
  ]
    .map(([payment_method_id, row]) => ({
      payment_method_id,
      payment_method_name:
        payment_method_id === null
          ? null
          : (paymentMethodById.get(payment_method_id)?.display_name ?? null),
      revenue_minor: canSeeMoney ? row.revenue : null,
      // F-02: distribution counts are finance data — null when gated.
      orders: canSeeMoney ? row.orders : null,
    }))
    .sort(
      (a, b) =>
        (canSeeMoney ? (b.revenue_minor ?? 0) - (a.revenue_minor ?? 0) : 0) ||
        (b.orders ?? 0) - (a.orders ?? 0) ||
        (a.payment_method_name ?? "").localeCompare(
          b.payment_method_name ?? "",
        ),
    );

  // -- Upcoming renewals: E-11 upcoming + due, after filters, top 10 ------
  const scopedSubscriptions = state.subscriptions.filter(
    (s) =>
      (productId === null || s.product_id === productId) &&
      (subscriptionStatus === null || s.status === subscriptionStatus),
  );
  const upcomingRenewals = scopedSubscriptions
    .filter((s) => {
      const bucket = renewalBucketOf(s, todayDay);
      return bucket === "upcoming" || bucket === "due";
    })
    .sort(
      (a, b) =>
        (a.next_renewal_at ?? "").localeCompare(b.next_renewal_at ?? "") ||
        a.subscription_number.localeCompare(b.subscription_number),
    );
  const upcoming_renewals_list: DashboardRenewalRow[] = upcomingRenewals
    .slice(0, DASHBOARD_RENEWALS_LIMIT)
    .map((s) => ({
      subscription_id: s.id,
      subscription_number: s.subscription_number,
      customer_id: s.customer_id,
      customer_name: customerById.get(s.customer_id)?.name ?? null,
      product_id: s.product_id,
      product_name: productById.get(s.product_id)?.name ?? null,
      status: s.status,
      next_renewal_at: s.next_renewal_at,
      // next_renewal_at is non-null for upcoming/due buckets (the
      // bucket is null when there is no renewal day).
      renewal_date_display:
        s.next_renewal_at !== null
          ? formatDisplayDateDDMMYYYY(s.next_renewal_at, timeZone)
          : "",
      amount_minor: canSeeMoney ? s.unit_amount_minor : null,
      currency_code: s.currency_code,
    }));

  return {
    currency_code: input.currencyCode,
    range,
    filters: {
      product_id: productId,
      payment_status: paymentStatus,
      subscription_status: subscriptionStatus,
      source,
    },
    filter_options: {
      products: [...state.products]
        .map((p) => ({ id: p.id, name: p.name, code: p.code }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      payment_methods: [...state.payment_methods]
        .map((m) => ({
          id: m.id,
          name: m.display_name,
          sort_order: m.sort_order,
        }))
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
        .map(({ id, name }) => ({ id, name })),
    },
    totals: {
      // Customers have no product — the count is global, never scoped.
      total_customers: state.customers.length,
      upcoming_renewals: upcomingRenewals.length,
      verified_revenue_minor: canSeeMoney ? verifiedRevenueMinor : null,
      total_orders: canSeeMoney ? ordersInRange.length : null,
      paid_orders: canSeeMoney ? paidOrdersInRange.length : null,
    },
    revenue_series,
    payment_method_distribution,
    upcoming_renewals_list,
  };
}
