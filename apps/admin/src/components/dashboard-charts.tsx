/**
 * Dashboard charts (OD-07, PRD §18) — hand-rolled SVG, no new
 * dependency. Green tints only (#00E599 ladder, same tokens as the
 * KPI cards); no animation (respects reduced motion); every chart
 * carries role="img" + an aria-label summarising the data and a
 * <title> per bar for hover. Money values are null (never 0) when
 * the caller lacks payments.read — a fully-null revenue series
 * renders a "hidden for your role" hint, never ৳0.00. Order counts
 * are gated the same way (F-02): a fully-null orders series or
 * distribution renders the hint instead of bars, never 0 bars.
 */
import { formatMinorMoney } from "../lib/api-client";
import { isoToDdmmyyyy } from "../lib/dates";

export interface DashboardRevenuePoint {
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
  /** Already DD/MM/YYYY from the API. */
  renewal_date_display: string;
  amount_minor: number | null;
  currency_code: string;
}

export interface DashboardAnalyticsDto {
  currency_code: string;
  range: { from: string; to: string } | null;
  filters: {
    product_id: string | null;
    payment_status: string | null;
    subscription_status: string | null;
    source: string | null;
  };
  filter_options: {
    products: { id: string; name: string; code: string }[];
    payment_methods: { id: string; name: string }[];
  };
  totals: {
    total_customers: number;
    upcoming_renewals: number;
    verified_revenue_minor: number | null;
    total_orders: number | null;
    paid_orders: number | null;
  };
  revenue_series: DashboardRevenuePoint[];
  payment_method_distribution: DashboardPaymentMethodRow[];
  upcoming_renewals_list: DashboardRenewalRow[];
}

const CHART_W = 600;
/** Baseline y for the vertical-bar charts; labels sit below it. */
const BASE_Y = 160;
const TOP_Y = 10;
const PLOT_H = BASE_Y - TOP_Y;

