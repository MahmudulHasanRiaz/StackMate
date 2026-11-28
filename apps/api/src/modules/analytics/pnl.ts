/**
 * Profit & Loss analytics.
 *
 * SALES — the dashboard verified-revenue definition, reused exactly,
 * plus refund handling:
 *   dashboard (`GET /api/v1/admin/analytics/overview`, app.ts):
 *   verified_revenue = Σ total_minor over orders with
 *   payment_status === "paid" AND completed_at's Dhaka calendar day
 *   inside the range (parseOverviewRange; null range = all time, and a
 *   null range also matches a paid order with no completed_at).
 *   Pending submissions NEVER count (PRD §18).
 *   P&L keeps that base and adds two honest adjustments:
 *   (a) an order whose payment_status later flipped off "paid" by a
 *       full refund still counts its original total — the marker is
 *       completed_at (set only when the order was verified-paid and
 *       completed; a refund never clears it), so the money is not
 *       silently erased from history;
 *   (b) succeeded manual refunds (payment_refunds, status
 *       "succeeded") are SUBTRACTED in the range the refund was
 *       recorded (Dhaka day of refund.created_at).
 *   Net sales for a range = Σ completed order totals − Σ refunds.
 *   Partially-paid orders (never completed) count for nothing — same
 *   as the dashboard. One deliberate deviation from the dashboard:
 *   the dashboard sums every currency's minor units blindly; P&L is
 *   BDT-only by contract (expenses are BDT-only), so non-BDT orders
 *   are excluded.
 *
 * EXPENSES — Σ amount_minor over expenses whose expense_date is
 * inside the range (string compare on YYYY-MM-DD; null range = all).
 *
 * PRODUCT SCOPING — with ?productId=, sales are that product's share
 * of each completed order (line_total_minor proportions across the
 * order's items; a single-item order contributes its full total) and
 * refunds are allocated in the same proportion; expenses are the ones
 * with product_id = the product. byProduct is omitted when scoped
 * (the response already is that product).
 * Without a scope, byProduct covers every product that has sales
 * and/or expenses in range; an expense with no product_id counts in
 * the totals but in no byProduct row.
 *
 * TREND — one bucket per calendar day: every day of [from, to] when a
 * range is given; for all time, min..max over the sales-completed and
 * expense days actually present (empty when there is no data at all).
 */
import { isoDateOnlyInTimeZone } from "../../../../../packages/contracts/src/index.ts";
import type { DatabaseState } from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import {
  isTimestampInOverviewRange,
  type OverviewRange,
} from "./overview-range.ts";

export interface ProfitLossByCategory {
  categoryId: string;
  categoryName: string;
  /**
   * ROLL-UP total (hierarchy, migration 0026): this category's own
   * expenses PLUS every descendant's expenses. A parent row therefore
   * already contains its children's spend — the global expenses total
   * is NOT the sum of this column (that would double-count); it is
   * computed once from the expense list itself (expenses.totalMinor).
   * `ownTotalMinor` is this category's own expenses only; a child row
   * still appears separately as detail, with its own roll-up.
   */
  totalMinor: number;
  /** This category's own expenses only (excludes descendants). */
  ownTotalMinor: number;
  /** This category's own expense count (excludes descendants). */
  count: number;
}

export interface ProfitLossByProduct {
  productId: string;
  productName: string;
  salesMinor: number;
  expensesMinor: number;
  netMinor: number;
}

export interface ProfitLossTrendDay {
  date: string;
  salesMinor: number;
  expensesMinor: number;
  netMinor: number;
}

export interface ProfitLossResult {
  range: OverviewRange | null;
  productId: string | null;
  sales: { totalMinor: number; orderCount: number };
  expenses: { totalMinor: number; count: number };
  netMinor: number;
  byCategory: ProfitLossByCategory[];
  /** Omitted ([]) when a productId scope is given. */
  byProduct: ProfitLossByProduct[];
  trend: ProfitLossTrendDay[];
}

export interface ComputeProfitLossInput {
  range: OverviewRange | null;
  productId?: string | null;
  timeZone: string;
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDaysIso(day, 1)) days.push(day);
  return days;
}

