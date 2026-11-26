/**
 * Profit & Loss — analytics report (Expense Module, 2026-11-25).
 *
 * Route (registered in router.tsx, under the _main shell):
 * /analytics/profit-loss — main-menu Finance group (shell.tsx).
 *
 * KPI cards (Total Sales, Total Expenses, Net P&L) reuse the
 * dashboard's KpiCard pattern — ONE green (#00E599) in varied tints,
 * never a second hue; the "bad" number (expenses) stays neutral grey,
 * like the dashboard's expired-licences card. Below: expenses by
 * category, sales/expenses/net by product, and the daily trend.
 *
 * TREND DECISION (no chart library in the repo — the dashboard, the
 * reference section, uses KPI cards + tables only, and the task
 * forbids a new chart lib): the trend is a daily table with a
 * lightweight CSS net bar per row (green tint, width relative to the
 * largest absolute net in the range). No invented chart, no new
 * dependency; if the owner wants a real chart later it is a separate
 * decision with a library choice.
 *
 * Filters are URL-persisted (from, to, productId) and reuse the
 * expenses DateRangeFilter (presets + custom dialog) and the
 * server-side product SearchableSelect.
 *
 * Endpoint used (contract; API worker builds it in parallel):
 *  - GET /api/v1/admin/analytics/profit-loss[?from=&to=&productId=]
 *    → { range, productId, sales: { totalMinor, orderCount },
 *        expenses: { totalMinor, count }, netMinor,
 *        byCategory[], byProduct[],
 *        trend: [{ date, salesMinor, expensesMinor, netMinor }] }
 * See lib/api-client.ts for the camelCase/snake_case casing shim.
 */
import { useMemo, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Banknote, ChartNoAxesCombined, Receipt, Scale, type LucideIcon } from "lucide-react";
import { fetchProfitLoss } from "../lib/api-client";
import { isoToDdmmyyyy } from "../lib/dates";
import { PageHeader } from "../lib/section-kit";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  MoneyCell,
  SearchableSelect,
  Skeleton,
} from "../components/primitives";
import { DateRangeFilter, loadProductOptions, resolveProductLabel } from "./expenses";

const EXPENSE_CURRENCY = "BDT";

/* ------------------------------------------------------------------ */
/* KPI card — dashboard.tsx KpiCard, same classes and tint ladder.     */
/* ------------------------------------------------------------------ */
type KpiTone = "hero" | "strong" | "mid" | "soft" | "plain" | "muted";

