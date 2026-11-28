/**
 * OD-07 dashboard analytics (PRD §18) — `GET /api/v1/admin/analytics/dashboard`.
 *
 * Unit tests drive computeDashboard directly over an in-memory store
 * (fixed dates, fixed todayDay "2026-11-28" — no dependence on the
 * real clock), plus route-level tests through the Hono app (in-memory
 * store, no Postgres) asserting 200 + envelope shape and 400s.
 *
 * Main fixture (all timestamps 10:00Z = 16:00 Dhaka, same day):
 *   products A ("Alpha Product"), B ("Beta Product"); customers c1, c2
 *   methods m1 ("bKash Personal"), m2 ("Bank Transfer")
 *   o1  A, paid,      created 11-02, completed 11-03, 100000, admin,   m1
 *   o2  A, paid,      created 11-03, completed 11-03,  50000, website, m1
 *   o3  B, unpaid,    created 11-03, completed null,   20000, admin,   —
 *   o4  B, paid,      created 11-10, completed 11-10,  70000, api,     m2
 *   o5  A, partially, created 11-03, completed null,   30000, admin,   m1
 *       + a "submitted" payment claim (pending — must NEVER count)
 *   o6  A, paid,      created 11-01, completed NULL,   40000, admin,   —
 *       (all-time revenue counts it; bounded ranges do not)
 *   o7  A+B items, paid, created 11-03, completed 11-03, 60000, import, —
 *   s-due       active,   next 2026-11-30, A, 100000, c1 (due bucket)
 *   s-upcoming  active,   next 2026-12-20, B,  50000, c2 (upcoming)
 *   s-far       active,   next 2027-01-15, A (beyond 30d — excluded)
 *   s-overdue   active,   next 2026-11-20, A (past — excluded)
 *   s-pastdue   past_due, next 2026-11-29, A (failed bucket — excluded)
 *   s-cancelled cancelled,next 2026-11-29, A (cancelled — excluded)
 *   s-norenewal active,   next null,       A (no day — excluded)
 */
import { describe, it, beforeAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  computeDashboard,
  type ComputeDashboardInput,
} from "../src/modules/analytics/dashboard.ts";
import {
  seedCustomer,
  seedOrder,
  seedPaymentMethod,
  seedProduct,
  seedSubscription,
} from "./customer-order-helpers.ts";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import type { AppError } from "../src/shared/errors.ts";

const TIME_ZONE = "Asia/Dhaka";
const TODAY = "2026-11-28";
const DAY = "2026-11-03T10:00:00.000Z";

function isValidationError(err: unknown): boolean {
  return (
    (err as AppError).code === "VALIDATION_ERROR" &&
    (err as AppError).statusCode === 400
  );
}

