/**
 * Dashboard — Operational Overview (reference section implementation).
 *
 * Shows the analytics overview DTO as KPI cards (spec §4.3, API spec
 * §10.8). Date filter (PLAN §23, owner 2026-11-17): presets + custom
 * range, persisted in the URL (?range=today|7d|30d|month|all, custom
 * ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD). The range scopes the
 * flow metrics (verified revenue, total orders, paid orders); product,
 * subscription, licence and queue counts are current-state snapshots —
 * see the help text behind the (i) button.
 */
import { useState, type FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { apiRequest } from "../lib/api-client";
import {
  DASHBOARD_PRESETS,
  ddmmyyyyToIso,
  formatRangeLabel,
  isoToDdmmyyyy,
  normalizeDateInput,
  normalizePastedDate,
  presetRange,
  type DashboardPreset,
} from "../lib/dates";
import { PageHeader } from "../lib/section-kit";
import { Button, Dialog, ErrorState, Field, MoneyCell, Skeleton } from "../components/primitives";

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
  range: { from: string; to: string } | null;
}

type DashboardRange =
  | { kind: "preset"; preset: DashboardPreset }
  | { kind: "custom"; from: string; to: string };

/** Server cap, mirrored client-side (overview-range.ts). */
const MAX_RANGE_DAYS = 366;

function parseRangeFromSearch(search: Record<string, unknown>): DashboardRange {
  const rawRange = typeof search.range === "string" ? search.range : "all";
  if (rawRange === "custom") {
    const from = typeof search.from === "string" ? search.from : "";
    const to = typeof search.to === "string" ? search.to : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to) {
      return { kind: "custom", from, to };
    }
    return { kind: "preset", preset: "all" };
  }
  const preset = DASHBOARD_PRESETS.some((p) => p.key === rawRange)
    ? (rawRange as DashboardPreset)
    : "all";
  return { kind: "preset", preset };
}

function rangeToBounds(range: DashboardRange): { from: string; to: string } | null {
  if (range.kind === "custom") return { from: range.from, to: range.to };
  return presetRange(range.preset);
}

function rangeToSearch(range: DashboardRange): Record<string, unknown> {
  if (range.kind === "custom") return { range: "custom", from: range.from, to: range.to };
  return { range: range.preset };
}

function rangeSpanDays(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const fromMs = Date.UTC(fy!, fm! - 1, fd!);
  const toMs = Date.UTC(ty!, tm! - 1, td!);
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

export function DashboardSection() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const range = parseRangeFromSearch(rawSearch);
  const bounds = rangeToBounds(range);
  const [customOpen, setCustomOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  const applyRange = (next: DashboardRange) => {
    void navigate({ search: rangeToSearch(next) } as never);
  };

  const query = useQuery({
    queryKey: [
      "admin",
      "overview",
      range.kind === "custom" ? `custom:${bounds?.from}..${bounds?.to}` : range.preset,
    ],
    queryFn: () =>
      apiRequest<AnalyticsOverviewDto>(
        `/api/v1/admin/analytics/overview${
          bounds ? `?from=${bounds.from}&to=${bounds.to}` : ""
        }`,
      ),
    placeholderData: keepPreviousData,
  });

  const openCustom = () => {
    // Pre-fill with the current range (or the last 30 days when All time).
    const current = bounds ?? presetRange("30d");
    setCustomFrom(current ? isoToDdmmyyyy(current.from) : "");
    setCustomTo(current ? isoToDdmmyyyy(current.to) : "");
    setCustomError(null);
    setCustomOpen(true);
  };

  const submitCustom = (e: FormEvent) => {
    e.preventDefault();
    const fromIso = ddmmyyyyToIso(customFrom);
    const toIso = ddmmyyyyToIso(customTo);
    if (!fromIso || !toIso) {
      setCustomError("Use DD/MM/YYYY for both dates.");
      return;
    }
    if (fromIso > toIso) {
      setCustomError("The start date must not be after the end date.");
      return;
    }
    if (rangeSpanDays(fromIso, toIso) > MAX_RANGE_DAYS) {
      setCustomError(`The range must not exceed ${MAX_RANGE_DAYS} days.`);
      return;
    }
    setCustomOpen(false);
    applyRange({ kind: "custom", from: fromIso, to: toIso });
  };

  const isActivePreset = (preset: DashboardPreset) =>
    range.kind === "preset" && range.preset === preset;

  return (
    <section aria-labelledby="dash-heading">
      <PageHeader
        breadcrumb={[{ label: "Dashboard" }]}
        title="Operational Overview"
        help="Revenue, orders and paid orders reflect the selected period; product, subscription, licence and queue counts are current totals."
      />
      <div className="sm-filter-row" role="group" aria-label="Date range">
        {DASHBOARD_PRESETS.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant={isActivePreset(p.key) ? "accent" : "secondary"}
            aria-pressed={isActivePreset(p.key)}
            disabled={query.isFetching}
            onClick={() => applyRange({ kind: "preset", preset: p.key })}
          >
            {p.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant={range.kind === "custom" ? "accent" : "secondary"}
          aria-pressed={range.kind === "custom"}
          disabled={query.isFetching}
          onClick={openCustom}
        >
          Custom
        </Button>
        <span className="sm-filter-label" aria-live="polite">
          {formatRangeLabel(bounds)}
        </span>
      </div>
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
        <>
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
          {bounds !== null &&
            query.data.total_orders === 0 &&
            query.data.verified_revenue_minor === 0 && (
              <p className="sm-hint">No activity in this period.</p>
            )}
        </>
      ) : null}
      {customOpen && (
        <Dialog
          open
          onClose={() => setCustomOpen(false)}
          title="Custom date range"
          size="sm"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setCustomOpen(false);
                  applyRange({ kind: "preset", preset: "all" });
                }}
              >
                Clear
              </Button>
              <Button variant="accent" type="submit" form="custom-range-form">
                Apply
              </Button>
            </>
          }
        >
          <form id="custom-range-form" onSubmit={submitCustom}>
            <Field label="From" required hint="DD/MM/YYYY." error={customError ?? ""}>
              <input
                className="sm-input"
                value={customFrom}
                onChange={(e) => setCustomFrom(normalizeDateInput(e.target.value))}
                onPaste={(e) => {
                  e.preventDefault();
                  setCustomFrom(normalizePastedDate(e.clipboardData.getData("text")));
                }}
                placeholder="DD/MM/YYYY"
                inputMode="numeric"
                autoComplete="off"
              />
            </Field>
            <Field label="To" required hint="DD/MM/YYYY." error="">
              <input
                className="sm-input"
                value={customTo}
                onChange={(e) => setCustomTo(normalizeDateInput(e.target.value))}
                onPaste={(e) => {
                  e.preventDefault();
                  setCustomTo(normalizePastedDate(e.clipboardData.getData("text")));
                }}
                placeholder="DD/MM/YYYY"
                inputMode="numeric"
                autoComplete="off"
              />
            </Field>
          </form>
        </Dialog>
      )}
    </section>
  );
}