function KpiCard({
  label,
  icon: Icon,
  tone,
  children,
  sub,
}: {
  label: string;
  icon: LucideIcon;
  tone: KpiTone;
  children: ReactNode;
  sub?: string;
}) {
  return (
    <div className={`sm-kpi-card sm-kpi-tint-${tone}`}>
      <div className="sm-kpi-head">
        <div className="sm-label">{label}</div>
        <span className="sm-kpi-icon" aria-hidden="true">
          <Icon />
        </span>
      </div>
      <div className="sm-kpi-value" style={{ marginTop: 6 }}>
        {children}
      </div>
      {sub ? <div className="sm-hint" style={{ marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* URL-backed filters (from/to/productId).                             */
/* ------------------------------------------------------------------ */
function useProfitLossSearch() {
  const rawSearch = useRouterState({ select: (s) => s.location.search }) as Record<
    string,
    unknown
  >;
  const navigate = useNavigate();
  const from =
    typeof rawSearch.from === "string" && rawSearch.from !== ""
      ? (rawSearch.from as string)
      : undefined;
  const to =
    typeof rawSearch.to === "string" && rawSearch.to !== "" ? (rawSearch.to as string) : undefined;
  const productId =
    typeof rawSearch.productId === "string" && rawSearch.productId !== ""
      ? (rawSearch.productId as string)
      : undefined;
  const update = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...rawSearch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null || value === "") delete next[key];
      else next[key] = value;
    }
    (navigate as unknown as (opts: { search: Record<string, unknown> }) => void)({
      search: next,
    });
  };
  return { from, to, productId, update };
}

/* ------------------------------------------------------------------ */
/* Profit & Loss — report                                              */
/* ------------------------------------------------------------------ */
export function ProfitLossSection() {
  const { from, to, productId, update } = useProfitLossSearch();

  const query = useQuery({
    queryKey: ["admin", "profit-loss", { from: from ?? "", to: to ?? "", productId: productId ?? "" }],
    queryFn: () => fetchProfitLoss({ from, to, productId }),
    placeholderData: keepPreviousData,
  });

  const report = query.data;
  const maxAbsNet = useMemo(() => {
    const values = (report?.trend ?? []).map((p) => Math.abs(p.netMinor));
    return values.length > 0 ? Math.max(...values) : 0;
  }, [report]);

  return (
    <section aria-labelledby="profit-loss-heading">
      <PageHeader
        breadcrumb={[{ label: "Finance" }, { label: "Profit & Loss" }]}
        title="Profit & Loss"
        help="Sales minus expenses for the selected period. Sales come from orders; expenses from recorded expenses. Pick a product to see its own P&L."
      />
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "flex-start",
          marginBottom: 16,
        }}
      >
        <DateRangeFilter
          from={from}
          to={to}
          onApply={(range) =>
            update(range === null ? { from: undefined, to: undefined } : range)
          }
        />
        <span style={{ display: "inline-block", width: 240 }}>
          <SearchableSelect
            value={productId ?? ""}
            onChange={(v) => update({ productId: v || undefined })}
            loadOptions={loadProductOptions}
            resolveLabel={resolveProductLabel}
            leadingOptions={[{ value: "", label: "All products" }]}
            placeholder="All products"
            ariaLabel="Filter by product"
          />
        </span>
      </div>

      {query.isPending ? (
        <div className="sm-kpi-grid">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="sm-kpi-card">
              <Skeleton height={14} width="60%" />
              <div style={{ marginTop: 10 }}>
                <Skeleton height={24} width="40%" />
              </div>
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <div className="sm-table-wrap">
          <ErrorState
            message={query.error instanceof Error ? query.error.message : "Could not load the report"}
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : report ? (
        <>
          <div className="sm-kpi-grid">
            <KpiCard label="Total sales" icon={Banknote} tone="strong" sub={`${report.sales.orderCount} order${report.sales.orderCount === 1 ? "" : "s"}`}>
              <MoneyCell currency={EXPENSE_CURRENCY} minor={report.sales.totalMinor} />
            </KpiCard>
            <KpiCard label="Total expenses" icon={Receipt} tone="muted" sub={`${report.expenses.count} expense${report.expenses.count === 1 ? "" : "s"}`}>
              <MoneyCell currency={EXPENSE_CURRENCY} minor={report.expenses.totalMinor} />
            </KpiCard>
            <KpiCard label="Net profit & loss" icon={Scale} tone="hero" sub={report.netMinor >= 0 ? "Profit" : "Loss"}>
              <MoneyCell currency={EXPENSE_CURRENCY} minor={report.netMinor} />
            </KpiCard>
          </div>

          <div className="sm-grid-2" style={{ marginTop: 16 }}>
            <Card title="Expenses by category">
              {report.byCategory.length === 0 ? (
                <p className="sm-hint">No expenses in this period.</p>
              ) : (
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Expenses</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byCategory.map((row) => {
                      const share =
                        report.expenses.totalMinor > 0
                          ? (row.totalMinor / report.expenses.totalMinor) * 100
                          : 0;
                      return (
                        <tr key={row.categoryId}>
                          <td>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                              <span
                                aria-hidden="true"
                                style={{
                                  display: "inline-block",
                                  width: 10,
                                  height: 10,
                                  borderRadius: "50%",
                                  backgroundColor: row.color ?? "#64748B",
                                  flexShrink: 0,
                                }}
                              />
                              {row.categoryName}
                            </span>
                          </td>
                          <td>
                            <MoneyCell currency={EXPENSE_CURRENCY} minor={row.totalMinor} />
                            <span className="sm-hint"> · {row.count}</span>
                            {row.ownTotalMinor !== undefined &&
                              row.ownTotalMinor < row.totalMinor && (
                                <span className="sm-hint">
                                  {" "}
                                  · own{" "}
                                  <MoneyCell
                                    currency={EXPENSE_CURRENCY}
                                    minor={row.ownTotalMinor}
                                  />
                                </span>
                              )}
                          </td>
                          <td>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "100%" }}>
                              <span
                                aria-hidden="true"
                                style={{
                                  display: "inline-block",
                                  width: 80,
                                  height: 8,
                                  borderRadius: 4,
                                  backgroundColor: "#00e5991a",
                                  overflow: "hidden",
                                  flexShrink: 0,
                                }}
                              >
                                <span
                                  style={{
                                    display: "block",
                                    height: "100%",
                                    width: `${Math.min(100, share)}%`,
                                    backgroundColor: "#00E599",
                                    borderRadius: 4,
                                  }}
                                />
                              </span>
                              <span className="sm-tabular">{share.toFixed(1)}%</span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="By product">
              {report.byProduct.length === 0 ? (
                <p className="sm-hint">
                  {productId
                    ? "By-product breakdown is hidden when a single product is selected."
                    : "No sales or expenses by product in this period."}
                </p>
              ) : (
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Sales</th>
                      <th>Expenses</th>
                      <th>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byProduct.map((row) => (
                      <tr key={row.productId}>
                        <td>{row.productName}</td>
                        <td>
                          <MoneyCell currency={EXPENSE_CURRENCY} minor={row.salesMinor} />
                        </td>
                        <td>
                          <MoneyCell currency={EXPENSE_CURRENCY} minor={row.expensesMinor} />
                        </td>
                        <td>
                          <MoneyCell currency={EXPENSE_CURRENCY} minor={row.netMinor} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <div style={{ marginTop: 16 }}>
            <Card title={`Daily trend (${report.trend.length} day${report.trend.length === 1 ? "" : "s"})`}>
              {report.trend.length === 0 ? (
                <EmptyState
                  icon={ChartNoAxesCombined}
                  title="No activity in this period"
                  body="No sales or expenses fall inside the selected range."
                />
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="sm-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Sales</th>
                        <th>Expenses</th>
                        <th>Net</th>
                        <th aria-label="Net bar">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.trend.map((point) => {
                        const width =
                          maxAbsNet > 0 ? (Math.abs(point.netMinor) / maxAbsNet) * 100 : 0;
                        return (
                          <tr key={point.date}>
                            <td>
                              <span className="sm-tabular">
                                {point.date ? isoToDdmmyyyy(point.date) : "—"}
                              </span>
                            </td>
                            <td>
                              <MoneyCell currency={EXPENSE_CURRENCY} minor={point.salesMinor} />
                            </td>
                            <td>
                              <MoneyCell currency={EXPENSE_CURRENCY} minor={point.expensesMinor} />
                            </td>
                            <td>
                              <MoneyCell currency={EXPENSE_CURRENCY} minor={point.netMinor} />
                            </td>
                            <td>
                              <span
                                aria-hidden="true"
                                style={{
                                  display: "inline-block",
                                  width: 120,
                                  height: 8,
                                  borderRadius: 4,
                                  backgroundColor:
                                    point.netMinor >= 0 ? "#00e5991a" : "#64748b33",
                                  overflow: "hidden",
                                }}
                              >
                                <span
                                  style={{
                                    display: "block",
                                    height: "100%",
                                    width: `${Math.min(100, width)}%`,
                                    backgroundColor:
                                      point.netMinor >= 0 ? "#00E599" : "#64748B",
                                    borderRadius: 4,
                                  }}
                                />
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <div style={{ marginTop: 12 }}>
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              Refresh report
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