describe("dashboard analytics — computeDashboard", () => {
  let store: StackMateDataStore;
  let prodA: ReturnType<typeof seedProduct>;
  let prodB: ReturnType<typeof seedProduct>;
  let method1: ReturnType<typeof seedPaymentMethod>;
  let method2: ReturnType<typeof seedPaymentMethod>;

  function base(
    overrides: Partial<ComputeDashboardInput> = {},
  ): ReturnType<typeof computeDashboard> {
    return computeDashboard(store.state, {
      range: null,
      currencyCode: "BDT",
      timeZone: TIME_ZONE,
      todayDay: TODAY,
      canSeeMoney: true,
      ...overrides,
    });
  }

  beforeEach(() => {
    store = new StackMateDataStore();
    const s = store.state;
    prodA = seedProduct(s, { name: "Alpha Product", code: "ALPHA" });
    prodB = seedProduct(s, { name: "Beta Product", code: "BETA" });
    const c1 = seedCustomer(s, { name: "Customer One" });
    const c2 = seedCustomer(s, { name: "Customer Two" });
    method1 = seedPaymentMethod(s);
    method1.display_name = "bKash Personal";
    method2 = seedPaymentMethod(s);
    method2.display_name = "Bank Transfer";

    seedOrder(s, c1.id, prodA, {
      payment_status: "paid",
      created_at: "2026-11-02T10:00:00.000Z",
      completed_at: "2026-11-03T10:00:00.000Z",
      total_minor: 100000,
      subtotal_minor: 100000,
      source: "admin",
      payment_method_id: method1.id,
    });
    seedOrder(s, c1.id, prodA, {
      payment_status: "paid",
      created_at: DAY,
      completed_at: DAY,
      total_minor: 50000,
      subtotal_minor: 50000,
      source: "website",
      payment_method_id: method1.id,
    });
    seedOrder(s, c2.id, prodB, {
      payment_status: "unpaid",
      created_at: DAY,
      completed_at: null,
      total_minor: 20000,
      subtotal_minor: 20000,
      source: "admin",
      payment_method_id: null,
    });
    seedOrder(s, c2.id, prodB, {
      payment_status: "paid",
      created_at: "2026-11-10T10:00:00.000Z",
      completed_at: "2026-11-10T10:00:00.000Z",
      total_minor: 70000,
      subtotal_minor: 70000,
      source: "api",
      payment_method_id: method2.id,
    });
    const o5 = seedOrder(s, c1.id, prodA, {
      payment_status: "partially_paid",
      created_at: DAY,
      completed_at: null,
      total_minor: 30000,
      subtotal_minor: 30000,
      source: "admin",
      payment_method_id: method1.id,
    });
    // Pending submission on the partially-paid order — must never count.
    s.payment_submissions.push({
      id: randomUUID(),
      order_id: o5.id,
      customer_id: c1.id,
      payment_method_id: method1.id,
      installment_id: null,
      amount_minor: 30000,
      currency_code: "BDT",
      sender_name: null,
      sender_phone: null,
      sender_bank_name: null,
      sender_account_reference: null,
      transfer_rail_key: null,
      transaction_reference: null,
      normalized_transaction_reference: null,
      payment_date: null,
      proof_asset_id: null,
      duplicate_risk_Warning: false,
      status: "submitted",
      customer_note: null,
      submitted_at: DAY,
      reviewed_at: null,
      reviewed_by_user_id: null,
    });
    seedOrder(s, c1.id, prodA, {
      payment_status: "paid",
      created_at: "2026-11-01T10:00:00.000Z",
      completed_at: null,
      total_minor: 40000,
      subtotal_minor: 40000,
      source: "admin",
      payment_method_id: null,
    });
    const o7 = seedOrder(s, c1.id, prodA, {
      payment_status: "paid",
      created_at: DAY,
      completed_at: DAY,
      total_minor: 60000,
      subtotal_minor: 60000,
      source: "import",
      payment_method_id: null,
    });
    // Second item: the order belongs to BOTH products (any-item match).
    const itemA = o7.items[0]!;
    itemA.line_total_minor = 30000;
    itemA.line_subtotal_minor = 30000;
    itemA.unit_amount_minor = 30000;
    o7.items.push({
      ...itemA,
      id: randomUUID(),
      product_id: prodB.id,
      product_name_snapshot: prodB.name,
      line_total_minor: 30000,
      line_subtotal_minor: 30000,
      unit_amount_minor: 30000,
    });

    seedSubscription(s, {
      customer_id: c1.id,
      product_id: prodA.id,
      status: "active",
      next_renewal_at: "2026-11-30T10:00:00.000Z",
      unit_amount_minor: 100000,
    });
    seedSubscription(s, {
      customer_id: c2.id,
      product_id: prodB.id,
      status: "active",
      next_renewal_at: "2026-12-20T10:00:00.000Z",
      unit_amount_minor: 50000,
    });
    seedSubscription(s, {
      customer_id: c1.id,
      product_id: prodA.id,
      status: "active",
      next_renewal_at: "2027-01-15T10:00:00.000Z",
      unit_amount_minor: 100000,
    });
    seedSubscription(s, {
      customer_id: c1.id,
      product_id: prodA.id,
      status: "active",
      next_renewal_at: "2026-11-20T10:00:00.000Z",
      unit_amount_minor: 100000,
    });
    seedSubscription(s, {
      customer_id: c1.id,
      product_id: prodA.id,
      status: "past_due",
      next_renewal_at: "2026-11-29T10:00:00.000Z",
      unit_amount_minor: 100000,
    });
    seedSubscription(s, {
      customer_id: c1.id,
      product_id: prodA.id,
      status: "cancelled",
      next_renewal_at: "2026-11-29T10:00:00.000Z",
      unit_amount_minor: 100000,
    });
    seedSubscription(s, {
      customer_id: c1.id,
      product_id: prodA.id,
      status: "active",
      next_renewal_at: null,
      unit_amount_minor: 100000,
    });
  });

  it("all time, no filters — totals, series, distribution, renewals", () => {
    const d = base();
    assert.equal(d.currency_code, "BDT");
    assert.equal(d.range, null);
    assert.deepEqual(d.filters, {
      product_id: null,
      payment_status: null,
      subscription_status: null,
      source: null,
    });
    assert.equal(d.totals.total_customers, 2);
    assert.equal(d.totals.upcoming_renewals, 2);
    assert.equal(d.totals.verified_revenue_minor, 320000);
    assert.equal(d.totals.total_orders, 7);
    assert.equal(d.totals.paid_orders, 5);

    // Daily buckets 11-01..11-10 (min..max data day), zero-filled.
    assert.deepEqual(
      d.revenue_series.map((p) => p.day),
      [
        "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04",
        "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08",
        "2026-11-09", "2026-11-10",
      ],
    );
    const byDay = new Map(d.revenue_series.map((p) => [p.day, p]));
    // 11-01: o6 (paid, no completed_at) falls back to its created day.
    assert.deepEqual(
      { revenue: byDay.get("2026-11-01")!.revenue_minor, orders: byDay.get("2026-11-01")!.orders, paid: byDay.get("2026-11-01")!.paid_orders },
      { revenue: 40000, orders: 1, paid: 1 },
    );
    // 11-02: o1 created (revenue lands 11-03, its completed day).
    assert.deepEqual(
      { revenue: byDay.get("2026-11-02")!.revenue_minor, orders: byDay.get("2026-11-02")!.orders, paid: byDay.get("2026-11-02")!.paid_orders },
      { revenue: 0, orders: 1, paid: 1 },
    );
    // 11-03: o1+o2+o7 completed; o2/o3/o5/o7 created (paid: o2, o7).
    assert.deepEqual(
      { revenue: byDay.get("2026-11-03")!.revenue_minor, orders: byDay.get("2026-11-03")!.orders, paid: byDay.get("2026-11-03")!.paid_orders },
      { revenue: 210000, orders: 4, paid: 2 },
    );
    assert.deepEqual(
      { revenue: byDay.get("2026-11-04")!.revenue_minor, orders: byDay.get("2026-11-04")!.orders, paid: byDay.get("2026-11-04")!.paid_orders },
      { revenue: 0, orders: 0, paid: 0 },
    );
    assert.deepEqual(
      { revenue: byDay.get("2026-11-10")!.revenue_minor, orders: byDay.get("2026-11-10")!.orders, paid: byDay.get("2026-11-10")!.paid_orders },
      { revenue: 70000, orders: 1, paid: 1 },
    );
    // Series sums equal the totals.
    assert.equal(d.revenue_series.reduce((s, p) => s + (p.revenue_minor ?? 0), 0), 320000);
    assert.equal(d.revenue_series.reduce((s, p) => s + (p.orders ?? 0), 0), 7);
    assert.equal(d.revenue_series.reduce((s, p) => s + (p.paid_orders ?? 0), 0), 5);

    // Distribution over paid orders: m1 150k/2, Unknown 100k/2, m2 70k/1.
    assert.deepEqual(
      d.payment_method_distribution.map((r) => ({
        id: r.payment_method_id,
        revenue: r.revenue_minor,
        orders: r.orders,
      })),
      [
        { id: method1.id, revenue: 150000, orders: 2 },
        { id: null, revenue: 100000, orders: 2 },
        { id: method2.id, revenue: 70000, orders: 1 },
      ],
    );
    assert.equal(
      d.payment_method_distribution.find((r) => r.payment_method_id === null)!
        .payment_method_name,
      null,
    );
    assert.equal(
      d.payment_method_distribution.find((r) => r.payment_method_id === method1.id)!
        .payment_method_name,
      "bKash Personal",
    );

    // Renewals: due first, then upcoming; far/overdue/past-due/
    // cancelled/no-renewal excluded.
    assert.equal(d.upcoming_renewals_list.length, 2);
    const [due, upcoming] = d.upcoming_renewals_list;
    assert.equal(due!.renewal_date_display, "30/11/2026");
    assert.equal(due!.customer_name, "Customer One");
    assert.equal(due!.product_name, "Alpha Product");
    assert.equal(due!.amount_minor, 100000);
    assert.equal(due!.currency_code, "BDT");
    assert.equal(due!.status, "active");
    assert.equal(upcoming!.renewal_date_display, "20/12/2026");
    assert.equal(upcoming!.customer_name, "Customer Two");
    assert.equal(upcoming!.product_name, "Beta Product");
    assert.equal(upcoming!.amount_minor, 50000);

    assert.deepEqual(
      d.filter_options.products.map((p) => p.code),
      ["ALPHA", "BETA"],
    );
    assert.deepEqual(
      d.filter_options.payment_methods.map((m) => m.id).sort(),
      [method1.id, method2.id].sort(),
    );
  });

  it("bounded range 11-01..11-03 — zero-filled days, no-completed_at excluded", () => {
    const d = base({ range: { from: "2026-11-01", to: "2026-11-03" } });
    assert.deepEqual(d.range, { from: "2026-11-01", to: "2026-11-03" });
    assert.equal(d.revenue_series.length, 3);
    assert.deepEqual(
      d.revenue_series.map((p) => p.day),
      ["2026-11-01", "2026-11-02", "2026-11-03"],
    );
    // o6 (paid, completed null) counts in NEITHER revenue nor its
    // 11-01 bucket under a bounded range — but still counts as a
    // created order that day.
    assert.equal(d.totals.verified_revenue_minor, 210000);
    assert.equal(d.totals.total_orders, 6);
    assert.equal(d.totals.paid_orders, 4);
    assert.equal(d.revenue_series[0]!.revenue_minor, 0);
    assert.equal(d.revenue_series[0]!.orders, 1);
    assert.equal(d.revenue_series[0]!.paid_orders, 1);
    assert.equal(d.revenue_series[2]!.revenue_minor, 210000);
    // Distribution: only paid+completed in range (o1, o2, o7).
    assert.deepEqual(
      d.payment_method_distribution.map((r) => [r.payment_method_id, r.revenue_minor, r.orders]),
      [[method1.id, 150000, 2], [null, 60000, 1]],
    );
    // Renewals and customers are NOT range-scoped.
    assert.equal(d.totals.upcoming_renewals, 2);
    assert.equal(d.totals.total_customers, 2);
  });

  it("empty range — zero-filled buckets, zeros not errors", () => {
    const d = base({ range: { from: "2026-11-18", to: "2026-11-19" } });
    assert.equal(d.revenue_series.length, 2);
    assert.ok(d.revenue_series.every((p) => p.revenue_minor === 0 && p.orders === 0 && p.paid_orders === 0));
    assert.equal(d.totals.verified_revenue_minor, 0);
    assert.equal(d.totals.total_orders, 0);
    assert.deepEqual(d.payment_method_distribution, []);
  });

  it("weekly switch — >92-day range buckets by Monday, first/last labels", () => {
    const d = base({ range: { from: "2026-01-01", to: "2026-05-01" } });
    // 2026-01-01 is a Thursday → first bucket Monday 2025-12-29;
    // 2026-05-01 is a Friday → last bucket Monday 2026-04-27.
    assert.equal(d.revenue_series.length, 18);
    assert.equal(d.revenue_series[0]!.day, "2025-12-29");
    assert.equal(d.revenue_series[17]!.day, "2026-04-27");
    assert.ok(d.revenue_series.every((p) => p.revenue_minor === 0 && p.orders === 0));
  });

  it("weekly buckets with data — revenue/orders land in the right week", () => {
    const d = base({ range: { from: "2026-09-01", to: "2026-12-31" } });
    assert.equal(d.revenue_series.length, 18);
    assert.equal(d.revenue_series[0]!.day, "2026-08-31");
    assert.equal(d.revenue_series[17]!.day, "2026-12-28");
    const byDay = new Map(d.revenue_series.map((p) => [p.day, p]));
    // o6 created Sun 11-01 → week Mon 10-26 (orders bucket), but its
    // revenue is EXCLUDED: paid with no completed_at never counts
    // under a bounded range (the created-day fallback is all-time only).
    assert.deepEqual(
      [byDay.get("2026-10-26")!.revenue_minor, byDay.get("2026-10-26")!.orders, byDay.get("2026-10-26")!.paid_orders],
      [0, 1, 1],
    );
    // o1/o2/o7 completed Tue 11-03 → week Mon 11-02.
    assert.deepEqual(
      [byDay.get("2026-11-02")!.revenue_minor, byDay.get("2026-11-02")!.orders, byDay.get("2026-11-02")!.paid_orders],
      [210000, 5, 3],
    );
    // o4 completed Tue 11-10 → week Mon 11-09.
    assert.deepEqual(
      [byDay.get("2026-11-09")!.revenue_minor, byDay.get("2026-11-09")!.orders, byDay.get("2026-11-09")!.paid_orders],
      [70000, 1, 1],
    );
  });

  it("threshold — 92-day span is daily, 93-day span is weekly", () => {
    const daily = base({ range: { from: "2026-11-01", to: "2027-01-31" } });
    assert.equal(daily.revenue_series.length, 92);
    assert.equal(daily.revenue_series[0]!.day, "2026-11-01");
    assert.equal(daily.revenue_series[91]!.day, "2027-01-31");
    const weekly = base({ range: { from: "2026-11-01", to: "2027-02-01" } });
    assert.equal(weekly.revenue_series.length, 15);
    assert.equal(weekly.revenue_series[0]!.day, "2026-10-26");
    assert.equal(weekly.revenue_series[14]!.day, "2027-02-01");
  });

  it("filters combine with AND", () => {
    const byProductB = base({ productId: prodB.id });
    // o3, o4, o7 (any-item match counts o7 in full, 60000).
    assert.equal(byProductB.totals.verified_revenue_minor, 130000);
    assert.equal(byProductB.totals.total_orders, 3);
    assert.equal(byProductB.totals.paid_orders, 2);
    assert.equal(byProductB.totals.upcoming_renewals, 1);
    assert.equal(byProductB.totals.total_customers, 2); // global, never scoped

    const narrow = base({
      productId: prodB.id,
      paymentStatus: "paid",
      source: "api",
    });
    assert.equal(narrow.totals.verified_revenue_minor, 70000);
    assert.equal(narrow.totals.total_orders, 1);
    assert.equal(narrow.totals.paid_orders, 1);
    assert.deepEqual(narrow.payment_method_distribution.map((r) => r.payment_method_id), [method2.id]);

    const unpaid = base({ paymentStatus: "unpaid" });
    assert.equal(unpaid.totals.verified_revenue_minor, 0);
    assert.equal(unpaid.totals.total_orders, 1);
    assert.equal(unpaid.totals.paid_orders, 0);
    assert.deepEqual(unpaid.payment_method_distribution, []);

    const website = base({ source: "website" });
    assert.equal(website.totals.verified_revenue_minor, 50000);
    assert.equal(website.totals.total_orders, 1);

    const paused = base({ subscriptionStatus: "paused" });
    assert.equal(paused.totals.upcoming_renewals, 0);
    assert.deepEqual(paused.upcoming_renewals_list, []);

    const scopedRange = base({
      productId: prodA.id,
      range: { from: "2026-11-01", to: "2026-11-03" },
    });
    assert.equal(scopedRange.totals.verified_revenue_minor, 210000);
    assert.equal(scopedRange.totals.total_orders, 5);
    assert.equal(scopedRange.totals.paid_orders, 4);
  });

  it("gating — money is null, never 0, without payments.read", () => {
    const d = base({ canSeeMoney: false });
    assert.equal(d.totals.verified_revenue_minor, null);
    assert.equal(d.totals.total_orders, null);
    assert.equal(d.totals.paid_orders, null);
    assert.equal(d.totals.upcoming_renewals, 2); // a count, not money
    assert.equal(d.totals.total_customers, 2);
    assert.ok(d.revenue_series.every((p) => p.revenue_minor === null));
    // F-02: series counts are finance data too — null, never 0, so a
    // gated caller sees no daily order volume in the charts.
    assert.ok(
      d.revenue_series.every((p) => p.orders === null && p.paid_orders === null),
    );
    assert.ok(d.payment_method_distribution.length > 0);
    assert.ok(d.payment_method_distribution.every((r) => r.revenue_minor === null));
    assert.ok(
      d.payment_method_distribution.every((r) => r.orders === null),
    );
    assert.ok(d.upcoming_renewals_list.every((r) => r.amount_minor === null));
    // Renewal dates/counts and filter options are NOT finance data —
    // they stay visible to a gated caller.
    assert.equal(d.upcoming_renewals_list.length, 2);
    assert.equal(d.upcoming_renewals_list[0]!.renewal_date_display, "30/11/2026");
    assert.deepEqual(
      d.filter_options.products.map((p) => p.code),
      ["ALPHA", "BETA"],
    );
  });

  it("gating — bounded range: counts null when gated, numbers when not", () => {
    const gated = base({
      range: { from: "2026-11-01", to: "2026-11-03" },
      canSeeMoney: false,
    });
    assert.equal(gated.revenue_series.length, 3);
    assert.ok(
      gated.revenue_series.every(
        (p) => p.revenue_minor === null && p.orders === null && p.paid_orders === null,
      ),
    );
    assert.ok(gated.payment_method_distribution.length > 0);
    assert.ok(
      gated.payment_method_distribution.every(
        (r) => r.revenue_minor === null && r.orders === null,
      ),
    );
    const ungated = base({
      range: { from: "2026-11-01", to: "2026-11-03" },
      canSeeMoney: true,
    });
    assert.equal(ungated.revenue_series[2]!.orders, 4);
    assert.equal(ungated.revenue_series[2]!.paid_orders, 2);
    assert.equal(
      ungated.payment_method_distribution.find(
        (r) => r.payment_method_id === method1.id,
      )!.orders,
      2,
    );
  });

  it("invalid filters → 400 VALIDATION_ERROR", () => {
    assert.throws(() => base({ paymentStatus: "bogus" }), isValidationError);
    assert.throws(() => base({ subscriptionStatus: "bogus" }), isValidationError);
    assert.throws(() => base({ source: "bogus" }), isValidationError);
    assert.throws(() => base({ productId: randomUUID() }), isValidationError);
  });

  it("empty store — empty series, no data at all", () => {
    const empty = new StackMateDataStore();
    const d = computeDashboard(empty.state, {
      range: null,
      currencyCode: "BDT",
      timeZone: TIME_ZONE,
      todayDay: TODAY,
      canSeeMoney: true,
    });
    assert.deepEqual(d.revenue_series, []);
    assert.deepEqual(d.payment_method_distribution, []);
    assert.deepEqual(d.upcoming_renewals_list, []);
    assert.equal(d.totals.total_customers, 0);
    assert.equal(d.totals.verified_revenue_minor, 0);
    assert.equal(d.totals.total_orders, 0);
    assert.deepEqual(d.filter_options.products, []);
    assert.deepEqual(d.filter_options.payment_methods, []);
  });
});

