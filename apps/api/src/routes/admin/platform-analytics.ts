/**
 * Admin analytics routes (Hono) — Hono migration Phase 1.
 *
 * Split out of platform.ts (500-line cap). Dashboard overview +
 * profit & loss. Converted verbatim from app.ts (baseline
 * feat e382d65).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import {
  createSuccessEnvelope,
  formatDisplayDateDDMMYYYY,
} from "../../../../../packages/contracts/src/index.ts";
import {
  computeOrderPaid,
  computeOrderRemaining,
} from "../../modules/customers/service.ts";
import {
  isTimestampInOverviewRange,
  parseOverviewRange,
} from "../../modules/analytics/overview-range.ts";
import { computeProfitLoss } from "../../modules/analytics/pnl.ts";
import { computeDashboard } from "../../modules/analytics/dashboard.ts";

// --- HTTP plumbing copied from app.ts handleRequest (closures there) ---

function requirePrincipal(c: Context<AppEnv>): StaffPrincipal {
  const principal = c.var.principal;
  if (!principal) {
    throw new AppError(
      "UNAUTHORIZED",
      "Valid staff authentication session required.",
      401
    );
  }
  return principal;
}

function ok<T>(c: Context<AppEnv>, data: T, status = 200): Response {
  return c.json(createSuccessEnvelope(data, c.var.requestId), status as ContentfulStatusCode);
}

function sortByTimestamp<T extends { id: string }>(
  items: T[],
  field: string,
  direction: "desc" | "asc"
): T[] {
  const timeOf = (row: T): number => {
    const n = new Date(
      String((row as Record<string, unknown>)[field] ?? "")
    ).getTime();
    return Number.isFinite(n) ? n : 0;
  };
  return [...items].sort((a, b) => {
    const byTime = timeOf(a) - timeOf(b);
    if (byTime !== 0) return direction === "desc" ? -byTime : byTime;
    return a.id.localeCompare(b.id);
  });
}

// B-05: cursor pagination for the append-heavy lists (audit logs,
// tracking events, outbox). Offset paging over append-heavy tables
// can skip/duplicate rows between pages as rows are inserted; a
// cursor pins the position. Rows are newest-first
// (created_at DESC, id DESC tiebreak); the cursor is the last row
// of the previous page. A malformed ?cursor= is a 400, never a
// silent restart from page 1.

// E-09/E-11: renewal buckets over subscriptions (see
// admin-subscriptions.ts — same definitions, copied from app.ts).
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
  todayDay: string
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

export function registerAdminPlatformAnalyticsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/analytics/overview", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "products.read", requestId);
    // M-8: revenue is finance data — only callers who can see
    // payments see it. There is no finance.* permission in the
    // seed catalogue (only the finance_manager ROLE, which holds
    // payments.read), so payments.read is the gate; null (not 0)
    // when the caller lacks it, so a missing value is never
    // mistaken for "no revenue". The SPA hides the revenue card
    // on null.
    const canSeeRevenue =
      principal.roles.includes("super_admin") ||
      principal.permissions.includes("payments.read");
    const range = parseOverviewRange(new URL(c.req.url).searchParams);
    const timeZone = env.DEFAULT_TIMEZONE;
    const inRange = (iso: string | null | undefined) =>
      isTimestampInOverviewRange(iso, range, timeZone);
    // Revenue: paid orders completed in the range. A null range
    // (all time) matches every paid order, including one with no
    // completed_at — exactly the pre-filter computation.
    const paidOrders = store.state.orders.filter(
      (o) =>
        o.payment_status === "paid" &&
        (range === null ? true : inRange(o.completed_at)),
    );
    const verifiedRevenueMinor = paidOrders.reduce((acc, o) => acc + o.total_minor, 0);
    const ordersInRange = store.state.orders.filter((o) => inRange(o.created_at));
    const paidOrdersInRange = ordersInRange.filter((o) => o.payment_status === "paid");
    const pendingSubmissions = store.state.payment_submissions.filter(
      (s) => s.status === "submitted" || s.status === "under_review"
    );

    // B-06: one call instead of four — the overview carries the
    // three dashboard panels' top-5 rows (Worker D consumes
    // `panels`; the SPA's separate panel queries stay as a
    // fallback until it switches over). Panels are server-sorted
    // over the full set, so a row is never hidden by a
    // creation-sorted ?limit=100 window (the old D-02 gap).
    // E-11: upcoming_renewals = renewable subscriptions whose
    // next renewal falls within 30 days (the upcoming + due
    // buckets of the renewals view).
    const todayDay = new Date().toISOString().slice(0, 10);
    const upcomingRenewals = store.state.subscriptions.filter((s) => {
      const bucket = renewalBucketOf(s, todayDay);
      return bucket === "upcoming" || bucket === "due";
    });
    const customerById = new Map(store.state.customers.map((cu) => [cu.id, cu]));
    const panels = {
      recent_orders: sortByTimestamp(store.state.orders, "created_at", "desc")
        .slice(0, 5)
        .map((o) => ({
          ...o,
          customer: customerById.get(o.customer_id) ?? null,
          paid_amount_minor: computeOrderPaid(store.state, o.id),
          remaining_minor: computeOrderRemaining(store.state, o),
          created_date_display: formatDisplayDateDDMMYYYY(
            o.created_at,
            env.DEFAULT_TIMEZONE
          ),
        })),
      pending_submissions: [...pendingSubmissions]
        .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
        .slice(0, 5)
        .map((s) => ({
          ...s,
          customer: customerById.get(s.customer_id) ?? null,
          order_number:
            store.state.orders.find((o) => o.id === s.order_id)?.order_number ?? null,
        })),
      expiring_licenses: [...store.state.licenses]
        .filter((l) => {
          if (l.status !== "active") return false;
          const day = renewalDayOf(l.expires_at);
          return (
            day !== null &&
            day >= todayDay &&
            day <= addDaysIso(todayDay, RENEWAL_UPCOMING_DAYS)
          );
        })
        .sort((a, b) => (a.expires_at ?? "") < (b.expires_at ?? "") ? -1 : 1)
        .slice(0, 5)
        .map((l) => {
          const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = l;
          const customer = customerById.get(l.customer_id);
          const product = store.state.products.find((p) => p.id === l.product_id);
          return {
            ...safe,
            customer_name: customer?.name ?? null,
            product_code: product?.code ?? null,
            product_name: product?.name ?? null,
            active_activations_count: l.activations.filter((a) => a.status === "active")
              .length,
            expires_date_display: l.expires_at
              ? formatDisplayDateDDMMYYYY(l.expires_at, env.DEFAULT_TIMEZONE)
              : "Lifetime",
          };
        }),
    };

    return ok(c, {
      currency_code: env.DEFAULT_CURRENCY,
      total_products: store.state.products.length,
      active_products: store.state.products.filter((p) => p.status === "active").length,
      total_customers: store.state.customers.length,
      // F-02: order/payment counts are finance data too — gated
      // on the same canSeeRevenue predicate as
      // verified_revenue_minor (null, not 0, when the caller
      // lacks payments.read, so a missing value is never
      // mistaken for "no orders"). The SPA hides these cards on
      // null, as it does for revenue.
      total_orders: canSeeRevenue ? ordersInRange.length : null,
      paid_orders: canSeeRevenue ? paidOrdersInRange.length : null,
      pending_payment_submissions: canSeeRevenue ? pendingSubmissions.length : null,
      upcoming_renewals: upcomingRenewals.length,
      panels,
      active_subscriptions: store.state.subscriptions.filter((s) => s.status === "active")
        .length,
      active_licenses: store.state.licenses.filter((l) => l.status === "active").length,
      expired_or_revoked_licenses: store.state.licenses.filter(
        (l) => l.status === "expired" || l.status === "revoked"
      ).length,
      verified_revenue_minor: canSeeRevenue ? verifiedRevenueMinor : null,
      pending_outbox_events: store.state.outbox_events.filter(
        (e) => e.status === "pending"
      ).length,
      range,
    });
  });

  // OD-07 dashboard (PRD §18) — full dashboard surface in one call:
  // totals, revenue series (daily ≤ 92 days, else weekly from Monday),
  // payment-method distribution, upcoming renewals (top 10), plus
  // filter options. Pure computation over the already-loaded
  // store.state (see modules/analytics/dashboard.ts header): this
  // endpoint adds ZERO additional DB queries. Filters combine with
  // AND; invalid enum values and unknown productId are 400
  // VALIDATION_ERROR (thrown by computeDashboard). Permission gating
  // follows the overview precedent (products.read to call;
  // payments.read / super_admin for money fields, null when gated).
  app.get("/api/v1/admin/analytics/dashboard", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "products.read", requestId);
    const canSeeMoney =
      principal.roles.includes("super_admin") ||
      principal.permissions.includes("payments.read");
    const params = new URL(c.req.url).searchParams;
    const range = parseOverviewRange(params);
    // Empty-string query values count as absent, not as a filter.
    const queryOrNull = (name: string): string | null => {
      const value = c.req.query(name);
      return value ? value : null;
    };
    const result = computeDashboard(store.state, {
      range,
      productId: queryOrNull("productId"),
      paymentStatus: queryOrNull("paymentStatus"),
      subscriptionStatus: queryOrNull("subscriptionStatus"),
      source: queryOrNull("source"),
      currencyCode: env.DEFAULT_CURRENCY,
      timeZone: env.DEFAULT_TIMEZONE,
      todayDay: new Date().toISOString().slice(0, 10),
      canSeeMoney,
    });
    return ok(c, result);
  });

  // Profit & Loss — sales are the dashboard verified-revenue
  // definition (paid + completed in range, order totals) minus
  // succeeded refunds recorded in range; see pnl.ts header.


  app.get("/api/v1/admin/analytics/profit-loss", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
    const range = parseOverviewRange(new URL(c.req.url).searchParams);
    const productId = c.req.query("productId") ?? null;
    const result = computeProfitLoss(store.state, {
      range,
      productId,
      timeZone: env.DEFAULT_TIMEZONE,
    });
    return ok(c, result);
  });

}
