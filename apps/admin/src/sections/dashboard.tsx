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
 *
 * Redesign (2026-11-18, owner go-ahead): KPI cards carry a single
 * green (#00E599, Neon) in varied tints — never a second hue — plus two
 * genuinely useful report panels below (Recent orders, Needs attention),
 * built from the existing list endpoints only. No fake data: every
 * number comes from a real endpoint; empty states stay empty.
 */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Banknote,
  Clock,
  KeyRound,
  Package,
  Receipt,
  Repeat,
  Send,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { isoDateOnlyInTimeZone } from "../../../../packages/contracts/src/index.ts";
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
import {
  Button,
  Dialog,
  ErrorState,
  Field,
  MoneyCell,
  Skeleton,
  StatusBadge,
} from "../components/primitives";

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
  verified_revenue_minor: number | null;
  pending_outbox_events: number;
  range: { from: string; to: string } | null;
}

/** Minimal rows for the report panels (existing list endpoints only). */
interface DashboardOrderRow {
  id: string;
  order_number: string;
  payment_status: string;
  currency_code: string;
  total_minor: number;
  created_at: string;
  customer: { id: string; customer_number: string; name: string } | null;
}

interface DashboardSubmissionRow {
  id: string;
  order_number?: string | null;
  customer_name?: string | null;
  amount_minor: number;
  currency_code: string;
  status: string;
  submitted_at: string;
}

interface DashboardLicenseRow {
  id: string;
  license_number: string;
  status: string;
  expires_at: string | null;
  customer_name: string | null;
  product_name: string | null;
  expires_date_display: string;
}

type DashboardRange =
  | { kind: "preset"; preset: DashboardPreset }
  | { kind: "custom"; from: string; to: string };

/** Server cap, mirrored client-side (overview-range.ts). */
const MAX_RANGE_DAYS = 366;

/** Licences expiring within this many days count as "expiring soon". */
const EXPIRING_SOON_DAYS = 30;

const PANEL_LIMIT = 5;

/** Product display timezone (fixed by spec); overview ranges use it. */
const DISPLAY_TIMEZONE = "Asia/Dhaka";

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

/** True when the timestamp's calendar day (display timezone) is in range. */
function isInRange(isoTimestamp: string, bounds: { from: string; to: string } | null): boolean {
  if (bounds === null) return true;
  try {
    const day = isoDateOnlyInTimeZone(isoTimestamp, DISPLAY_TIMEZONE);
    return day >= bounds.from && day <= bounds.to;
  } catch {
    return false;
  }
}

/**
 * KPI card tone — ONE green only, varied like Neon (tint ladder). The
 * hero card carries the strongest wash; the expired/revoked card stays
 * neutral grey (no second hue) because it is the one "bad" number.
 */
type KpiTone = "hero" | "strong" | "mid" | "soft" | "plain" | "muted";

function KpiCard({
  label,
  icon: Icon,
  tone,
  children,
}: {
  label: string;
  icon: LucideIcon;
  tone: KpiTone;
  children: ReactNode;
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
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div style={{ padding: "var(--sm-space-1) 0" }}>{/* L-11: literal padding → spacing token */}
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} style={{ marginTop: i === 0 ? 0 : 10 }}>
          <Skeleton height={14} width="70%" />
        </div>
      ))}
    </div>
  );
}