describe("dashboard analytics — renewals top-10 + sort", () => {
  it("caps at 10, sorted by next_renewal_at asc, count uncapped", () => {
    const store = new StackMateDataStore();
    const s = store.state;
    const product = seedProduct(s, { name: "Alpha Product" });
    const customer = seedCustomer(s, { name: "Customer One" });
    for (let i = 0; i < 12; i++) {
      // Renewals 29/11, 30/11, then 01/12..10/12.
      const dom = 29 + i <= 30 ? 29 + i : 29 + i - 30;
      const month = 29 + i <= 30 ? "11" : "12";
      seedSubscription(s, {
        customer_id: customer.id,
        product_id: product.id,
        status: "active",
        next_renewal_at: `2026-${month}-${String(dom).padStart(2, "0")}T10:00:00.000Z`,
        unit_amount_minor: 10000 + i,
      });
    }
    const d = computeDashboard(store.state, {
      range: null,
      currencyCode: "BDT",
      timeZone: TIME_ZONE,
      todayDay: TODAY,
      canSeeMoney: true,
    });
    assert.equal(d.totals.upcoming_renewals, 12);
    assert.equal(d.upcoming_renewals_list.length, 10);
    assert.equal(d.upcoming_renewals_list[0]!.renewal_date_display, "29/11/2026");
    assert.equal(d.upcoming_renewals_list[9]!.renewal_date_display, "08/12/2026");
    const dates = d.upcoming_renewals_list.map((r) => r.next_renewal_at);
    assert.deepEqual(dates, [...dates].sort());
  });
});

