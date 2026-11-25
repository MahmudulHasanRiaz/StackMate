/**
 * Renewals — renewal management view (E-09, PRD §12.5).
 *
 * Route (registered in router.tsx, Recurring & Access group): /renewals
 *
 * Endpoint (pinned route — the API worker implements it in parallel):
 *   GET /api/v1/admin/renewals?bucket=upcoming|due|overdue|failed|cancelled&page=&limit=
 *
 * Before this view, renewals were only discoverable one subscription
 * at a time (a next_renewal_at column + past invoices). The buckets
 * are the six §12.5 views collapsed to the five the endpoint offers.
 * The DTO shape below is defensive: anything the server does not
 * send yet renders as "—". A 404 means the endpoint is not live yet.
 */
import { useState, useMemo} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { ApiClientError, formatMinorMoney } from "../lib/api-client";
import {
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminList,
} from "../lib/section-kit";
import { Alert, Chip, DateCell, DateTimeCell, StatusBadge, Toolbar } from "../components/primitives";

const BUCKETS = ["upcoming", "due", "overdue", "failed", "cancelled"] as const;
type RenewalBucket = (typeof BUCKETS)[number];

export interface RenewalRow {
  id: string;
  subscription_id?: string | null;
  subscription_number?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  product_id?: string | null;
  product_name?: string | null;
  status?: string | null;
  next_renewal_at?: string | null;
  due_at?: string | null;
  amount_minor?: number | null;
  currency_code?: string | null;
  last_error?: string | null;
  created_at?: string | null;
}

function bucketLabel(bucket: RenewalBucket): string {
  return bucket[0]!.toUpperCase() + bucket.slice(1);
}

export function RenewalsSection() {
  const rawSearch = useSearch({ strict: false }) as unknown as Record<string, unknown>;
  const search = parseListSearch(rawSearch);
  const navigate = useNavigate();
  const [bucket, setBucket] = useState<RenewalBucket>("upcoming");

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
    void navigate({ to: "/renewals", search: next } as never);
  };

  const query = useAdminList<RenewalRow>("renewals", "/api/v1/admin/renewals", {
    q: search.q,
    page: search.page,
    pageSize: search.pageSize,
    extra: { bucket },
  });

  const notLive =
    query.isError &&
    query.error instanceof ApiClientError &&
    query.error.statusCode === 404;

  const columns: ColumnDef<RenewalRow, unknown>[] = useMemo(
    () => [
      {
        accessorKey: "subscription_number",
        header: "Subscription",
        cell: ({ row }) => (
          <span className="sm-mono">
            {row.original.subscription_number ?? row.original.subscription_id ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "customer_name",
        header: "Customer",
        cell: ({ row }) => row.original.customer_name ?? "—",
      },
      {
        accessorKey: "product_name",
        header: "Product",
        cell: ({ row }) => row.original.product_name ?? "—",
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) =>
          row.original.status ? <StatusBadge status={row.original.status} /> : "—",
      },
      {
        accessorKey: "next_renewal_at",
        header: "Renewal due",
        cell: ({ row }) => (
          <DateCell value={row.original.next_renewal_at ?? row.original.due_at ?? null} />
        ),
      },
      {
        accessorKey: "amount_minor",
        header: "Amount",
        cell: ({ row }) =>
          row.original.amount_minor !== undefined && row.original.amount_minor !== null
            ? formatMinorMoney(row.original.amount_minor, row.original.currency_code ?? "BDT")
            : "—",
      },
      {
        accessorKey: "last_error",
        header: "Last error",
        cell: ({ row }) => row.original.last_error ?? "—",
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => <DateTimeCell value={row.original.created_at ?? null} />,
      },
  ],
    [],
  )

  return (
    <section aria-labelledby="renewals-heading">
      <PageHeader
        breadcrumb={[{ label: "Recurring & Access" }, { label: "Renewals" }]}
        title="Renewals"
        help="Upcoming, due, overdue, failed and cancelled renewals — the queue staff work, instead of one subscription at a time"
      />
      {notLive ? (
        <Alert variant="warning">
          The renewals endpoint is not available yet — this queue is being
          built on the API side. Renewal is manual for now; see each
          subscription&apos;s detail page for its past renewal invoices.
        </Alert>
      ) : null}
      <Toolbar>
        {BUCKETS.map((b) => (
          <Chip
            key={b}
            active={bucket === b}
            onClick={() => {
              setBucket(b);
              setSearch({ page: 1 });
            }}
          >
            {bucketLabel(b)}
          </Chip>
        ))}
      </Toolbar>
      <ListTable<RenewalRow>
        columns={columns}
        data={query.data}
        serverSearch
        serverPagination
        refreshSection="renewals"
        filtersActive={bucket !== "upcoming"}
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
        emptyIcon={RefreshCw}
        emptyTitle={`No ${bucket} renewals`}
        emptyBody="Nothing in this bucket right now."
        getRowId={(row) => row.id}
      />
    </section>
  );
}