export function DashboardSection() {
  const navigate = useNavigate();
  const goTo = (to: string) => {
    void navigate({ to } as never);
  };
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

  // Report panels — existing list endpoints only, no new API.
  // ?limit=100 (the API max): the panels sort/filter client-side
  // over the loaded set, so the 25-row default would silently drop
  // recent rows once the collection grows past it.
  const ordersQuery = useQuery({
    queryKey: ["admin", "dashboard", "recent-orders"],
    queryFn: async () => {
      const res = await apiRequest<{ items: DashboardOrderRow[] }>("/api/v1/admin/orders?limit=100");
      return res.items;
    },
  });
  const submissionsQuery = useQuery({
    queryKey: ["admin", "dashboard", "pending-submissions"],
    queryFn: async () => {
      const res = await apiRequest<{ items: DashboardSubmissionRow[] }>(
        "/api/v1/admin/payment-submissions?limit=100",
      );
      return res.items;
    },
  });
  const licensesQuery = useQuery({
    queryKey: ["admin", "dashboard", "expiring-licenses"],
    queryFn: async () => {
      const res = await apiRequest<{ items: DashboardLicenseRow[] }>(
        "/api/v1/admin/licenses?limit=100",
      );
      return res.items;
    },
  });

  // Recent orders: latest first, scoped to the selected range when bounded
  // (same rule as the range-scoped flow KPIs above).
  const recentOrders = useMemo(() => {
    const items = ordersQuery.data ?? [];
    return items
      .filter((o) => isInRange(o.created_at, bounds))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, PANEL_LIMIT);
  }, [ordersQuery.data, bounds]);

  const pendingSubmissions = useMemo(() => {
    const items = submissionsQuery.data ?? [];
    return items
      .filter((s) => s.status === "submitted" || s.status === "under_review")
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
      .slice(0, PANEL_LIMIT);
  }, [submissionsQuery.data]);

  const expiringLicenses = useMemo(() => {
    const nowMs = Date.now();
    const soonMs = nowMs + EXPIRING_SOON_DAYS * 86_400_000;
    const items = licensesQuery.data ?? [];
    return items
      .filter((l) => {
        if (l.status !== "active" || !l.expires_at) return false;
        const expMs = Date.parse(l.expires_at);
        return Number.isFinite(expMs) && expMs > nowMs && expMs <= soonMs;
      })
      .sort((a, b) => (a.expires_at ?? "") < (b.expires_at ?? "") ? -1 : 1)
      .slice(0, PANEL_LIMIT);
  }, [licensesQuery.data]);

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
        help="Revenue, orders and paid orders reflect the selected period; product, subscription, licence and queue counts are current totals. Recent orders follow the selected period; Needs attention shows what is waiting right now."
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
      {/* LIVE L8: isFetching covers a range-change refetch, when the
          previous range's numbers would otherwise stay visible. */}
      {query.isPending || query.isFetching ? (
        <div className="sm-kpi-grid">
          {Array.from({ length: 8 }).map((_, i) => (
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
            {/* M-8: the API returns null (not 0) when the caller lacks
                payments.read — hide the card instead of showing
                ৳0.00, so a missing value is never mistaken for "no
                revenue". */}
            {query.data.verified_revenue_minor !== null ? (
              <KpiCard label="Verified revenue" icon={Banknote} tone="hero">
                <MoneyCell
                  currency={query.data.currency_code}
                  minor={query.data.verified_revenue_minor}
                />
              </KpiCard>
            ) : null}
            <KpiCard label="Pending payment review" icon={Clock} tone="strong">
              {query.data.pending_payment_submissions}
            </KpiCard>
            <KpiCard label="Active products" icon={Package} tone="mid">
              {query.data.active_products} / {query.data.total_products}
            </KpiCard>
            <KpiCard label="Paid orders" icon={Receipt} tone="soft">
              {query.data.paid_orders} / {query.data.total_orders}
            </KpiCard>
            <KpiCard label="Active subscriptions" icon={Repeat} tone="plain">
              {query.data.active_subscriptions}
            </KpiCard>
            <KpiCard label="Active licenses" icon={KeyRound} tone="plain">
              {query.data.active_licenses}
            </KpiCard>
            <KpiCard label="Expired/revoked licenses" icon={ShieldAlert} tone="muted">
              {query.data.expired_or_revoked_licenses}
            </KpiCard>
            <KpiCard label="Pending outbox events" icon={Send} tone="soft">
              {query.data.pending_outbox_events}
            </KpiCard>
          </div>
          {bounds !== null &&
            query.data.total_orders === 0 &&
            (query.data.verified_revenue_minor ?? 0) === 0 && (
              <p className="sm-hint">No activity in this period.</p>
            )}
        </>
      ) : null}

      <div className="sm-grid-2">
        <div className="sm-dash-panel" aria-label="Recent orders">
          <div className="sm-dash-panel-head">
            <h2 className="sm-section-title">Recent orders</h2>
            <Button size="sm" variant="secondary" onClick={() => goTo("/orders")}>
              View all orders
            </Button>
          </div>
          {ordersQuery.isPending || ordersQuery.isFetching ? (
            <PanelSkeleton />
          ) : ordersQuery.isError ? (
            <p className="sm-hint">
              Could not load recent orders.{" "}
              <button
                type="button"
                className="sm-link-btn"
                onClick={() => void ordersQuery.refetch()}
              >
                Retry
              </button>
            </p>
          ) : recentOrders.length === 0 ? (
            <p className="sm-hint">
              {bounds !== null ? "No orders in this period." : "No orders yet."}
            </p>
          ) : (
            recentOrders.map((o) => (
              <button
                key={o.id}
                type="button"
                className="sm-dash-row"
                onClick={() => goTo(`/orders/${o.id}`)}
              >
                <span className="sm-dash-row-main">
                  <span className="sm-mono">{o.order_number}</span>
                  <span className="sm-dash-row-sub">
                    {o.customer ? o.customer.name : "No customer"}
                  </span>
                </span>
                <span className="sm-dash-row-side">
                  <MoneyCell currency={o.currency_code} minor={o.total_minor} />
                  <StatusBadge status={o.payment_status} />
                </span>
              </button>
            ))
          )}
        </div>

        <div className="sm-dash-panel" aria-label="Needs attention">
          <div className="sm-dash-panel-head">
            <h2 className="sm-section-title">Needs attention</h2>
            <Button size="sm" variant="secondary" onClick={() => goTo("/payment-review")}>
              Payment review
            </Button>
          </div>
          {submissionsQuery.isPending ||
          licensesQuery.isPending ||
          submissionsQuery.isFetching ||
          licensesQuery.isFetching ? (
            <PanelSkeleton />
          ) : submissionsQuery.isError || licensesQuery.isError ? (
            <p className="sm-hint">
              Could not load attention items.{" "}
              <button
                type="button"
                className="sm-link-btn"
                onClick={() => {
                  void submissionsQuery.refetch();
                  void licensesQuery.refetch();
                }}
              >
                Retry
              </button>
            </p>
          ) : pendingSubmissions.length === 0 && expiringLicenses.length === 0 ? (
            <p className="sm-hint">Nothing needs attention.</p>
          ) : (
            <>
              {pendingSubmissions.length > 0 && (
                <div className="sm-dash-group">
                  <div className="sm-dash-group-label">
                    Payment review ({pendingSubmissions.length})
                  </div>
                  {pendingSubmissions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="sm-dash-row"
                      onClick={() => goTo(`/payment-review/${s.id}`)}
                    >
                      <span className="sm-dash-row-main">
                        <span className="sm-mono">{s.order_number ?? "—"}</span>
                        <span className="sm-dash-row-sub">
                          {s.customer_name ?? "No customer"}
                        </span>
                      </span>
                      <span className="sm-dash-row-side">
                        <MoneyCell currency={s.currency_code} minor={s.amount_minor} />
                        <span className="sm-dash-row-sub">Awaiting review</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {expiringLicenses.length > 0 && (
                <div className="sm-dash-group">
                  <div className="sm-dash-group-label">
                    Licenses expiring soon ({expiringLicenses.length})
                  </div>
                  {expiringLicenses.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      className="sm-dash-row"
                      onClick={() => goTo(`/licenses/${l.id}`)}
                    >
                      <span className="sm-dash-row-main">
                        <span className="sm-mono">{l.license_number}</span>
                        <span className="sm-dash-row-sub">
                          {[l.customer_name, l.product_name].filter(Boolean).join(" · ") ||
                            "—"}
                        </span>
                      </span>
                      <span className="sm-dash-row-side">
                        <span className="sm-tabular">Expires {l.expires_date_display}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
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
            <Field label="From" required htmlFor="dash-custom-from" hint="DD/MM/YYYY." error={customError ?? ""}>
              <input
                id="dash-custom-from"
                name="from"
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
            <Field label="To" required htmlFor="dash-custom-to" hint="DD/MM/YYYY." error="">
              <input
                id="dash-custom-to"
                name="to"
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
