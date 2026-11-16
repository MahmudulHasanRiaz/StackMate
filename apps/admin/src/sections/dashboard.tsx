/**
 * Dashboard — Operational Overview (reference section implementation).
 *
 * Shows the analytics overview DTO as KPI cards (spec §4.3). Dashboard
 * charts / date ranges are an OWNER DECISION (pending) — this section
 * ships KPIs first, including the two counts the old dashboard hid
 * (expired/revoked licenses, pending outbox events).
 */
import { useQuery } from "@tanstack/react-query";
import { CircleDashed } from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { PageHeader } from "../lib/section-kit";
import { ErrorState, MoneyCell, Skeleton } from "../components/primitives";

interface AnalyticsOverviewDto {
  currency_code: string;
  total_products: number;
  active_products: number;
  total_customers: number;
  total_orders: number;
  paid_orders: number;
  pending_payment_submissions: number;
  active_subscriptions: number;
  active_licenses: number;
  expired_or_revoked_licenses: number;
  verified_revenue_minor: number;
  pending_outbox_events: number;
}

export function DashboardSection() {
  const query = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () =>
      apiRequest<AnalyticsOverviewDto>("/api/v1/admin/analytics/overview"),
  });

  return (
    <section aria-labelledby="dash-heading">
      <PageHeader
        breadcrumb={[{ label: "Dashboard" }]}
        title="Operational Overview"
        help="Verified revenue and operational counts"
      />
      {query.isPending ? (
        <div className="sm-kpi-grid">
          {Array.from({ length: 6 }).map((_, i) => (
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
            message={
              query.error instanceof Error ? query.error.message : "Could not load the overview"
            }
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : query.data ? (
        <div className="sm-kpi-grid">
          <div className="sm-kpi-card">
            <div className="sm-label">Verified revenue</div>
            <div className="sm-kpi-value" style={{ marginTop: 6 }}>
              <MoneyCell
                currency={query.data.currency_code}
                minor={query.data.verified_revenue_minor}
              />
            </div>
          </div>
          <div className="sm-kpi-card">
            <div className="sm-label">Pending payment review</div>
            <div className="sm-kpi-value" style={{ marginTop: 6 }}>
              {query.data.pending_payment_submissions}
            </div>
          </div>
          <div className="sm-kpi-card">
            <div className="sm-label">Active products</div>
            <div className="sm-kpi-value" style={{ marginTop: 6 }}>
              {query.data.active_products} / {query.data.total_products}
            </div>
          </div>
          <div className="sm-kpi-card">
            <div className="sm-label">Paid orders</div>
            <div className="sm-kpi-value" style={{ marginTop: 6 }}>
              {query.data.paid_orders} / {query.data.total_orders}
            </div>
          </div>
          <div className="sm-kpi-card">
            <div className="sm-label">Active subscriptions</div>
            <div className="sm-kpi-value" style={{ marginTop: 6 }}>
              {query.data.active_subscriptions}
            </div>
          </div>
          <div className="sm-kpi-card">
            <div className="sm-label">Active licenses</div>
            <div className="sm-kpi-value" style={{ marginTop: 6 }}>
              {query.data.active_licenses}
            </div>
          </div>
          <div className="sm-kpi-card">
            {/* F8 (2026-11-16): "Expired / revoked licenses" wrapped to two
                lines while the other seven labels fit one — dropped the
                spaces around the slash (same words, same meaning) and the
                grid min rose 190px -> 200px. Font size untouched. */}
            <div className="sm-label">Expired/revoked licenses</div>
            <div className="sm-kpi-value" style={{ marginTop: 6 }}>
              {query.data.expired_or_revoked_licenses}
            </div>
          </div>
          <div className="sm-kpi-card">
            <div className="sm-label">Pending outbox events</div>
            <div className="sm-kpi-value" style={{ marginTop: 6 }}>
              {query.data.pending_outbox_events}
            </div>
          </div>
        </div>
      ) : null}
      <p className="sm-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <CircleDashed size={14} strokeWidth={2} />
        Dashboard charts and date ranges are pending an owner decision — KPIs
        only for now.
      </p>
    </section>
  );
}
