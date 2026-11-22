/**
 * Refunds — standalone list (Commerce group).
 *
 * Route (registered in router.tsx, under the _main shell): /refunds
 *
 * Refunds used to live only as the Refunds tab inside Payment Review
 * (D-4 UI). This page is the same list on its own route: server-paged
 * + server-searched, with the row detail drawer. Recording a refund
 * stays in Payment Review — the record form needs an order context,
 * and the server enforces the refundable ceiling there.
 *
 * Endpoint used (verified in apps/api/src/app.ts):
 *  - GET  /api/v1/admin/refunds[?q=&page=&limit=]   payments.read
 *    (server ?q= matches id / payment_transaction_id / reason /
 *    provider_refund_id; pagedCollectionResponse)
 */
import { useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ClipboardCheck } from "lucide-react";
import {
  DetailFacts,
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminList,
  type ListSearch,
} from "../lib/section-kit";
import {
  Button,
  CopyButton,
  DateTimeCell,
  Drawer,
  MoneyCell,
  StatusBadge,
} from "../components/primitives";
import { shortId } from "../lib/resolve-names";
import type { PaymentRefund } from "./payment-review";

/* ------------------------------------------------------------------ */
/* URL-backed list search (same shape as payment-review.tsx)           */
/* ------------------------------------------------------------------ */
function useListSearch() {
  const search = useRouterState({ select: (s) => s.location.search }) as Record<
    string,
    unknown
  >;
  const navigate = useNavigate();
  const parsed = parseListSearch(search);
  const setSearch = (next: { q?: string | null; page?: number; pageSize?: number }) => {
    const merged: ListSearch = { ...parsed };
    if (next.q === null) delete merged.q;
    else if (next.q !== undefined) merged.q = next.q;
    if (next.page !== undefined) merged.page = next.page;
    if (next.pageSize !== undefined) merged.pageSize = next.pageSize;
    (navigate as unknown as (opts: { search: Record<string, unknown> }) => void)({
      search: {
        ...(merged.q ? { q: merged.q } : {}),
        page: merged.page ?? 1,
        pageSize: merged.pageSize ?? 25,
      },
    });
  };
  return { parsed, setSearch };
}

/* ------------------------------------------------------------------ */
/* Refunds — list + detail drawer (columns mirror the Payment Review   */
/* Refunds tab, sections/payment-review.tsx RefundsList)                */
/* ------------------------------------------------------------------ */
export function RefundsSection() {
  const { parsed, setSearch } = useListSearch();
  const [selected, setSelected] = useState<PaymentRefund | null>(null);
  const refunds = useAdminList<PaymentRefund>("refunds", "/api/v1/admin/refunds", {
    q: parsed.q,
    page: parsed.page,
    pageSize: parsed.pageSize,
  });

  const columns: ColumnDef<PaymentRefund, unknown>[] = [
    {
      accessorKey: "id",
      header: "Refund",
      cell: ({ row }) => (
        <span>
          <span className="sm-mono">{shortId(row.original.id)}</span>
          <CopyButton value={row.original.id} label="Copy refund ID" />
        </span>
      ),
    },
    {
      accessorKey: "payment_transaction_id",
      header: "Transaction",
      cell: ({ row }) => (
        <span className="sm-mono">{shortId(row.original.payment_transaction_id)}</span>
      ),
    },
    {
      accessorKey: "amount_minor",
      header: "Amount",
      cell: ({ row }) => (
        <MoneyCell currency={row.original.currency_code} minor={row.original.amount_minor} />
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "reason",
      header: "Reason",
      cell: ({ row }) => <span className="sm-cell-text">{row.original.reason}</span>,
    },
    {
      accessorKey: "provider_refund_id",
      header: "Provider ref",
      cell: ({ row }) => (
        <span className="sm-mono">{row.original.provider_refund_id ?? "—"}</span>
      ),
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateTimeCell value={row.original.created_at} />,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => setSelected(row.original)}>
          View
        </Button>
      ),
    },
  ];

  return (
    <section aria-labelledby="refunds-heading">
      <PageHeader
        breadcrumb={[{ label: "Commerce" }, { label: "Refunds" }]}
        title="Refunds"
        help="Manual refunds recorded against payments — no gateway (D-4). New refunds are recorded from Payment Review."
      />
      <ListTable<PaymentRefund>
        columns={columns}
        data={refunds.data}
        serverSearch
        serverPagination
        refreshSection="refunds"
        total={refunds.total}
        search={parsed.q ?? ""}
        onSearchChange={(q) => setSearch({ q: q || null, page: 1 })}
        page={parsed.page ?? 1}
        onPageChange={(page) => setSearch({ page })}
        pageSize={parsed.pageSize ?? 25}
        onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
        isLoading={refunds.isPending}
        isError={refunds.isError}
        error={refunds.error}
        onRetry={() => void refunds.refetch()}
        emptyIcon={ClipboardCheck}
        emptyTitle="No refunds yet"
        emptyBody="Manual refunds recorded against a payment appear here."
        getRowId={(row) => row.id}
      />
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Refund ${shortId(selected.id)}` : "Refund"}
      >
        {selected ? (
          <DetailFacts
            facts={[
              { label: "Refund", value: <span className="sm-mono">{shortId(selected.id)}</span> },
              {
                label: "Transaction",
                value: <span className="sm-mono">{shortId(selected.payment_transaction_id)}</span>,
              },
              {
                label: "Amount",
                value: <MoneyCell currency={selected.currency_code} minor={selected.amount_minor} />,
              },
              { label: "Status", value: <StatusBadge status={selected.status} /> },
              { label: "Reason", value: selected.reason },
              { label: "Provider ref", value: selected.provider_refund_id ?? "—" },
              {
                label: "Requested by",
                value: selected.requested_by_user_id ? (
                  <span className="sm-mono">{shortId(selected.requested_by_user_id)}</span>
                ) : (
                  "—"
                ),
              },
              {
                label: "Processed by",
                value: selected.processed_by_user_id ? (
                  <span className="sm-mono">{shortId(selected.processed_by_user_id)}</span>
                ) : (
                  "—"
                ),
              },
              { label: "Created", value: <DateTimeCell value={selected.created_at} /> },
              { label: "Updated", value: <DateTimeCell value={selected.updated_at} /> },
            ]}
          />
        ) : null}
      </Drawer>
    </section>
  );
}
