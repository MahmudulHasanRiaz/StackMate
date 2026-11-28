/**
 * Tracking / Meta CAPI — tracking events list (design spec §4.1).
 *
 * Route (registered in router.tsx, Administration group):
 *   /tracking-events
 *
 * Search is read with `useSearch({ strict: false })`: the route id is
 * "/_main/tracking-events" (the operational shell is a pathless
 * `_main` layout route), so a plain-path `from: "/tracking-events"`
 * throws "Invariant failed" at render (jsdom repro 2026-11-15).
 *
 * Endpoint used (`tracking.manage`):
 *   GET /api/v1/admin/tracking/events
 *   GET /api/v1/admin/integrated-sites (site names for the Site column)
 *
 * Meta CAPI delivery is LIVE (E-01, verified 2026-11-27 against Meta
 * Events Manager): the outbox drain sends events to
 * graph.facebook.com (cron tick + manual dispatch); a delivered event
 * shows "Processed (recorded)" with delivered_at. Events with no Meta
 * destination (no site / no enabled pixel group) are honestly
 * "skipped" (C-2 Option A), never faked as delivered. This UI shows
 * the recorded status and delivered_at; it never claims an event
 * reached Meta without the drain's success.
 */
import { useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { BarChart3 } from "lucide-react";
import {
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminList,
} from "../lib/section-kit";
import {
  Button,
  Chip,
  CopyButton,
  DateCell,
  DateTimeCell,
  StatusBadge,
  Toolbar,
} from "../components/primitives";
import type { IntegratedSite } from "./integrations";

/* ------------------------------------------------------------------ */
/* Route helpers (see header note)                                     */
/* ------------------------------------------------------------------ */
function useRouteSearch() {
  // No `from`: the route id is "/_main/tracking-events" (pathless
  // `_main` layout parent), so a plain-path `from: "/tracking-events"`
  // throws "Invariant failed" at render (jsdom repro 2026-11-15).
  // Read the current route's search like the other list sections.
  return useSearch({ strict: false }) as unknown as Record<string, unknown>;
}

function useRouteNavigate() {
  const navigate = useNavigate();
  return (options: {
    to: string;
    search?: Record<string, unknown>;
    params?: Record<string, string>;
  }) => navigate(options as never);
}

/* ------------------------------------------------------------------ */
/* DTO (apps/api/src/platform/db/store.ts — TrackingEventRecord)       */
/* ------------------------------------------------------------------ */
export interface TrackingEvent {
  id: string;
  integrated_site_id: string;
  event_name: string;
  event_id: string;
  event_time: string;
  event_source_url: string | null;
  order_id: string | null;
  consent_state: "granted" | "denied";
  consent_policy_version: string;
  sanitized_payload: Record<string, unknown>;
  // "simulated" (audit C-2/D-6): recorded but never sent to Meta —
  // the dispatcher marks Meta CAPI events simulated, never processed.
  status: "received" | "queued" | "processed" | "rejected" | "simulated";
  /** E-19: true when this event was deduplicated against an earlier
   *  identical event (sent by the API once the tracking list carries
   *  the flag — absent on older API builds). */
  deduplicated?: boolean | null;
  delivery_attempts: number;
  delivered_at: string | null;
  created_at: string;
}

const STATUS_FILTERS = [
  "all",
  "received",
  "queued",
  "processed",
  "rejected",
  "simulated",
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

export function TrackingSection() {
  const rawSearch = useRouteSearch();
  const search = parseListSearch(rawSearch);
  const navigate = useRouteNavigate();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const query = useAdminList<TrackingEvent>(
    "tracking-events",
    "/api/v1/admin/tracking/events",
    {
      q: search.q,
      page: search.page,
      pageSize: search.pageSize,
      // D-01: thread the status filter server-side (the API reads
      // ?status= once the B-05 half lands; the client filter below
      // stays as the fallback until then).
      extra: statusFilter !== "all" ? { status: statusFilter } : undefined,
    },
  );
  const sitesQuery = useAdminList<IntegratedSite>(
    "integrated-sites",
    "/api/v1/admin/integrated-sites",
  );
  const siteNames = new Map(
    (sitesQuery.data ?? []).map((s) => [s.id, s.name]),
  );

  const setSearch = (patch: Record<string, string | number | undefined>) => {
    const next: Record<string, unknown> = {
      q: search.q,
      page: search.page,
      pageSize: search.pageSize,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    navigate({ to: "/tracking-events", search: next });
  };

  const filtered =
    statusFilter === "all"
      ? query.data
      : (query.data ?? []).filter((e) => e.status === statusFilter);

  // D-15: memoized — the site-names map is the only changing dep.
  const columns: ColumnDef<TrackingEvent, unknown>[] = useMemo(
    () => [
    {
      header: "Event",
      accessorKey: "event_name",
      cell: ({ row }) => <strong>{row.original.event_name}</strong>,
    },
    {
      header: "Event ID",
      accessorKey: "event_id",
      cell: ({ row }) => (
        <span className="sm-mono">
          {row.original.event_id}
          <CopyButton value={row.original.event_id} label="Copy event ID" />
        </span>
      ),
    },
    {
      header: "Site",
      accessorKey: "integrated_site_id",
      cell: ({ row }) =>
        siteNames.get(row.original.integrated_site_id) ?? (
          <span className="sm-mono">{row.original.integrated_site_id}</span>
        ),
    },
    {
      header: "Source URL",
      accessorKey: "event_source_url",
      enableSorting: false,
      cell: ({ row }) => row.original.event_source_url ?? "—",
    },
    {
      header: "Consent",
      accessorKey: "consent_state",
      cell: ({ row }) =>
        row.original.consent_state === "granted" ? "Granted" : "Denied",
    },
    {
      header: "Status",
      accessorKey: "status",
      cell: ({ row }) =>
        row.original.status === "processed" ? (
          <StatusBadge status="processed" label="Processed (recorded)" />
        ) : (
          <StatusBadge status={row.original.status} />
        ),
    },
    {
      header: "Attempts",
      accessorKey: "delivery_attempts",
      cell: ({ row }) => (
        <span className="sm-tabular">{row.original.delivery_attempts}</span>
      ),
    },
    {
      // E-19: dedup indicator (PRD §15.4) — "Deduped" when the server
      // says this event was deduplicated against an earlier identical
      // one; "—" otherwise (or while the API does not send the flag).
      header: "Dedup",
      accessorKey: "deduplicated",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.deduplicated === true ? (
          <StatusBadge status="deduped" label="Deduped" />
        ) : (
          "—"
        ),
    },
    {
      header: "Delivered at",
      accessorKey: "delivered_at",
      cell: ({ row }) => <DateTimeCell value={row.original.delivered_at} />,
    },
    {
      header: "Received",
      accessorKey: "created_at",
      cell: ({ row }) => <DateTimeCell value={row.original.created_at} />,
    },
    ],
    [siteNames],
  );

  return (
    <section aria-labelledby="tracking-heading">
      <PageHeader
        breadcrumb={[{ label: "Administration" }, { label: "Tracking Events" }]}
        title="Tracking Events"
        help="Events received from integrated sites"
      />
      <Toolbar>
        {STATUS_FILTERS.map((f) => (
          <Chip
            key={f}
            active={statusFilter === f}
            onClick={() => {
              setStatusFilter(f);
              setSearch({ page: 1 });
            }}
          >
            {f === "all" ? "All" : f[0]!.toUpperCase() + f.slice(1)}
          </Chip>
        ))}
        {sitesQuery.isError ? (
          <span className="sm-hint">Site names unavailable — showing site IDs.</span>
        ) : null}
      </Toolbar>
      <ListTable<TrackingEvent>
        columns={columns}
        data={filtered}
        serverSearch
        serverPagination
        disableSorting
        refreshSection="tracking-events"
        filtersActive={statusFilter !== "all"}
        total={query.total}
        search={search.q ?? ""}
        onSearchChange={(q) => setSearch({ q: q || undefined, page: 1 })}
        page={search.page ?? 1}
        onPageChange={(page) => setSearch({ page })}
        pageSize={search.pageSize ?? 25}
        onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={BarChart3}
        emptyTitle="No tracking events yet"
        emptyBody="Events appear here when an integrated site sends one, or when the platform records one itself (for example a Purchase event from an approved payment)."
        getRowId={(row) => row.id}
      />
      <p className="sm-hint">
        User data is stored hashed server-side; raw email and phone are never
        shown here.{" "}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate({ to: "/outbox" })}
        >
          View outbox →
        </Button>
      </p>
    </section>
  );
}