describe("dashboard analytics — Dhaka day boundary", () => {
  it("17:59:59Z is 16/11 in Dhaka, 18:00:00Z is 17/11", () => {
    const store = new StackMateDataStore();
    const s = store.state;
    const product = seedProduct(s, { name: "Alpha Product" });
    const customer = seedCustomer(s, { name: "Customer One" });
    seedOrder(s, customer.id, product, {
      payment_status: "paid",
      created_at: "2026-11-16T17:59:59.000Z",
      completed_at: "2026-11-16T17:59:59.000Z",
      total_minor: 30000,
      subtotal_minor: 30000,
    });
    seedOrder(s, customer.id, product, {
      payment_status: "paid",
      created_at: "2026-11-16T18:00:00.000Z",
      completed_at: "2026-11-16T18:00:00.000Z",
      total_minor: 40000,
      subtotal_minor: 40000,
    });
    const input = {
      currencyCode: "BDT",
      timeZone: TIME_ZONE,
      todayDay: TODAY,
      canSeeMoney: true,
    } as const;
    const day16 = computeDashboard(store.state, {
      ...input,
      range: { from: "2026-11-16", to: "2026-11-16" },
    });
    assert.equal(day16.totals.verified_revenue_minor, 30000);
    assert.equal(day16.totals.total_orders, 1);
    const day17 = computeDashboard(store.state, {
      ...input,
      range: { from: "2026-11-17", to: "2026-11-17" },
    });
    assert.equal(day17.totals.verified_revenue_minor, 40000);
    assert.equal(day17.totals.total_orders, 1);
  });
});