export function computeProfitLoss(
  state: DatabaseState,
  input: ComputeProfitLossInput,
): ProfitLossResult {
  const { range, timeZone } = input;
  const productId = input.productId ?? null;
  if (productId) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) {
      throw new AppError("NOT_FOUND", "Product not found.", 404);
    }
  }

  const expenses = state.expenses;
  const categories = state.expense_categories;
  const categoryName = (id: string): string =>
    categories.find((c) => c.id === id)?.name ?? "Unknown category";
  const productName = (id: string): string =>
    state.products.find((p) => p.id === id)?.name ??
    "Unknown product";

  const inRangeDate = (dateIso: string): boolean =>
    range === null || (dateIso >= range.from && dateIso <= range.to);

  // -- Sales: verified-paid (completed) orders in range ----------------------
  // completed_at is the verified-paid marker (see header). Null range
  // matches every completed order, exactly like the dashboard.
  const completedOrders = state.orders.filter(
    (o) =>
      o.completed_at !== null &&
      o.currency_code === "BDT" &&
      isTimestampInOverviewRange(o.completed_at, range, timeZone),
  );

  // Product share of one order: line_total proportions. Single-item
  // orders (the common case) contribute their full total exactly.
  const productShareOfOrder = (
    order: (typeof completedOrders)[number],
    pid: string,
  ): number => {
    const items = order.items ?? [];
    const matching = items.filter((i) => i.product_id === pid);
    if (matching.length === 0) return 0;
    const lineSum = items.reduce((s, i) => s + i.line_total_minor, 0);
    if (lineSum <= 0) return order.total_minor;
    const matchSum = matching.reduce((s, i) => s + i.line_total_minor, 0);
    return Math.round((order.total_minor * matchSum) / lineSum);
  };

  const orderSales = (order: (typeof completedOrders)[number]): number =>
    productId ? productShareOfOrder(order, productId) : order.total_minor;

  const scopedOrders = productId
    ? completedOrders.filter((o) =>
        (o.items ?? []).some((i) => i.product_id === productId),
      )
    : completedOrders;
  const grossSalesMinor = scopedOrders.reduce(
    (sum, o) => sum + orderSales(o),
    0,
  );

  // -- Refunds: succeeded, recorded in range, for a completed order --------
  const refunds = Array.isArray(state.payment_refunds)
    ? state.payment_refunds
    : [];
  let refundsMinor = 0;
  const refundsByDay = new Map<string, number>();
  const refundsByProduct = new Map<string, number>();
  for (const refund of refunds) {
    if (refund.status !== "succeeded") continue;
    if (!isTimestampInOverviewRange(refund.created_at, range, timeZone)) {
      continue;
    }
    const txn = state.payment_transactions.find(
      (t) => t.id === refund.payment_transaction_id,
    );
    if (!txn) continue;
    const order = completedOrders.find((o) => o.id === txn.order_id);
    if (!order) continue;
    const share = productId
      ? order.total_minor > 0
        ? Math.round(
            (refund.amount_minor * productShareOfOrder(order, productId)) /
              order.total_minor,
          )
        : 0
      : refund.amount_minor;
    if (share <= 0) continue;
    refundsMinor += share;
    const day = isoDateOnlyInTimeZone(refund.created_at, timeZone);
    refundsByDay.set(day, (refundsByDay.get(day) ?? 0) + share);
    if (!productId) {
      // Attribute the refund to the order's products by line share.
      const items = order.items ?? [];
      const lineSum = items.reduce((s, i) => s + i.line_total_minor, 0);
      for (const item of items) {
        const itemShare =
          lineSum > 0
            ? Math.round((refund.amount_minor * item.line_total_minor) / lineSum)
            : 0;
        if (itemShare > 0) {
          refundsByProduct.set(
            item.product_id,
            (refundsByProduct.get(item.product_id) ?? 0) + itemShare,
          );
        }
      }
    }
  }

  const salesMinor = grossSalesMinor - refundsMinor;

  // -- Expenses in range ------------------------------------------------------
  const scopedExpenses = expenses.filter(
    (e) =>
      inRangeDate(e.expense_date) &&
      (productId ? e.product_id === productId : true),
  );
  const expensesMinor = scopedExpenses.reduce((s, e) => s + e.amount_minor, 0);

  // -- byCategory (roll-up, hierarchy migration 0026) -----------------------
  // Each expense counts once in its own category (ownTotalMinor /
  // count) and is additionally folded into every ANCESTOR's
  // totalMinor, so a parent row reads own + all descendants. The
  // global expenses.totalMinor above is a separate single pass over
  // the expense list, so nothing is double-counted there. The
  // ancestor walk is cycle-guarded (seen set) so corrupt stored data
  // can never loop the report.
  const ancestorIds = (categoryId: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([categoryId]);
    let current = categories.find((c) => c.id === categoryId);
    while (current?.parent_id) {
      if (seen.has(current.parent_id)) break;
      seen.add(current.parent_id);
      out.push(current.parent_id);
      current = categories.find((c) => c.id === current!.parent_id);
    }
    return out;
  };
  const byCategoryMap = new Map<
    string,
    { ownTotalMinor: number; totalMinor: number; count: number }
  >();
  const ensureRow = (categoryId: string) =>
    byCategoryMap.get(categoryId) ??
    byCategoryMap.set(categoryId, {
      ownTotalMinor: 0,
      totalMinor: 0,
      count: 0,
    }).get(categoryId)!;
  for (const e of scopedExpenses) {
    const own = ensureRow(e.category_id);
    own.ownTotalMinor += e.amount_minor;
    own.totalMinor += e.amount_minor;
    own.count += 1;
    for (const ancestorId of ancestorIds(e.category_id)) {
      ensureRow(ancestorId).totalMinor += e.amount_minor;
    }
  }
  const byCategory: ProfitLossByCategory[] = [...byCategoryMap.entries()]
    .map(([categoryId, row]) => ({
      categoryId,
      categoryName: categoryName(categoryId),
      totalMinor: row.totalMinor,
      ownTotalMinor: row.ownTotalMinor,
      count: row.count,
    }))
    .sort((a, b) => b.totalMinor - a.totalMinor || a.categoryName.localeCompare(b.categoryName));

  // -- byProduct (unscoped only) ----------------------------------------------
  let byProduct: ProfitLossByProduct[] = [];
  if (!productId) {
    const salesByProduct = new Map<string, number>();
    for (const order of completedOrders) {
      // Once per distinct product in the order — productShareOfOrder
      // already returns the product's whole share of the order.
      for (const pid of new Set((order.items ?? []).map((i) => i.product_id))) {
        salesByProduct.set(
          pid,
          (salesByProduct.get(pid) ?? 0) + productShareOfOrder(order, pid),
        );
      }
    }
    const expensesByProduct = new Map<string, number>();
    for (const e of scopedExpenses) {
      if (!e.product_id) continue;
      expensesByProduct.set(
        e.product_id,
        (expensesByProduct.get(e.product_id) ?? 0) + e.amount_minor,
      );
    }
    const productIds = new Set([
      ...salesByProduct.keys(),
      ...expensesByProduct.keys(),
    ]);
    byProduct = [...productIds]
      .map((pid) => {
        // Refunds reduce SALES (they are money handed back), never
        // expenses — same as the top-level totals.
        const sales = (salesByProduct.get(pid) ?? 0) - (refundsByProduct.get(pid) ?? 0);
        const exp = expensesByProduct.get(pid) ?? 0;
        return {
          productId: pid,
          productName: productName(pid),
          salesMinor: sales,
          expensesMinor: exp,
          netMinor: sales - exp,
        };
      })
      .sort((a, b) => b.netMinor - a.netMinor || a.productName.localeCompare(b.productName));
  }

  // -- Trend (daily) ------------------------------------------------------------
  const salesByDay = new Map<string, number>();
  for (const order of scopedOrders) {
    const day = isoDateOnlyInTimeZone(order.completed_at!, timeZone);
    salesByDay.set(day, (salesByDay.get(day) ?? 0) + orderSales(order));
  }
  const expensesByDay = new Map<string, number>();
  for (const e of scopedExpenses) {
    expensesByDay.set(
      e.expense_date,
      (expensesByDay.get(e.expense_date) ?? 0) + e.amount_minor,
    );
  }
  let trendDays: string[];
  if (range !== null) {
    trendDays = eachDay(range.from, range.to);
  } else {
    const allDays = [...salesByDay.keys(), ...expensesByDay.keys()].sort();
    trendDays =
      allDays.length === 0 ? [] : eachDay(allDays[0]!, allDays[allDays.length - 1]!);
  }
  const trend: ProfitLossTrendDay[] = trendDays.map((date) => {
    const sales = (salesByDay.get(date) ?? 0) - (refundsByDay.get(date) ?? 0);
    const exp = expensesByDay.get(date) ?? 0;
    return { date, salesMinor: sales, expensesMinor: exp, netMinor: sales - exp };
  });

  return {
    range,
    productId,
    sales: { totalMinor: salesMinor, orderCount: scopedOrders.length },
    expenses: { totalMinor: expensesMinor, count: scopedExpenses.length },
    netMinor: salesMinor - expensesMinor,
    byCategory,
    byProduct,
    trend,
  };
}