/** "2026-11-28" → "28/11" for the x-axis. */
function dayLabel(day: string): string {
  return isoToDdmmyyyy(day).slice(0, 5);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/* ------------------------------------------------------------------ */
/* Revenue over time — vertical bars from revenue_series.              */
/* ------------------------------------------------------------------ */
export function RevenueChart({
  series,
  currencyCode,
}: {
  series: DashboardRevenuePoint[];
  currencyCode: string;
}) {
  if (series.length === 0) {
    return <p className="sm-hint">No revenue data in this period.</p>;
  }
  // Gated role: every point is null (never 0) — hide, don't show ৳0.00.
  if (series.every((p) => p.revenue_minor === null)) {
    return <p className="sm-hint">Revenue hidden for your role.</p>;
  }
  const values = series.map((p) => p.revenue_minor ?? 0);
  const max = Math.max(...values, 0);
  const total = values.reduce((sum, v) => sum + v, 0);
  const n = series.length;
  const slot = CHART_W / n;
  const barW = Math.max(2, Math.min(26, slot * 0.62));
  // Show at most ~8 x labels so they never collide.
  const step = Math.max(1, Math.ceil(n / 8));
  const ariaLabel =
    `Revenue over time. Total ${formatMinorMoney(total, currencyCode)} ` +
    `over ${plural(n, "day", "days")}.`;
  return (
    <div>
      <div className="sm-tabular" style={{ marginBottom: 8 }}>
        Total {formatMinorMoney(total, currencyCode)}
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} 184`}
        width="100%"
        role="img"
        aria-label={ariaLabel}
      >
        <line
          x1={0}
          y1={BASE_Y}
          x2={CHART_W}
          y2={BASE_Y}
          stroke="var(--sm-border)"
          strokeWidth={1}
        />
        {series.map((p, i) => {
          const v = p.revenue_minor ?? 0;
          const h = max > 0 ? (v / max) * PLOT_H : 0;
          const x = i * slot + (slot - barW) / 2;
          return (
            <g key={p.day}>
              <rect
                x={x}
                y={BASE_Y - h}
                width={barW}
                height={Math.max(h, v > 0 ? 1 : 0)}
                fill="var(--sm-accent-60)"
              >
                <title>
                  {`${isoToDdmmyyyy(p.day)}: ${formatMinorMoney(v, currencyCode)}`}
                </title>
              </rect>
              {i % step === 0 ? (
                <text
                  x={i * slot + slot / 2}
                  y={BASE_Y + 16}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--sm-text-muted)"
                >
                  {dayLabel(p.day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Orders over time — grouped bars: total orders (lighter tint) +      */
/* paid orders (solid green).                                          */
/* ------------------------------------------------------------------ */
export function OrdersChart({ series }: { series: DashboardRevenuePoint[] }) {
  if (series.length === 0) {
    return <p className="sm-hint">No orders in this period.</p>;
  }
  // Gated role: counts are null (never 0) — hide, don't show 0 bars.
  if (series.every((p) => p.orders === null && p.paid_orders === null)) {
    return <p className="sm-hint">Orders hidden for your role.</p>;
  }
  const max = Math.max(...series.map((p) => p.orders ?? 0), 0);
  const totalOrders = series.reduce((sum, p) => sum + (p.orders ?? 0), 0);
  const paidOrders = series.reduce((sum, p) => sum + (p.paid_orders ?? 0), 0);
  const n = series.length;
  const slot = CHART_W / n;
  const groupW = Math.min(30, slot * 0.6);
  const barW = Math.max(2, groupW / 2 - 1);
  const step = Math.max(1, Math.ceil(n / 8));
  const ariaLabel =
    `Orders over time. ${plural(totalOrders, "order", "orders")}, ` +
    `${plural(paidOrders, "paid order", "paid orders")}, over ` +
    `${plural(n, "day", "days")}.`;
  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 16,
          marginBottom: 8,
          fontSize: 12,
          color: "var(--sm-text-muted)",
        }}
        aria-hidden="true"
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              background: "var(--sm-accent-30)",
              display: "inline-block",
            }}
          />
          Total orders
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              background: "var(--sm-accent)",
              display: "inline-block",
            }}
          />
          Paid orders
        </span>
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} 184`}
        width="100%"
        role="img"
        aria-label={ariaLabel}
      >
        <line
          x1={0}
          y1={BASE_Y}
          x2={CHART_W}
          y2={BASE_Y}
          stroke="var(--sm-border)"
          strokeWidth={1}
        />
        {series.map((p, i) => {
          const groupX = i * slot + (slot - groupW) / 2;
          const totalH = max > 0 ? ((p.orders ?? 0) / max) * PLOT_H : 0;
          const paidH = max > 0 ? ((p.paid_orders ?? 0) / max) * PLOT_H : 0;
          return (
            <g key={p.day}>
              <rect
                x={groupX}
                y={BASE_Y - totalH}
                width={barW}
                height={Math.max(totalH, (p.orders ?? 0) > 0 ? 1 : 0)}
                fill="var(--sm-accent-30)"
              >
                <title>
                  {`${isoToDdmmyyyy(p.day)}: ${plural(p.orders ?? 0, "order", "orders")} total`}
                </title>
              </rect>
              <rect
                x={groupX + barW + 2}
                y={BASE_Y - paidH}
                width={barW}
                height={Math.max(paidH, (p.paid_orders ?? 0) > 0 ? 1 : 0)}
                fill="var(--sm-accent)"
              >
                <title>
                  {`${isoToDdmmyyyy(p.day)}: ${plural(p.paid_orders ?? 0, "paid order", "paid orders")}`}
                </title>
              </rect>
              {i % step === 0 ? (
                <text
                  x={i * slot + slot / 2}
                  y={BASE_Y + 16}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--sm-text-muted)"
                >
                  {dayLabel(p.day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Payment method distribution — horizontal bars, sized by revenue     */
/* when available, else by order count.                                */
/* ------------------------------------------------------------------ */
export function PaymentMethodChart({
  rows,
  currencyCode,
}: {
  rows: DashboardPaymentMethodRow[];
  currencyCode: string;
}) {
  if (rows.length === 0) {
    return <p className="sm-hint">No payments in this period.</p>;
  }
  // Gated role: both revenue and counts are null — hide, don't show
  // empty bars (a fully-null row set is not "no payments").
  if (rows.every((r) => r.revenue_minor === null && r.orders === null)) {
    return <p className="sm-hint">Payment method breakdown hidden for your role.</p>;
  }
  const revenueAvailable = rows.some((r) => r.revenue_minor !== null);
  const valueOf = (r: DashboardPaymentMethodRow) =>
    revenueAvailable ? (r.revenue_minor ?? 0) : (r.orders ?? 0);
  const labelOf = (r: DashboardPaymentMethodRow) =>
    revenueAvailable
      ? formatMinorMoney(r.revenue_minor ?? 0, currencyCode)
      : plural(r.orders ?? 0, "order", "orders");
  const nameOf = (r: DashboardPaymentMethodRow) =>
    r.payment_method_name ?? "Unknown";
  const max = Math.max(...rows.map(valueOf), 0);
  const rowH = 30;
  const labelW = 150;
  const barMaxW = 300;
  const height = rows.length * rowH + 8;
  const ariaLabel =
    "Payment method distribution. " +
    rows.map((r) => `${nameOf(r)}: ${labelOf(r)}`).join(", ") +
    ".";
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${height}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
    >
      {rows.map((r, i) => {
        const v = valueOf(r);
        const w = max > 0 ? (v / max) * barMaxW : 0;
        const y = 8 + i * rowH;
        const name = nameOf(r);
        const shown = name.length > 20 ? `${name.slice(0, 19)}…` : name;
        return (
          <g key={r.payment_method_id ?? `unknown-${i}`}>
            <text
              x={0}
              y={y + rowH / 2}
              dominantBaseline="middle"
              fontSize={12}
              fill="var(--sm-text)"
            >
              {shown}
              <title>{name}</title>
            </text>
            <rect
              x={labelW}
              y={y + 8}
              width={Math.max(w, v > 0 ? 2 : 0)}
              height={14}
              fill="var(--sm-accent-50)"
            >
              <title>{`${name}: ${labelOf(r)}`}</title>
            </rect>
            <text
              x={labelW + Math.max(w, v > 0 ? 2 : 0) + 8}
              y={y + rowH / 2}
              dominantBaseline="middle"
              fontSize={12}
              fill="var(--sm-text-muted)"
              className="sm-tabular"
            >
              {labelOf(r)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
