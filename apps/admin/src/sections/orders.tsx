/**
 * Orders & Invoices — list + detail (design spec §4.1/§4.2).
 *
 * Routes (wired by the parent): /orders, /orders/$orderId.
 * Endpoints (verified in apps/api/src/app.ts):
 *  - GET  /api/v1/admin/orders                          orders.read
 *         (?payment_status=… server filter also exists)
 *  - GET  /api/v1/admin/orders/:id                      orders.read
 *         (embeds customer + invoices + payment_submissions)
 *  - POST /api/v1/admin/orders/:id/cancel              orders.manage
 *         (409 for completed/cancelled/failed/paid orders and for an
 *         order with a submission under verification)
 *  - POST /api/v1/admin/orders/:id/complete            orders.manage
 *         (409 unless payment_status is paid — completion never
 *         bypasses payment verification)
 *  - GET  /api/v1/admin/orders/:id/invoices            orders.read
 *  - POST /api/v1/admin/orders/:id/invoices            orders.manage
 *         (201; 409 if a live initial invoice already exists)
 *  - GET  /api/v1/admin/invoices/:id                   orders.read
 *         (embeds order + customer)
 *  - POST /api/v1/admin/invoices/:id/void              orders.manage
 *         (open/draft only in this UI; paid invoices need a credit-note
 *         workflow that does not exist — the UI says so)
 *
 * The staff-recorded manual-payment claim form is NOT built here — it
 * lives in Payment Review (another agent owns it). This detail page
 * links there instead.
 *
 * Route-search note: the /orders routes are not registered in router.tsx
 * yet, so a literal useSearch({ from: "/orders" }) does not typecheck
 * (probe-verified: TS2322). Until the parent wires the routes, search is
 * read with useSearch({ strict: false }) and written with navigate({ search })
 * cast to never — both resolve by path at runtime and keep working once
 * the routes (with validateSearch) are registered. The cast can then be
 * dropped.
 */