describe("dashboard analytics — route (Hono, in-memory store)", () => {
  const TEST_SETUP_TOKEN =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let superCookie = "";

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(new Request(`http://localhost:8787${path}`, init), env);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  function sessionCookieFromHeaders(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    const pair = setCookies.find((c) => c.startsWith("stackmate_session="));
    assert.ok(pair, "sign-in must set a stackmate_session cookie");
    return pair!.split(";")[0]!;
  }

  beforeAll(async () => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    app = createStackMateApp(store);
    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Dashboard Admin",
        email: "dashboard-admin@stackmate.local",
        password: "DashboardSuperPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signin = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "dashboard-admin@stackmate.local", password: "DashboardSuperPass123!" },
    });
    assert.equal(signin.status, 200, JSON.stringify(signin.body));
    superCookie = sessionCookieFromHeaders(signin.headers);

    // Seed after sign-in: the route reads the same injected store.
    const s = store.state;
    const product = seedProduct(s, { name: "Alpha Product", code: "ALPHA" });
    const customer = seedCustomer(s, { name: "Customer One" });
    const method = seedPaymentMethod(s);
    seedOrder(s, customer.id, product, {
      payment_status: "paid",
      created_at: DAY,
      completed_at: DAY,
      total_minor: 100000,
      subtotal_minor: 100000,
      source: "admin",
      payment_method_id: method.id,
    });
    seedSubscription(s, {
      customer_id: customer.id,
      product_id: product.id,
      status: "active",
      // Due in 2 days from the real today — the route uses the real clock.
      next_renewal_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      unit_amount_minor: 100000,
    });
  });

  it("GET dashboard → 200 + success envelope shape", async () => {
    const res = await apiRequest("/api/v1/admin/analytics/dashboard", {
      cookie: superCookie,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(typeof res.body.meta?.request_id, "string");
    const d = res.body.data;
    assert.equal(d.currency_code, "BDT");
    assert.equal(d.range, null);
    assert.deepEqual(d.filters, {
      product_id: null,
      payment_status: null,
      subscription_status: null,
      source: null,
    });
    assert.equal(d.totals.total_customers, 1);
    assert.equal(d.totals.verified_revenue_minor, 100000);
    assert.equal(d.totals.total_orders, 1);
    assert.equal(d.totals.paid_orders, 1);
    assert.equal(d.totals.upcoming_renewals, 1);
    assert.ok(Array.isArray(d.revenue_series));
    const nov3 = d.revenue_series.find((p: any) => p.day === "2026-11-03");
    assert.ok(nov3, "series must contain the 2026-11-03 bucket");
    assert.equal(nov3.revenue_minor, 100000);
    assert.equal(nov3.orders, 1);
    assert.equal(d.payment_method_distribution.length, 1);
    assert.equal(d.payment_method_distribution[0].revenue_minor, 100000);
    assert.equal(d.upcoming_renewals_list.length, 1);
    assert.match(
      d.upcoming_renewals_list[0].renewal_date_display,
      /^\d{2}\/\d{2}\/\d{4}$/,
    );
    assert.equal(d.filter_options.products.length, 1);
    assert.equal(d.filter_options.payment_methods.length, 1);
  });

  it("GET dashboard with a range + product filter → 200, range echoed", async () => {
    const productId = store.state.products[0]!.id;
    const res = await apiRequest(
      `/api/v1/admin/analytics/dashboard?from=2026-11-01&to=2026-11-30&productId=${productId}`,
      { cookie: superCookie },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.range, { from: "2026-11-01", to: "2026-11-30" });
    assert.equal(res.body.data.filters.product_id, productId);
    assert.equal(res.body.data.revenue_series.length, 30);
    assert.equal(res.body.data.totals.verified_revenue_minor, 100000);
  });

  it("bad enum / unknown productId / bad range → 400 VALIDATION_ERROR", async () => {
    const cases = [
      "/api/v1/admin/analytics/dashboard?paymentStatus=bogus",
      "/api/v1/admin/analytics/dashboard?subscriptionStatus=bogus",
      "/api/v1/admin/analytics/dashboard?source=bogus",
      `/api/v1/admin/analytics/dashboard?productId=${randomUUID()}`,
      "/api/v1/admin/analytics/dashboard?from=2026-13-01&to=2026-11-17",
      "/api/v1/admin/analytics/dashboard?from=2026-11-01",
    ];
    for (const path of cases) {
      const res = await apiRequest(path, { cookie: superCookie });
      assert.equal(res.status, 400, `${path}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, "VALIDATION_ERROR", path);
    }
  });

  it("unauthenticated → 401", async () => {
    const res = await apiRequest("/api/v1/admin/analytics/dashboard");
    assert.equal(res.status, 401, JSON.stringify(res.body));
  });
});
