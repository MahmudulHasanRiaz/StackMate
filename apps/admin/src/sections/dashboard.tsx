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
 *
 * OD-07 (2026-11-28, PRD §18): the dashboard analytics endpoint
 * (GET /api/v1/admin/analytics/dashboard) adds the full §18 surface —
 * product / payment-status / subscription-status / source filters
 * (URL-persisted), a clickable Total customers card, an Upcoming
 * renewals panel, and Revenue / Orders / Payment-method charts
 * (components/dashboard-charts.tsx, hand-rolled SVG). Money fields
 * are null when the caller lacks payments.read — hidden, never 0.
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
  Users,
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
import { listKey } from "../lib/query";
import {
  Button,
  Dialog,
  ErrorState,
  Field,
  MoneyCell,
  SearchableSelect,
  Select,
  Skeleton,
  StatusBadge,
} from "../components/primitives";
import {
  OrdersChart,
  PaymentMethodChart,
  RevenueChart,
  type DashboardAnalyticsDto,
} from "../components/dashboard-charts";

interface AnalyticsOverviewDto {
  currency_code: string;
  total_products: number;
  active_products: number;
  total_customers: number;
  // F-02: the API nulls these three counts for roles without
  // payments.read (same canSeeRevenue gate as verified_revenue_minor)
  // — the cards below are hidden when null, never shown as 0.
  total_orders: number | null;
  paid_orders: number | null;
  pending_payment_submissions: number | null;
  active_subscriptions: number;
  active_licenses: number;
  expired_or_revoked_licenses: number;
  verified_revenue_minor: number | null;
  pending_outbox_events: number;
  // E-11: rendered when the API sends it (the count is not in the
  // DTO on older API builds — the card is omitted, never faked).
  upcoming_renewals?: number | null;
  // B-06: server-side dashboard panels (overview + the 3 panels'
  // top-N rows in one response). When present the panel queries
  // below are skipped and these rows are used; when absent the
  // existing per-panel queries are the fallback.
  panels?: {
    recent_orders?: DashboardOrderRow[];
    pending_submissions?: DashboardSubmissionRow[];
    expiring_licenses?: DashboardLicenseRow[];
  } | null;
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

/* ------------------------------------------------------------------ */
/* OD-07 filters (PRD §18) — URL-persisted alongside the range.        */
/* ------------------------------------------------------------------ */
const PAYMENT_STATUSES = [
  "unpaid",
  "pending_verification",
  "partially_paid",
  "paid",
  "partially_refunded",
  "refunded",
] as const;
const SUBSCRIPTION_STATUSES = [
  "trialing",
  "pending",
  "active",
  "past_due",
  "paused",
  "cancelled",
  "expired",
] as const;
const SOURCES = ["admin", "website", "api", "import"] as const;
const SOURCE_LABELS: Record<string, string> = {
  admin: "Admin",
  website: "Website",
  api: "API",
  import: "Import",
};

interface DashboardFilters {
  productId: string;
  paymentStatus: string;
  subscriptionStatus: string;
  source: string;
}

const EMPTY_FILTERS: DashboardFilters = {
  productId: "",
  paymentStatus: "",
  subscriptionStatus: "",
  source: "",
};

/** "pending_verification" → "Pending verification" (never a raw enum). */
function sentenceCase(value: string): string {
  const words = value.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function parseFiltersFromSearch(search: Record<string, unknown>): DashboardFilters {
  const str = (key: string) => (typeof search[key] === "string" ? (search[key] as string) : "");
  const paymentStatus = str("paymentStatus");
  const subscriptionStatus = str("subscriptionStatus");
  const source = str("source");
  return {
    productId: str("productId"),
    paymentStatus: (PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)
      ? paymentStatus
      : "",
    subscriptionStatus: (SUBSCRIPTION_STATUSES as readonly string[]).includes(
      subscriptionStatus,
    )
      ? subscriptionStatus
      : "",
    source: (SOURCES as readonly string[]).includes(source) ? source : "",
  };
}

function filtersToSearch(filters: DashboardFilters): Record<string, unknown> {
  return {
    ...(filters.productId ? { productId: filters.productId } : {}),
    ...(filters.paymentStatus ? { paymentStatus: filters.paymentStatus } : {}),
    ...(filters.subscriptionStatus
      ? { subscriptionStatus: filters.subscriptionStatus }
      : {}),
    ...(filters.source ? { source: filters.source } : {}),
  };
}

function buildSearch(range: DashboardRange, filters: DashboardFilters): Record<string, unknown> {
  return { ...rangeToSearch(range), ...filtersToSearch(filters) };
}

function hasAnyFilter(filters: DashboardFilters): boolean {
  return (
    filters.productId !== "" ||
    filters.paymentStatus !== "" ||
    filters.subscriptionStatus !== "" ||
    filters.source !== ""
  );
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
  onClick,
  ariaLabel,
}: {
  label: string;
  icon: LucideIcon;
  tone: KpiTone;
  children: ReactNode;
  /** When set the card is a keyboard-accessible button (OD-07). */
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const [focused, setFocused] = useState(false);
  const inner = (
    <>
      <div className="sm-kpi-head">
        <div className="sm-label">{label}</div>
        <span className="sm-kpi-icon" aria-hidden="true">
          <Icon />
        </span>
      </div>
      <div className="sm-kpi-value" style={{ marginTop: 6 }}>
        {children}
      </div>
    </>
  );
  if (!onClick) {
    return <div className={`sm-kpi-card sm-kpi-tint-${tone}`}>{inner}</div>;
  }
  return (
    <div
      className={`sm-kpi-card sm-kpi-tint-${tone}`}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel ?? label}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        cursor: "pointer",
        ...(focused
          ? { borderColor: "var(--sm-accent)", boxShadow: "var(--sm-focus-ring)" }
          : {}),
      }}
    >
      {inner}
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
  const filters = parseFiltersFromSearch(rawSearch);
  const anyFilterSet = hasAnyFilter(filters);
  const [customOpen, setCustomOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  const applyRange = (next: DashboardRange) => {
    void navigate({ search: buildSearch(next, filters) } as never);
  };

  const applyFilters = (next: DashboardFilters) => {
    void navigate({ search: buildSearch(range, next) } as never);
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

  // OD-07 (PRD §18): dashboard analytics — renewals + charts, scoped
  // by the same range plus the four filters above. Same bounds logic
  // as the overview query; the endpoint is Worker A's build, coded
  // against the agreed DTO shape (see dashboard-charts.tsx).
  const chartsQuery = useQuery({
    queryKey: [
      "admin",
      "dashboard-charts",
      range.kind === "custom" ? `custom:${bounds?.from}..${bounds?.to}` : range.preset,
      filters.productId,
      filters.paymentStatus,
      filters.subscriptionStatus,
      filters.source,
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (bounds) {
        params.set("from", bounds.from);
        params.set("to", bounds.to);
      }
      if (filters.productId) params.set("productId", filters.productId);
      if (filters.paymentStatus) params.set("paymentStatus", filters.paymentStatus);
      if (filters.subscriptionStatus)
        params.set("subscriptionStatus", filters.subscriptionStatus);
      if (filters.source) params.set("source", filters.source);
      const qs = params.toString();
      return apiRequest<DashboardAnalyticsDto>(
        `/api/v1/admin/analytics/dashboard${qs ? `?${qs}` : ""}`,
      );
    },
    placeholderData: keepPreviousData,
  });

  // Report panels — existing list endpoints only, no new API.
  // ?limit=100 (the API max) + an explicit sort: the server returns
  // newest-first (created_at DESC, id ASC tiebreak — submitted_at for
  // submissions) and slices the window AFTER sorting, so the loaded
  // set is deterministically the newest 100 rows. The panels still
  // sort/filter client-side over that set (range + status filters).
  // D-14: panel queries are keyed off the listKey() factory (with a
  // dashboard suffix), so a mutation elsewhere that invalidates
  // listKey("orders") / ("payment-submissions") / ("licenses") also
  // refreshes the dashboard panels instead of leaving them stale
  // for the 30s staleTime. B-06: when the overview already carries
  // the panels, these queries stay disabled (fallback only).
  const panels = query.data?.panels ?? null;
  const ordersQuery = useQuery({
    queryKey: [...listKey("orders"), "dashboard", "recent-orders"],
    queryFn: async () => {
      const res = await apiRequest<{ items: DashboardOrderRow[] }>(
        "/api/v1/admin/orders?limit=100&sort=created_at:desc",
      );
      return res.items;
    },
    enabled: !panels?.recent_orders,
  });
  const submissionsQuery = useQuery({
    queryKey: [...listKey("payment-submissions"), "dashboard", "pending-submissions"],
    queryFn: async () => {
      const res = await apiRequest<{ items: DashboardSubmissionRow[] }>(
        "/api/v1/admin/payment-submissions?limit=100&sort=submitted_at:desc",
      );
      return res.items;
    },
    enabled: !panels?.pending_submissions,
  });
  const licensesQuery = useQuery({
    queryKey: [...listKey("licenses"), "dashboard", "expiring-licenses"],
    queryFn: async () => {
      // D-02: expiry-scoped panel — ask the server for licenses by
      // expiry (expiring_within_days=30) instead of the newest 100
      // by creation, which silently omitted old licenses expiring
      // next week. Unknown params are ignored by older API builds;
      // the client filter below stays as the fallback.
      const res = await apiRequest<{ items: DashboardLicenseRow[] }>(
        "/api/v1/admin/licenses?limit=100&sort=expires_at:asc&expiring_within_days=30",
      );
      return res.items;
    },
    enabled: !panels?.expiring_licenses,
  });

  // Recent orders: latest first, scoped to the selected range when bounded
  // (same rule as the range-scoped flow KPIs above).
  const recentOrders = useMemo(() => {
    const items = panels?.recent_orders ?? ordersQuery.data ?? [];
    return items
      .filter((o) => isInRange(o.created_at, bounds))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, PANEL_LIMIT);
  }, [panels?.recent_orders, ordersQuery.data, bounds]);

  const pendingSubmissions = useMemo(() => {
    const items = panels?.pending_submissions ?? submissionsQuery.data ?? [];
    return items
      .filter((s) => s.status === "submitted" || s.status === "under_review")
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
      .slice(0, PANEL_LIMIT);
  }, [panels?.pending_submissions, submissionsQuery.data]);

  const expiringLicenses = useMemo(() => {
    const nowMs = Date.now();
    const soonMs = nowMs + EXPIRING_SOON_DAYS * 86_400_000;
    const items = panels?.expiring_licenses ?? licensesQuery.data ?? [];
    return items
      .filter((l) => {
        if (l.status !== "active" || !l.expires_at) return false;
        const expMs = Date.parse(l.expires_at);
        return Number.isFinite(expMs) && expMs > nowMs && expMs <= soonMs;
      })
      .sort((a, b) => (a.expires_at ?? "") < (b.expires_at ?? "") ? -1 : 1)
      .slice(0, PANEL_LIMIT);
  }, [panels?.expiring_licenses, licensesQuery.data]);

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
        help="Revenue, orders and paid orders reflect the selected period; product, subscription, licence and queue counts are current totals. Recent orders follow the selected period; Needs attention shows what is waiting right now. The product, payment, subscription and source filters scope the renewals and charts below."
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
      {/* OD-07 filters row — persisted in the URL alongside the range,
          so refresh/share keeps them; any change refetches the
          dashboard analytics query (keepPreviousData). */}
      <div className="sm-filter-row" role="group" aria-label="Dashboard filters">
        <div style={{ flex: "1 1 240px", maxWidth: 300, minWidth: 200 }}>
          <label className="sm-label" htmlFor="dash-filter-product">
            Product
          </label>
          <div style={{ marginTop: 4 }}>
            <SearchableSelect
              id="dash-filter-product"
              value={filters.productId}
              onChange={(v) => applyFilters({ ...filters, productId: v })}
              options={(chartsQuery.data?.filter_options.products ?? []).map((p) => ({
                value: p.id,
                label: p.code ? `${p.name} (${p.code})` : p.name,
              }))}
              leadingOptions={[{ value: "", label: "All products" }]}
              placeholder="All products"
              ariaLabel="Filter by product"
            />
          </div>
        </div>
        <div style={{ flex: "1 1 170px", maxWidth: 230, minWidth: 160 }}>
          <label className="sm-label" htmlFor="dash-filter-payment-status">
            Payment status
          </label>
          <div style={{ marginTop: 4 }}>
            <Select
              id="dash-filter-payment-status"
              value={filters.paymentStatus}
              onChange={(e) =>
                applyFilters({ ...filters, paymentStatus: e.target.value })
              }
              aria-label="Filter by payment status"
            >
              <option value="">All payment statuses</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {sentenceCase(s)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div style={{ flex: "1 1 170px", maxWidth: 230, minWidth: 160 }}>
          <label className="sm-label" htmlFor="dash-filter-subscription-status">
            Subscription status
          </label>
          <div style={{ marginTop: 4 }}>
            <Select
              id="dash-filter-subscription-status"
              value={filters.subscriptionStatus}
              onChange={(e) =>
                applyFilters({ ...filters, subscriptionStatus: e.target.value })
              }
              aria-label="Filter by subscription status"
            >
              <option value="">All subscription statuses</option>
              {SUBSCRIPTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {sentenceCase(s)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div style={{ flex: "1 1 140px", maxWidth: 200, minWidth: 140 }}>
          <label className="sm-label" htmlFor="dash-filter-source">
            Source
          </label>
          <div style={{ marginTop: 4 }}>
            <Select
              id="dash-filter-source"
              value={filters.source}
              onChange={(e) => applyFilters({ ...filters, source: e.target.value })}
              aria-label="Filter by source"
            >
              <option value="">All sources</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s] ?? sentenceCase(s)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {anyFilterSet ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => applyFilters(EMPTY_FILTERS)}
            aria-label="Clear all dashboard filters"
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {/* LIVE L8: isFetching covers a range-change refetch, when the
          previous range's numbers would otherwise stay visible. */}
      {query.isPending || query.isFetching ? (
        <div className="sm-kpi-grid">
          {Array.from({ length: 10 }).map((_, i) => (
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
            {query.data.pending_payment_submissions !== null ? (
              <KpiCard label="Pending payment review" icon={Clock} tone="strong">
                {query.data.pending_payment_submissions}
              </KpiCard>
            ) : null}
            <KpiCard label="Active products" icon={Package} tone="mid">
              {query.data.active_products} / {query.data.total_products}
            </KpiCard>
            {query.data.paid_orders !== null && query.data.total_orders !== null ? (
              <KpiCard label="Paid orders" icon={Receipt} tone="soft">
                {query.data.paid_orders} / {query.data.total_orders}
              </KpiCard>
            ) : null}
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
            {/* E-11: total_customers was fetched but never displayed. */}
            <KpiCard
              label="Total customers"
              icon={Users}
              tone="plain"
              onClick={() => goTo("/customers")}
              ariaLabel={`Total customers: ${query.data.total_customers}. Open customers`}
            >
              {query.data.total_customers}
            </KpiCard>
            {query.data.upcoming_renewals !== undefined &&
            query.data.upcoming_renewals !== null ? (
              <KpiCard label="Upcoming renewals" icon={Repeat} tone="soft">
                {query.data.upcoming_renewals}
              </KpiCard>
            ) : null}
          </div>
          {bounds !== null &&
            query.data.total_orders === 0 &&
            (query.data.verified_revenue_minor ?? 0) === 0 && (
              <p className="sm-hint">No activity in this period.</p>
            )}
        </>
      ) : null}

      {/* OD-07: upcoming renewals + charts from the dashboard analytics
          endpoint. Full-width rows, so the 2-column panels below are
          not crowded. The overview query above is untouched. */}
      <div
        className="sm-dash-panel"
        aria-label="Upcoming renewals"
        style={{ marginBottom: "var(--sm-space-6)" }}
      >
        <div className="sm-dash-panel-head">
          <h2 className="sm-section-title">Upcoming renewals</h2>
          <Button size="sm" variant="secondary" onClick={() => goTo("/renewals")}>
            View all
          </Button>
        </div>
        {chartsQuery.isPending || chartsQuery.isFetching ? (
          <PanelSkeleton />
        ) : chartsQuery.isError ? (
          <p className="sm-hint">
            Could not load renewals.{" "}
            <button
              type="button"
              className="sm-link-btn"
              onClick={() => void chartsQuery.refetch()}
            >
              Retry
            </button>
          </p>
        ) : (chartsQuery.data?.upcoming_renewals_list.length ?? 0) === 0 ? (
          <p className="sm-hint">
            {anyFilterSet
              ? "No renewals match the filters."
              : "No renewals in the next 30 days."}
          </p>
        ) : (
          chartsQuery.data?.upcoming_renewals_list.map((r) => (
            <button
              key={r.subscription_id}
              type="button"
              className="sm-dash-row"
              onClick={() => goTo(`/subscriptions/${r.subscription_id}`)}
            >
              <span className="sm-dash-row-main">
                <span className="sm-tabular">{r.renewal_date_display}</span>
                <span className="sm-dash-row-sub">
                  {[r.customer_name, r.product_name].filter(Boolean).join(" · ") || "—"}
                </span>
              </span>
              <span className="sm-dash-row-side">
                {r.amount_minor !== null ? (
                  <MoneyCell currency={r.currency_code} minor={r.amount_minor} />
                ) : (
                  <span className="sm-dash-row-sub">—</span>
                )}
                <StatusBadge status={r.status} />
              </span>
            </button>
          ))
        )}
      </div>

      <div
        className="sm-dash-panel"
        aria-label="Revenue over time"
        style={{ marginBottom: "var(--sm-space-6)" }}
      >
        <div className="sm-dash-panel-head">
          <h2 className="sm-section-title">Revenue over time</h2>
        </div>
        {chartsQuery.isPending || chartsQuery.isFetching ? (
          <PanelSkeleton />
        ) : chartsQuery.isError ? (
          <p className="sm-hint">
            Could not load charts.{" "}
            <button
              type="button"
              className="sm-link-btn"
              onClick={() => void chartsQuery.refetch()}
            >
              Retry
            </button>
          </p>
        ) : chartsQuery.data ? (
          <RevenueChart
            series={chartsQuery.data.revenue_series}
            currencyCode={chartsQuery.data.currency_code}
          />
        ) : null}
      </div>

      <div className="sm-grid-2">
        <div className="sm-dash-panel" aria-label="Orders over time">
          <div className="sm-dash-panel-head">
            <h2 className="sm-section-title">Orders over time</h2>
          </div>
          {chartsQuery.isPending || chartsQuery.isFetching ? (
            <PanelSkeleton />
          ) : chartsQuery.isError ? (
            <p className="sm-hint">
              Could not load charts.{" "}
              <button
                type="button"
                className="sm-link-btn"
                onClick={() => void chartsQuery.refetch()}
              >
                Retry
              </button>
            </p>
          ) : chartsQuery.data ? (
            <OrdersChart series={chartsQuery.data.revenue_series} />
          ) : null}
        </div>

        <div className="sm-dash-panel" aria-label="Payment method distribution">
          <div className="sm-dash-panel-head">
            <h2 className="sm-section-title">Payment methods</h2>
          </div>
          {chartsQuery.isPending || chartsQuery.isFetching ? (
            <PanelSkeleton />
          ) : chartsQuery.isError ? (
            <p className="sm-hint">
              Could not load charts.{" "}
              <button
                type="button"
                className="sm-link-btn"
                onClick={() => void chartsQuery.refetch()}
              >
                Retry
              </button>
            </p>
          ) : chartsQuery.data ? (
            <PaymentMethodChart
              rows={chartsQuery.data.payment_method_distribution}
              currencyCode={chartsQuery.data.currency_code}
            />
          ) : null}
        </div>
      </div>

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
