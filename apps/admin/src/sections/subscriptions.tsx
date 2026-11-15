/**
 * Subscriptions — list + detail (design spec §4.1/§4.2).
 *
 * Routes (wired by the parent in router.tsx): /subscriptions and
 * /subscriptions/$subscriptionId. Search, page and pageSize are URL-backed
 * via the route's search params; the status filter is URL-backed too.
 * Navigation uses router.history.push because the routes are registered
 * by the parent after this file lands — typed Link/navigate cannot
 * reference them until then.
 *
 * API (verified in apps/api/src/app.ts):
 *  - GET /api/v1/admin/subscriptions — subscriptions.read; embeds
 *    customer/product + next_renewal_display. Returns { items: [...] }.
 *  - GET /api/v1/admin/subscriptions/:id — subscriptions.read; embeds
 *    customer/product + renewal_invoices.
 *  - POST /api/v1/admin/subscriptions/:id/renewal-invoices —
 *    subscriptions.manage; idempotent, creates a renewal order + invoice.
 *    It does NOT extend the period until the payment is verified.
 *  - POST /api/v1/admin/subscriptions/:id/{pause|resume|cancel} —
 *    subscriptions.manage.
 * No expiry/renewal automation exists yet (Batch 3) — nothing here
 * claims otherwise.
 */
