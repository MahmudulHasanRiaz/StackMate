/**
 * Jobs / Runs — scheduled-job visibility (E-21, PRD §22).
 *
 * Route (registered in router.tsx, Administration group): /jobs
 *
 * Endpoint (pinned route — the API worker implements it in parallel):
 *   GET /api/v1/admin/jobs?page=&limit=
 *
 * The every-minute cron runs the outbox drain + renewal/expiry sweep,
 * but no admin page listed scheduled jobs or their runs before this
 * view. The DTO shape below is defensive on purpose: rows carry the
 * fields the endpoint documents, and anything the server does not
 * send yet renders as "—" instead of breaking the table. A 404 means
 * the endpoint is not live yet — the page says so plainly instead of
 * showing a bare error.
 */
import { useMemo } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { CalendarClock } from "lucide-react";
import { ApiClientError } from "../lib/api-client";
import {
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminList,
} from "../lib/section-kit";
import { Alert, DateTimeCell, StatusBadge } from "../components/primitives";

export interface ScheduledJob {
  id: string;
  /** Job key, e.g. "outbox-drain" / "renewal-sweep". */
  key?: string | null;
  name?: string | null;
  /** Cron schedule, e.g. "* * * * *". */
  schedule?: string | null;
  status?: string | null;
  last_run_at?: string | null;
  last_run_status?: string | null;
  /** Per-run report counts, when the endpoint returns them. */
  last_run_report?: {
    claimed?: number | null;
    delivered?: number | null;
    simulated?: number | null;
    skipped?: number | null;
    errors?: number | null;
  } | null;
  last_error?: string | null;
  next_run_at?: string | null;
  created_at?: string | null;
}

export function JobsSection() {
  const rawSearch = useSearch({ strict: false }) as unknown as Record<string, unknown>;
  const search = parseListSearch(rawSearch);
  const navigate = useNavigate();
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
    void navigate({ to: "/jobs", search: next } as never);
  };
  const query = useAdminList<ScheduledJob>("jobs", "/api/v1/admin/jobs", {
    q: search.q,
    page: search.page,
    pageSize: search.pageSize,
  });

  const notLive =
    query.isError &&
    query.error instanceof ApiClientError &&
    query.error.statusCode === 404;

  const columns: ColumnDef<ScheduledJob, unknown>[] = useMemo(
    () => [
      {
        accessorKey: "key",
        header: "Job",
        cell: ({ row }) => (
          <strong>{row.original.name ?? row.original.key ?? row.original.id}</strong>
        ),
      },
      {
        accessorKey: "schedule",
        header: "Schedule",
        cell: ({ row }) => <span className="sm-mono">{row.original.schedule ?? "—"}</span>,
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) =>
          row.original.status ? <StatusBadge status={row.original.status} /> : "—",
      },
      {
        accessorKey: "last_run_at",
        header: "Last run",
        cell: ({ row }) => <DateTimeCell value={row.original.last_run_at ?? null} />,
      },
      {
        accessorKey: "last_run_status",
        header: "Last run result",
        cell: ({ row }) => {
          const report = row.original.last_run_report;
          const bits: string[] = [];
          if (report?.claimed !== undefined && report.claimed !== null)
            bits.push(`claimed ${report.claimed}`);
          if (report?.delivered !== undefined && report.delivered !== null)
            bits.push(`delivered ${report.delivered}`);
          if (report?.simulated !== undefined && report.simulated !== null)
            bits.push(`simulated ${report.simulated}`);
          if (report?.errors !== undefined && report.errors !== null)
            bits.push(`errors ${report.errors}`);
          return (
            <span>
              {row.original.last_run_status ? (
                <StatusBadge status={row.original.last_run_status} />
              ) : (
                "—"
              )}
              {bits.length > 0 ? <span className="sm-hint"> {bits.join(" · ")}</span> : null}
              {row.original.last_error ? (
                <span className="sm-hint"> {row.original.last_error}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        accessorKey: "next_run_at",
        header: "Next run",
        cell: ({ row }) => <DateTimeCell value={row.original.next_run_at ?? null} />,
      },
  ],
    [],
  )

  return (
    <section aria-labelledby="jobs-heading">
      <PageHeader
        breadcrumb={[{ label: "Administration" }, { label: "Scheduled Jobs" }]}
        title="Scheduled Jobs"
        help="Background jobs (outbox drain, renewal sweep) and their runs — failed-job inspection lives here, not hidden in the cron"
      />
      {notLive ? (
        <Alert variant="warning">
          The jobs endpoint is not available yet — scheduled-job visibility is
          being built on the API side. The cron itself keeps running; only
          this view is missing.
        </Alert>
      ) : null}
      <ListTable<ScheduledJob>
        columns={columns}
        data={query.data}
        serverSearch
        serverPagination
        refreshSection="jobs"
        total={query.total}
        search={search.q ?? ""}
        onSearchChange={(q) => setSearch({ q: q || undefined, page: 1 })}
        page={search.page ?? 1}
        onPageChange={(page) => setSearch({ page })}
        pageSize={search.pageSize ?? 25}
        onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError && !notLive}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={CalendarClock}
        emptyTitle="No scheduled jobs"
        emptyBody="No scheduled jobs are registered."
        getRowId={(row) => row.id}
      />
    </section>
  );
}