import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Receipt, ShoppingCart } from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { detailKey, listKey } from "../lib/query";
import {
  DetailFacts,
  DetailLayout,
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminDetail,
  useAdminList,
  useAdminMutation,
  type ListSearch,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  Card,
  CopyButton,
  DateCell,
  DateTimeCell,
  Dialog,
  EmptyState,
  ErrorState,
  MoneyCell,
  Select,
  StatusBadge,
  TableSkeleton,
  useConfirm,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* DTOs (apps/api/src/platform/db/store.ts record shapes)              */
/* ------------------------------------------------------------------ */
export interface OrderCustomerDto {
  id: string;
  customer_number: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface OrderItemDto {
  id: string;
  product_name_snapshot: string;
  package_name_snapshot: string | null;
  package_version_snapshot: number | null;
  price_kind_snapshot: string;
  quantity: number;
  unit_amount_minor: number;
  line_total_minor: number;
  currency_code: string;
}

export interface OrderDto {
  id: string;
  order_number: string;
  public_reference: string;
  customer_id: string;
  source: string;
  status: string;
  payment_status: string;
  currency_code: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  customer_note: string | null;
  internal_note: string | null;
  items: OrderItemDto[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface OrderListDto extends Omit<OrderDto, "items"> {
  customer: OrderCustomerDto | null;
  created_date_display?: string;
}

export interface InvoiceDto {
  id: string;
  invoice_number: string;
  customer_id: string;
  order_id: string | null;
  subscription_id: string | null;
  invoice_type: string;
  status: string;
  currency_code: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  amount_paid_minor: number;
  amount_due_minor: number;
  issued_at: string;
  paid_at: string | null;
  items: {
    id: string;
    description_snapshot: string;
    quantity: number;
    unit_amount_minor: number;
    line_amount_minor: number;
    currency_code: string;
  }[];
  created_at: string;
}

export interface PaymentSubmissionDto {
  id: string;
  order_id: string;
  customer_id: string;
  payment_method_id: string;
  amount_minor: number;
  currency_code: string;
  sender_name: string | null;
  sender_phone: string | null;
  transaction_reference: string | null;
  payment_date: string | null;
  duplicate_risk_Warning: boolean;
  status: string;
  customer_note: string | null;
  submitted_at: string;
  reviewed_at: string | null;
}

export interface OrderDetailDto extends OrderDto {
  customer: OrderCustomerDto | null;
  invoices: InvoiceDto[];
  payment_submissions: PaymentSubmissionDto[];
}

export interface InvoiceDetailDto extends InvoiceDto {
  order: OrderDto | null;
  customer: OrderCustomerDto | null;
}

/* ------------------------------------------------------------------ */
/* Navigation helpers (see the route-search note above)                */
/* ------------------------------------------------------------------ */
function useGoTo() {
  const navigate = useNavigate();
  return (to: string) => {
    void navigate({ to } as never);
  };
}

function useListSearchControls(parsed: ListSearch) {
  const navigate = useNavigate();
  const update = (patch: Record<string, unknown>) => {
    void navigate({
      search: { ...parsed, ...patch },
    } as never);
  };
  return update;
}

const PAYMENT_STATUS_OPTIONS = [
  "unpaid",
  "pending_verification",
  "paid",
  "partially_refunded",
  "refunded",
] as const;

/* ------------------------------------------------------------------ */
/* Orders list                                                         */
/* ------------------------------------------------------------------ */
export function OrdersSection() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const parsed = parseListSearch(rawSearch);
  const paymentFilter =
    typeof rawSearch.payment_status === "string" &&
    (PAYMENT_STATUS_OPTIONS as readonly string[]).includes(rawSearch.payment_status)
      ? rawSearch.payment_status
      : "";
  const updateSearch = useListSearchControls(parsed);
  const goTo = useGoTo();
  const query = useAdminList<OrderListDto>("orders", "/api/v1/admin/orders");

  const columns: ColumnDef<OrderListDto, unknown>[] = [
    {
      accessorKey: "order_number",
      header: "Order",
      cell: ({ row }) => {
        const o = row.original;
        return (
          <div>
            <div>
              <span className="sm-mono">{o.order_number}</span>
              <CopyButton value={o.order_number} label="Copy order number" />
            </div>
            <div className="sm-hint">{o.source}</div>
          </div>
        );
      },
    },
    {
      accessorKey: "customer",
      header: "Customer",
      cell: ({ row }) => {
        const c = row.original.customer;
        if (!c) return "—";
        return (
          <div>
            <div>{c.name}</div>
            <div className="sm-hint">{c.email ?? c.customer_number}</div>
          </div>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "payment_status",
      header: "Payment",
      cell: ({ row }) => <StatusBadge status={row.original.payment_status} />,
    },
    {
      accessorKey: "total_minor",
      header: "Total",
      cell: ({ row }) => (
        <MoneyCell
          currency={row.original.currency_code}
          minor={row.original.total_minor}
        />
      ),
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateCell value={row.original.created_at} />,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => goTo(`/orders/${row.original.id}`)}>
          View
        </Button>
      ),
    },
  ];

  const filtered =
    paymentFilter === ""
      ? query.data
      : query.data?.filter((o) => o.payment_status === paymentFilter);

  return (
    <section aria-labelledby="orders-heading">
      <PageHeader
        breadcrumb={[{ label: "Commerce" }, { label: "Orders & Invoices" }]}
        title="Orders & Invoices"
        subtitle="Orders placed through admin, website, API, or import"
      />
      <ListTable<OrderListDto>
        columns={columns}
        data={filtered}
        search={parsed.q ?? ""}
        onSearchChange={(q) => updateSearch({ q: q === "" ? undefined : q, page: 1 })}
        page={parsed.page ?? 1}
        onPageChange={(page) => updateSearch({ page })}
        pageSize={parsed.pageSize ?? 25}
        onPageSizeChange={(pageSize) => updateSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={ShoppingCart}
        emptyTitle="No orders yet"
        emptyBody="Orders appear here once one is placed."
        toolbar={
          <Select
            value={paymentFilter}
            onChange={(e) =>
              updateSearch({
                payment_status:
                  e.target.value === "" ? undefined : e.target.value,
                page: 1,
              })
            }
            aria-label="Filter by payment status"
          >
            <option value="">All payment statuses</option>
            {PAYMENT_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
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
/* Order detail                                                        */
/* ------------------------------------------------------------------ */
const TERMINAL_STATUSES = ["completed", "cancelled", "failed"];

export function OrderDetailSection({ id }: { id: string }) {
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const confirm = useConfirm();
  const goTo = useGoTo();
  const query = useAdminDetail<OrderDetailDto>(
    "orders",
    id,
    `/api/v1/admin/orders/${id}`,
  );

  const cancelMutation = useAdminMutation<OrderDetailDto, void>({
    mutationFn: () =>
      apiRequest<OrderDetailDto>(`/api/v1/admin/orders/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    invalidateKeys: [listKey("orders"), detailKey("orders", id)],
    successTitle: "Order cancelled",
    successMessage: "The order is now cancelled.",
  });

  const completeMutation = useAdminMutation<OrderDetailDto, void>({
    mutationFn: () =>
      apiRequest<OrderDetailDto>(`/api/v1/admin/orders/${id}/complete`, {
        method: "POST",
      }),
    invalidateKeys: [listKey("orders"), detailKey("orders", id)],
    successTitle: "Order completed",
    successMessage: "The order is now completed.",
  });

  const createInvoiceMutation = useAdminMutation<InvoiceDto, void>({
    mutationFn: () =>
      apiRequest<InvoiceDto>(`/api/v1/admin/orders/${id}/invoices`, {
        method: "POST",
      }),
    invalidateKeys: [listKey("orders"), detailKey("orders", id)],
    successTitle: "Invoice created",
    successMessage: "An initial invoice was created for this order.",
  });

  const voidMutation = useAdminMutation<InvoiceDto, string>({
    mutationFn: (invoiceIdToVoid) =>
      apiRequest<InvoiceDto>(`/api/v1/admin/invoices/${invoiceIdToVoid}/void`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    invalidateKeys: [listKey("orders"), detailKey("orders", id)],
    successTitle: "Invoice voided",
    successMessage: "The invoice is now void.",
  });

  if (query.isPending) {
    return (
      <section aria-labelledby="order-heading">
        <PageHeader
          breadcrumb={[{ label: "Orders", href: "/orders" }, { label: "…" }]}
          title="Order"
        />
        <TableSkeleton rows={5} />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section aria-labelledby="order-heading">
        <PageHeader
          breadcrumb={[{ label: "Orders", href: "/orders" }, { label: "Order" }]}
          title="Order"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={
              query.error instanceof Error
                ? query.error.message
                : "Could not load this order."
            }
            onRetry={() => void query.refetch()}
          />
        </div>
      </section>
    );
  }

  const order = query.data;
  const liveInitial = order.invoices.find(
    (i) => i.invoice_type === "initial" && i.status !== "void",
  );
  const hasPaidInvoice = order.invoices.some((i) => i.status === "paid");
  const pendingSubmission = order.payment_submissions.some((s) =>
    ["submitted", "under_review"].includes(s.status),
  );
  const canComplete =
    order.payment_status === "paid" && !TERMINAL_STATUSES.includes(order.status);
  const canCancel =
    !TERMINAL_STATUSES.includes(order.status) &&
    order.payment_status !== "paid" &&
    !pendingSubmission;
  const cancelBlockReason = TERMINAL_STATUSES.includes(order.status)
    ? `A ${order.status} order cannot be cancelled.`
    : order.payment_status === "paid"
      ? "Paid orders cannot be cancelled. Issue a refund through the financial workflow instead."
      : pendingSubmission
        ? "A payment submission for this order is still under verification. Approve or reject it first."
        : null;

  const onCancel = () => {
    void (async () => {
      const ok = await confirm({
        title: `Cancel order ${order.order_number}?`,
        body: (
          <div>
            <p>The order will become Cancelled.</p>
            <p>It cannot be completed afterwards.</p>
            <p>Its invoices stay as they are — void them separately if needed.</p>
          </div>
        ),
        confirmLabel: "Cancel order",
        danger: true,
      });
      if (ok) cancelMutation.mutate();
    })();
  };

  const onComplete = () => {
    void (async () => {
      const ok = await confirm({
        title: `Complete order ${order.order_number}?`,
        body: (
          <div>
            <p>The order will become Completed.</p>
            <p>Payment is verified (paid) — completion does not bypass payment verification.</p>
          </div>
        ),
        confirmLabel: "Complete order",
      });
      if (ok) completeMutation.mutate();
    })();
  };

  const onCreateInvoice = () => {
    void (async () => {
      const ok = await confirm({
        title: `Create an initial invoice for ${order.order_number}?`,
        body: (
          <p>
            An initial invoice for the order total will be created. Only one live
            initial invoice can exist per order.
          </p>
        ),
        confirmLabel: "Create invoice",
      });
      if (ok) createInvoiceMutation.mutate();
    })();
  };

  const onVoidInvoice = (invoice: InvoiceDto) => {
    void (async () => {
      const ok = await confirm({
        title: `Void invoice ${invoice.invoice_number}?`,
        body: (
          <div>
            <p>The invoice will become Void and can no longer be collected.</p>
            <p>This cannot be undone.</p>
          </div>
        ),
        confirmLabel: "Void invoice",
        danger: true,
      });
      if (ok) voidMutation.mutate(invoice.id);
    })();
  };

  return (
    <section aria-labelledby="order-heading">
      <PageHeader
        breadcrumb={[{ label: "Orders", href: "/orders" }, { label: order.order_number }]}
        title={`Order ${order.order_number}`}
        subtitle={`${order.public_reference} · ${order.source}`}
        action={
          <>
            {canComplete ? (
              <Button
                variant="accent"
                loading={completeMutation.isPending}
                onClick={onComplete}
              >
                Complete order
              </Button>
            ) : null}
            {canCancel ? (
              <Button
                variant="danger-ghost"
                loading={cancelMutation.isPending}
                onClick={onCancel}
              >
                Cancel order
              </Button>
            ) : null}
          </>
        }
      />
      <DetailLayout
        title="Order"
        facts={[
          { label: "Status", value: <StatusBadge status={order.status} /> },
          { label: "Payment", value: <StatusBadge status={order.payment_status} /> },
          {
            label: "Customer",
            value: order.customer ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => goTo(`/customers/${order.customer?.id}`)}
              >
                {order.customer.name}
              </Button>
            ) : (
              "—"
            ),
          },
          {
            label: "Total",
            value: <MoneyCell currency={order.currency_code} minor={order.total_minor} />,
          },
          { label: "Created", value: <DateCell value={order.created_at} /> },
          {
            label: order.completed_at ? "Completed" : order.cancelled_at ? "Cancelled" : "Updated",
            value: (
              <DateCell
                value={order.completed_at ?? order.cancelled_at ?? order.updated_at}
              />
            ),
          },
        ]}
      >
        {order.payment_status !== "paid" && !TERMINAL_STATUSES.includes(order.status) ? (
          <Alert variant="info">
            This order cannot be completed yet — completion requires a verified
            payment, and payment is {order.payment_status.replace(/_/g, " ")}.
            Verify the payment in Payment Review first.
          </Alert>
        ) : null}
        {cancelBlockReason && !canCancel ? (
          <Alert variant="warning">{cancelBlockReason}</Alert>
        ) : null}
        <Card title="Items">
          {order.items.length === 0 ? (
            <EmptyState
              icon={ShoppingCart}
              title="No items"
              body="This order has no line items."
            />
          ) : (
            <div className="sm-table-wrap">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Package</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Unit</th>
                    <th scope="col">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.product_name_snapshot}</td>
                      <td>
                        {item.package_name_snapshot ?? "—"}
                        {item.package_version_snapshot !== null
                          ? ` (v${item.package_version_snapshot})`
                          : ""}
                      </td>
                      <td>{item.quantity}</td>
                      <td>
                        <MoneyCell
                          currency={item.currency_code}
                          minor={item.unit_amount_minor}
                        />
                      </td>
                      <td>
                        <MoneyCell
                          currency={item.currency_code}
                          minor={item.line_total_minor}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(order.discount_minor > 0 || order.tax_minor > 0) ? (
            <p className="sm-hint">
              Subtotal{" "}
              <MoneyCell currency={order.currency_code} minor={order.subtotal_minor} />
              {order.discount_minor > 0 ? (
                <>
                  {" · Discount "}
                  <MoneyCell currency={order.currency_code} minor={order.discount_minor} />
                </>
              ) : null}
              {order.tax_minor > 0 ? (
                <>
                  {" · Tax "}
                  <MoneyCell currency={order.currency_code} minor={order.tax_minor} />
                </>
              ) : null}
            </p>
          ) : null}
        </Card>
        <Card
          title="Invoices"
          actions={
            liveInitial ? undefined : (
              <Button
                variant="secondary"
                loading={createInvoiceMutation.isPending}
                onClick={onCreateInvoice}
              >
                Create invoice
              </Button>
            )
          }
        >
          {liveInitial ? (
            <p className="sm-hint">
              Live initial invoice: {liveInitial.invoice_number} (
              {liveInitial.status}). A second live initial invoice cannot be
              created.
            </p>
          ) : null}
          {order.invoices.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No invoices yet"
              body="This order has no invoices. Order creation normally creates an initial invoice."
              actionLabel="Create invoice"
              onAction={onCreateInvoice}
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
                    <th scope="col">
                      <span className="sm-hint">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {order.invoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td>
                        <span className="sm-mono">{invoice.invoice_number}</span>
                        <CopyButton
                          value={invoice.invoice_number}
                          label="Copy invoice number"
                        />
                      </td>
                      <td>{invoice.invoice_type.replace(/_/g, " ")}</td>
                      <td>
                        <StatusBadge status={invoice.status} />
                      </td>
                      <td>
                        <MoneyCell
                          currency={invoice.currency_code}
                          minor={invoice.total_minor}
                        />
                      </td>
                      <td>
                        <MoneyCell
                          currency={invoice.currency_code}
                          minor={invoice.amount_due_minor}
                        />
                      </td>
                      <td>
                        <DateCell value={invoice.issued_at} />
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setInvoiceId(invoice.id)}
                        >
                          View
                        </Button>{" "}
                        {invoice.status === "draft" || invoice.status === "open" ? (
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            loading={
                              voidMutation.isPending &&
                              voidMutation.variables === invoice.id
                            }
                            onClick={() => onVoidInvoice(invoice)}
                          >
                            Void
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {hasPaidInvoice ? (
            <p className="sm-hint">
              Paid invoices cannot be voided — a credit-note workflow does not
              exist yet.
            </p>
          ) : null}
        </Card>
        <Card
          title="Payment submissions"
          actions={
            <Button variant="secondary" onClick={() => goTo("/payment-review")}>
              Payment Review
            </Button>
          }
        >
          {order.payment_submissions.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No payment submissions"
              body="No manual payment claim has been submitted for this order. Staff record claims from Payment Review."
              actionLabel="Open Payment Review"
              onAction={() => goTo("/payment-review")}
            />
          ) : (
            <div className="sm-table-wrap">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th scope="col">Submitted</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Sender</th>
                    <th scope="col">Transaction ref</th>
                    <th scope="col">Status</th>
                    <th scope="col">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {order.payment_submissions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <DateTimeCell value={s.submitted_at} />
                      </td>
                      <td>
                        <MoneyCell currency={s.currency_code} minor={s.amount_minor} />
                      </td>
                      <td>
                        {s.sender_name ?? "—"}
                        {s.sender_phone ? (
                          <div className="sm-hint">{s.sender_phone}</div>
                        ) : null}
                      </td>
                      <td>
                        {s.transaction_reference ? (
                          <span>
                            <span className="sm-mono">{s.transaction_reference}</span>
                            <CopyButton
                              value={s.transaction_reference}
                              label="Copy transaction reference"
                            />
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <StatusBadge status={s.status} />
                      </td>
                      <td>
                        {s.duplicate_risk_Warning ? (
                          <StatusBadge status="warning" label="Duplicate risk" />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="sm-hint">
            A submission is a claim, not a payment — it is never shown as paid
            until staff verify it in Payment Review.
          </p>
        </Card>
        {invoiceId ? (
          <InvoiceDetailDialog
            invoiceId={invoiceId}
            onClose={() => setInvoiceId(null)}
          />
        ) : null}
      </DetailLayout>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Invoice detail dialog — GET /api/v1/admin/invoices/:id (orders.read)*/
/* ------------------------------------------------------------------ */
function InvoiceDetailDialog({
  invoiceId,
  onClose,
}: {
  invoiceId: string;
  onClose: () => void;
}) {
  const query = useAdminDetail<InvoiceDetailDto>(
    "invoices",
    invoiceId,
    `/api/v1/admin/invoices/${invoiceId}`,
  );

  return (
    <Dialog open onClose={onClose} title="Invoice" size="md">
      {query.isPending ? (
        <TableSkeleton rows={4} />
      ) : query.isError || !query.data ? (
        <ErrorState
          message={
            query.error instanceof Error
              ? query.error.message
              : "Could not load this invoice."
          }
          onRetry={() => void query.refetch()}
        />
      ) : (
        <div>
          <DetailFacts
            facts={[
              { label: "Invoice", value: query.data.invoice_number },
              { label: "Status", value: <StatusBadge status={query.data.status} /> },
              { label: "Type", value: query.data.invoice_type },
              {
                label: "Total",
                value: (
                  <MoneyCell
                    currency={query.data.currency_code}
                    minor={query.data.total_minor}
                  />
                ),
              },
              {
                label: "Paid",
                value: (
                  <MoneyCell
                    currency={query.data.currency_code}
                    minor={query.data.amount_paid_minor}
                  />
                ),
              },
              {
                label: "Due",
                value: (
                  <MoneyCell
                    currency={query.data.currency_code}
                    minor={query.data.amount_due_minor}
                  />
                ),
              },
              { label: "Issued", value: <DateCell value={query.data.issued_at} /> },
              {
                label: "Customer",
                value: query.data.customer?.name ?? "—",
              },
            ]}
          />
          {query.data.items.length > 0 ? (
            <div className="sm-table-wrap">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.description_snapshot}</td>
                      <td>{item.quantity}</td>
                      <td>
                        <MoneyCell
                          currency={item.currency_code}
                          minor={item.line_amount_minor}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