import { useMemo } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, RefreshCw } from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { detailKey, listKey } from "../lib/query";
import {
  DetailFacts,
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminDetail,
  useAdminList,
  useAdminMutation,
} from "../lib/section-kit";
import {
  Button,
  CopyButton,
  DateCell,
  EmptyState,
  ErrorState,
  MoneyCell,
  Select,
  StatusBadge,
  TableSkeleton,
  useConfirm,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* DTOs (shapes verified against apps/api/src/app.ts + store.ts)        */
/* ------------------------------------------------------------------ */
interface CustomerRef {
  id: string;
  name: string;
  email: string;
}

interface ProductRef {
  id: string;
  name: string;
  code: string;
}

interface SubscriptionPeriod {
  id: string;
  period_number: number;
  period_start: string;
  period_end: string;
  status: string;
}

interface RenewalInvoice {
  id: string;
  invoice_number: string;
  invoice_type: string;
  status: string;
  currency_code: string;
  total_minor: number;
  amount_due_minor: number;
  issued_at: string;
  paid_at: string | null;
}

interface SubscriptionListItem {
  id: string;
  subscription_number: string;
  customer_id: string;
  product_id: string;
  status: string;
  billing_kind: string;
  interval_unit: string | null;
  interval_count: number | null;
  currency_code: string;
  unit_amount_minor: number;
  current_period_start: string | null;
  current_period_end: string | null;
  next_renewal_at: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  created_at: string;
  customer: CustomerRef | null;
  product: ProductRef | null;
  next_renewal_display: string | null;
}

interface SubscriptionDetail extends SubscriptionListItem {
  source_order_item_id: string | null;
  periods: SubscriptionPeriod[];
  renewal_invoices: RenewalInvoice[];
}

const SUBSCRIPTION_STATUSES = [
  "trialing",
  "pending",
  "active",
  "past_due",
  "paused",
  "cancelled",
  "expired",
] as const;

function sentenceCase(value: string): string {
  const words = value.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function billingLabel(item: SubscriptionListItem): string {
  if (item.interval_unit && item.interval_count) {
    const unit = item.interval_count > 1 ? `${item.interval_unit}s` : item.interval_unit;
    return `Every ${item.interval_count} ${unit}`;
  }
  return sentenceCase(item.billing_kind);
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */
export function SubscriptionsSection() {
  const router = useRouter();
  const rawSearch = useSearch({ strict: false }) as unknown as Record<string, unknown>;
  const parsed = parseListSearch(rawSearch);
  const page = parsed.page ?? 1;
  const pageSize = parsed.pageSize ?? 25;
  const statusParam = typeof rawSearch.status === "string" ? rawSearch.status : "all";
  const statusFilter = (SUBSCRIPTION_STATUSES as readonly string[]).includes(statusParam)
    ? statusParam
    : "all";

  const query = useAdminList<SubscriptionListItem>(
    "subscriptions",
    "/api/v1/admin/subscriptions",
  );

  const updateSearch = (patch: {
    q?: string;
    page?: number;
    pageSize?: number;
    status?: string;
  }) => {
    const nextQ = patch.q !== undefined ? patch.q : parsed.q;
    const nextPage = patch.page !== undefined ? patch.page : page;
    const nextPageSize = patch.pageSize !== undefined ? patch.pageSize : pageSize;
    const nextStatus = patch.status !== undefined ? patch.status : statusFilter;
    const params = new URLSearchParams();
    if (nextQ) params.set("q", nextQ);
    if (nextPage > 1) params.set("page", String(nextPage));
    if (nextPageSize !== 25) params.set("pageSize", String(nextPageSize));
    if (nextStatus !== "all") params.set("status", nextStatus);
    const qs = params.toString();
    router.history.push(`/subscriptions${qs ? `?${qs}` : ""}`);
  };

  const filtered = useMemo(() => {
    const items = query.data ?? [];
    if (statusFilter === "all") return items;
    return items.filter((s) => s.status === statusFilter);
  }, [query.data, statusFilter]);

  const columns: ColumnDef<SubscriptionListItem, unknown>[] = useMemo(
    () => [
      {
        accessorKey: "subscription_number",
        header: "Subscription",
        cell: ({ row }) => (
          <span className="sm-mono">
            {row.original.subscription_number}
            <CopyButton
              value={row.original.subscription_number}
              label="Copy subscription number"
            />
          </span>
        ),
      },
      {
        accessorKey: "customer",
        header: "Customer",
        enableSorting: false,
        cell: ({ row }) => (
          <span>
            {row.original.customer?.name ?? "—"}
            <span className="sm-hint">
              {row.original.customer ? ` ${row.original.customer.email}` : ""}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "product",
        header: "Product",
        enableSorting: false,
        cell: ({ row }) => (
          <span>
            {row.original.product?.name ?? "—"}
            <span className="sm-hint">
              {row.original.product ? ` ${row.original.product.code}` : ""}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "billing",
        header: "Billing",
        cell: ({ row }) => billingLabel(row.original),
      },
      {
        accessorKey: "unit_amount_minor",
        header: "Amount",
        cell: ({ row }) => (
          <MoneyCell
            currency={row.original.currency_code}
            minor={row.original.unit_amount_minor}
          />
        ),
      },
      {
        accessorKey: "next_renewal_at",
        header: "Next renewal",
        cell: ({ row }) => <DateCell value={row.original.next_renewal_at} />,
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            icon={Eye}
            onClick={() => router.history.push(`/subscriptions/${row.original.id}`)}
          >
            View
          </Button>
        ),
      },
    ],
    [router],
  );

  return (
    <section aria-labelledby="subscriptions-heading">
      <PageHeader
        breadcrumb={[{ label: "Subscriptions" }]}
        title="Subscriptions"
        subtitle="Recurring and lifetime subscriptions"
      />
      <ListTable
        columns={columns}
        data={filtered}
        search={parsed.q ?? ""}
        onSearchChange={(q) => updateSearch({ q, page: 1 })}
        page={page}
        onPageChange={(page) => updateSearch({ page })}
        pageSize={pageSize}
        onPageSizeChange={(pageSize) => updateSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={RefreshCw}
        emptyTitle="No subscriptions yet"
        emptyBody="Subscriptions appear here when a customer buys a recurring product."
        toolbar={
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => updateSearch({ status: e.target.value, page: 1 })}
          >
            <option value="all">All statuses</option>
            {SUBSCRIPTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {sentenceCase(s)}
              </option>
            ))}
          </Select>
        }
        getRowId={(row) => row.id}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */
export function SubscriptionDetailSection({ id }: { id: string }) {
  const confirm = useConfirm();
  const query = useAdminDetail<SubscriptionDetail>(
    "subscriptions",
    id,
    `/api/v1/admin/subscriptions/${id}`,
  );

  const lifecycle = useAdminMutation<unknown, string>({
    mutationFn: (action) =>
      apiRequest(`/api/v1/admin/subscriptions/${id}/${action}`, { method: "POST" }),
    invalidateKeys: [detailKey("subscriptions", id), listKey("subscriptions")],
    successTitle: "Subscription updated",
  });

  const renewalInvoice = useAdminMutation<unknown, void>({
    mutationFn: () =>
      apiRequest(`/api/v1/admin/subscriptions/${id}/renewal-invoices`, {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
      }),
    invalidateKeys: [detailKey("subscriptions", id), listKey("subscriptions")],
    successTitle: "Renewal invoice created",
    successMessage: "The period is not extended until the payment is verified.",
  });

  const askLifecycle = async (
    action: "pause" | "resume" | "cancel",
    title: string,
    body: string,
  ) => {
    const ok = await confirm({
      title,
      body,
      confirmLabel:
        action === "cancel" ? "Cancel subscription" : sentenceCase(action),
      danger: action === "cancel",
    });
    if (ok) lifecycle.mutate(action);
  };

  if (query.isPending) {
    return (
      <section aria-labelledby="subscription-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Subscriptions", href: "/subscriptions" }, { label: "…" }]}
          title="Subscription"
        />
        <TableSkeleton rows={6} />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section aria-labelledby="subscription-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Subscriptions", href: "/subscriptions" }, { label: "Not found" }]}
          title="Subscription"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={
              query.error instanceof Error ? query.error.message : "Subscription not found."
            }
            onRetry={() => void query.refetch()}
          />
        </div>
      </section>
    );
  }

  const sub = query.data;
  const busy = lifecycle.isPending || renewalInvoice.isPending;

  return (
    <section aria-labelledby="subscription-detail-heading">
      <PageHeader
        breadcrumb={[
          { label: "Subscriptions", href: "/subscriptions" },
          { label: sub.subscription_number },
        ]}
        title={`Subscription ${sub.subscription_number}`}
        subtitle="Subscription detail and renewal invoices"
        action={
          <>
            <StatusBadge status={sub.status} />
            {sub.status === "active" ? (
              <Button
                variant="secondary"
                disabled={busy}
                loading={lifecycle.isPending && lifecycle.variables === "pause"}
                onClick={() =>
                  void askLifecycle(
                    "pause",
                    "Pause subscription?",
                    "Billing pauses and the subscription status becomes Paused. It can be resumed later.",
                  )
                }
              >
                Pause
              </Button>
            ) : null}
            {sub.status === "paused" ? (
              <Button
                variant="primary"
                disabled={busy}
                loading={lifecycle.isPending && lifecycle.variables === "resume"}
                onClick={() =>
                  void askLifecycle(
                    "resume",
                    "Resume subscription?",
                    "Billing resumes and the subscription status becomes Active.",
                  )
                }
              >
                Resume
              </Button>
            ) : null}
            {sub.status === "active" || sub.status === "paused" ? (
              <Button
                variant="danger"
                disabled={busy}
                loading={lifecycle.isPending && lifecycle.variables === "cancel"}
                onClick={() =>
                  void askLifecycle(
                    "cancel",
                    "Cancel subscription?",
                    "The subscription status becomes Cancelled. No further renewal invoices are generated for it.",
                  )
                }
              >
                Cancel
              </Button>
            ) : null}
            {sub.billing_kind === "recurring" && sub.status === "active" ? (
              <Button
                variant="secondary"
                disabled={busy}
                loading={renewalInvoice.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: "Generate renewal invoice?",
                    body: "This creates a renewal order and invoice for the next period. The period is NOT extended until the customer's payment is verified and approved.",
                    confirmLabel: "Generate invoice",
                  });
                  if (ok) renewalInvoice.mutate();
                }}
              >
                Generate renewal invoice
              </Button>
            ) : null}
          </>
        }
      />
      <DetailFacts
        facts={[
          {
            label: "Customer",
            value: sub.customer ? `${sub.customer.name} (${sub.customer.email})` : "—",
          },
          {
            label: "Product",
            value: sub.product ? `${sub.product.name} (${sub.product.code})` : "—",
          },
          { label: "Billing", value: billingLabel(sub) },
          {
            label: "Amount",
            value: <MoneyCell currency={sub.currency_code} minor={sub.unit_amount_minor} />,
          },
          { label: "Current period", value: <DateCell value={sub.current_period_end} /> },
          { label: "Next renewal", value: <DateCell value={sub.next_renewal_at} /> },
          {
            label: "Cancel at period end",
            value: sub.cancel_at_period_end ? "Yes" : "No",
          },
          { label: "Created", value: <DateCell value={sub.created_at} /> },
        ]}
      />
      <p className="sm-hint">
        Renewal is manual — no automatic renewal runs yet. A renewal invoice only
        extends the period once its payment is verified.
      </p>

      <div className="sm-card">
        <h2 className="sm-card-title">Renewal invoices</h2>
        {sub.renewal_invoices.length === 0 ? (
          <EmptyState
            icon={RefreshCw}
            title="No renewal invoices"
            body="No renewal invoice has been generated for this subscription yet."
          />
        ) : (
          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Total</th>
                  <th scope="col">Due</th>
                  <th scope="col">Issued</th>
                  <th scope="col">Paid</th>
                </tr>
              </thead>
              <tbody>
                {sub.renewal_invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <span className="sm-mono">
                        {inv.invoice_number}
                        <CopyButton value={inv.invoice_number} label="Copy invoice number" />
                      </span>
                    </td>
                    <td>{sentenceCase(inv.invoice_type)}</td>
                    <td>
                      <StatusBadge status={inv.status} />
                    </td>
                    <td>
                      <MoneyCell currency={inv.currency_code} minor={inv.total_minor} />
                    </td>
                    <td>
                      <MoneyCell currency={inv.currency_code} minor={inv.amount_due_minor} />
                    </td>
                    <td>
                      <DateCell value={inv.issued_at} />
                    </td>
                    <td>
                      <DateCell value={inv.paid_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="sm-card">
        <h2 className="sm-card-title">Billing periods</h2>
        {sub.periods.length === 0 ? (
          <EmptyState
            icon={RefreshCw}
            title="No billing periods"
            body="This subscription has no billing periods recorded."
          />
        ) : (
          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Start</th>
                  <th scope="col">End</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {sub.periods.map((p) => (
                  <tr key={p.id}>
                    <td className="sm-tabular">{p.period_number}</td>
                    <td>
                      <DateCell value={p.period_start} />
                    </td>
                    <td>
                      <DateCell value={p.period_end} />
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
