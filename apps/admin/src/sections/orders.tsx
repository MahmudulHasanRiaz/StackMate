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
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Receipt, ShoppingCart } from "lucide-react";
import { apiRequest, formatMinorMoney } from "../lib/api-client";
import { ddmmyyyyToIso, isoToDdmmyyyy } from "../lib/dates";
import { detailKey, listKey, queryClient } from "../lib/query";
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
  Checkbox,
  CopyButton,
  DateCell,
  DateTimeCell,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MenuSelect,
  MoneyCell,
  Select,
  StatusBadge,
  TableSkeleton,
  Textarea,
  useConfirm,
} from "../components/primitives";
import {
  CollapsibleSection,
  CustomerFormFields,
  customerFormToCreateBody,
  emptyCustomerForm,
  validateCustomerForm,
  type CustomerDto,
  type CustomerFormValues,
} from "./customers";
import type { FeatureDto } from "./features";
import type { PackageDto, PackagePriceDto } from "./packages";

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
  // ADR-0009: activation policy + grace (stored on the order).
  activation_mode: "on_full_payment" | "on_percent" | "on_date";
  activation_percent: number | null;
  activation_date: string | null;
  suspend_on_missed_schedule: boolean;
  grace_days: number;
  payment_method_id: string | null;
  lead_id: string | null;
  items: OrderItemDto[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface OrderListDto extends Omit<OrderDto, "items"> {
  customer: OrderCustomerDto | null;
  paid_amount_minor?: number;
  remaining_minor?: number;
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

export interface OrderInstallmentDto {
  id: string;
  order_id: string;
  installment_number: number;
  amount_minor: number;
  due_date: string;
  due_date_display: string;
  status: "pending" | "partially_paid" | "paid" | "overdue";
  paid_amount_minor: number;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderDetailDto extends OrderDto {
  customer: OrderCustomerDto | null;
  paid_amount_minor: number;
  remaining_minor: number;
  installments: OrderInstallmentDto[];
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
  "partially_paid",
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
  // Opened from a lead conversion (?new=1&customer=<id>&lead=<id>) or
  // the Create order button. The wizard reads the same search params
  // for its prefill.
  const [wizardOpen, setWizardOpen] = useState(
    rawSearch.new === "1" || rawSearch.new === 1
  );
  const wizardPrefill =
    typeof rawSearch.customer === "string" && typeof rawSearch.lead === "string"
      ? { customerId: rawSearch.customer, leadId: rawSearch.lead }
      : typeof rawSearch.customer === "string"
        ? { customerId: rawSearch.customer, leadId: null }
        : null;

  const columns: ColumnDef<OrderListDto, unknown>[] = [
    {
      accessorKey: "order_number",
      header: "Order",
      cell: ({ row }) => {
        const o = row.original;
        return (
          <span className="sm-cell-line">
            <span className="sm-mono sm-cell-text">{o.order_number}</span>
            <CopyButton value={o.order_number} label="Copy order number" />
            <span className="sm-hint sm-cell-text">{o.source}</span>
          </span>
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
          <span className="sm-cell-line">
            <span className="sm-cell-text">{c.name}</span>
            <span className="sm-hint sm-cell-text">
              {c.email ?? c.customer_number}
            </span>
          </span>
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
      accessorKey: "paid_amount_minor",
      header: "Paid",
      cell: ({ row }) => (
        <MoneyCell
          currency={row.original.currency_code}
          minor={row.original.paid_amount_minor ?? 0}
        />
      ),
    },
    {
      accessorKey: "remaining_minor",
      header: "Due",
      cell: ({ row }) => (
        <MoneyCell
          currency={row.original.currency_code}
          minor={row.original.remaining_minor ?? row.original.total_minor}
        />
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
        help="Orders placed through admin, website, API, or import"
        action={
          <Button variant="primary" icon={Plus} onClick={() => setWizardOpen(true)}>
            Create order
          </Button>
        }
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
      {wizardOpen ? (
        <CreateOrderWizard
          prefill={wizardPrefill}
          onClose={() => setWizardOpen(false)}
          onCreated={(orderId) => {
            setWizardOpen(false);
            goTo(`/orders/${orderId}`);
          }}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Order detail                                                        */
/* ------------------------------------------------------------------ */
const TERMINAL_STATUSES = ["completed", "cancelled", "failed"];

export function OrderDetailSection({ id }: { id: string }) {
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [editInstallment, setEditInstallment] = useState<OrderInstallmentDto | null>(null);
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
        warning: "The order will become Cancelled.",
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
        warning: "The invoice will become Void and can no longer be collected.",
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
          {
            label: "Paid",
            value: (
              <MoneyCell currency={order.currency_code} minor={order.paid_amount_minor} />
            ),
          },
          {
            label: "Due",
            value: (
              <MoneyCell currency={order.currency_code} minor={order.remaining_minor} />
            ),
          },
          {
            label: "Activation",
            value:
              order.activation_mode === "on_percent"
                ? `On ${order.activation_percent}% paid`
                : order.activation_mode === "on_date"
                  ? `On ${order.activation_date ?? "—"}`
                  : "On full payment",
          },
          {
            label: "Grace days",
            value: `${order.grace_days} day${order.grace_days === 1 ? "" : "s"}`,
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
        <Card title="Payment plan">
          <p className="sm-hint">
            Total{" "}
            <MoneyCell currency={order.currency_code} minor={order.total_minor} />
            {" · Paid "}
            <MoneyCell currency={order.currency_code} minor={order.paid_amount_minor} />
            {" · Due "}
            <MoneyCell currency={order.currency_code} minor={order.remaining_minor} />
            {order.suspend_on_missed_schedule
              ? " · Licenses suspend when an installment passes its due date unpaid."
              : ""}
          </p>
          {order.installments.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No payment plan"
              body="This order has no installments yet."
            />
          ) : (
            <div className="sm-table-wrap">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Due date</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Paid</th>
                    <th scope="col">Remaining</th>
                    <th scope="col">Status</th>
                    <th scope="col">Timing</th>
                    <th scope="col">
                      <span className="sm-hint">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {order.installments.map((inst) => (
                    <tr key={inst.id}>
                      <td>{inst.installment_number}</td>
                      <td>{inst.due_date_display}</td>
                      <td>
                        <MoneyCell
                          currency={order.currency_code}
                          minor={inst.amount_minor}
                        />
                      </td>
                      <td>
                        <MoneyCell
                          currency={order.currency_code}
                          minor={inst.paid_amount_minor}
                        />
                      </td>
                      <td>
                        <MoneyCell
                          currency={order.currency_code}
                          minor={inst.amount_minor - inst.paid_amount_minor}
                        />
                      </td>
                      <td>
                        <StatusBadge status={inst.status} />
                      </td>
                      <td>{installmentTiming(inst)}</td>
                      <td>
                        {inst.status !== "paid" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditInstallment(inst)}
                          >
                            Edit due date
                          </Button>
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
                        <DateTimeCell value={invoice.issued_at} />
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
        {editInstallment ? (
          <EditInstallmentDialog
            orderId={order.id}
            installment={editInstallment}
            currency={order.currency_code}
            onClose={() => setEditInstallment(null)}
          />
        ) : null}
      </DetailLayout>
    </section>
  );
}

/** Early / on-time / late vs the due date (ADR-0009). */
function installmentTiming(i: OrderInstallmentDto): string {
  if (i.status === "paid" && i.paid_at) {
    const paidDay = i.paid_at.slice(0, 10);
    if (paidDay < i.due_date) return "Early";
    if (paidDay === i.due_date) return "On time";
    return "Late";
  }
  if (i.status === "overdue") return "Overdue";
  const today = new Date().toISOString().slice(0, 10);
  if (i.due_date < today) return "Overdue";
  return "—";
}

/* ------------------------------------------------------------------ */
/* Edit installment due date — PATCH .../installments/:id              */
/* ------------------------------------------------------------------ */
function EditInstallmentDialog({
  orderId,
  installment,
  currency,
  onClose,
}: {
  orderId: string;
  installment: OrderInstallmentDto;
  currency: string;
  onClose: () => void;
}) {
  const [dueDate, setDueDate] = useState(installment.due_date_display);
  const [notes, setNotes] = useState(installment.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  const mutation = useAdminMutation<OrderInstallmentDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<OrderInstallmentDto>(
        `/api/v1/admin/orders/${orderId}/installments/${installment.id}`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    invalidateKeys: [listKey("orders"), detailKey("orders", orderId)],
    successTitle: "Installment updated",
    onSuccess: () => onClose(),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const iso = ddmmyyyyToIso(dueDate);
    if (!iso) {
      setError("Due date must be DD/MM/YYYY.");
      return;
    }
    setError(null);
    mutation.mutate({
      due_date: iso,
      notes: notes.trim() === "" ? null : notes.trim(),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit installment #${installment.installment_number}`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            type="submit"
            form="edit-installment-form"
            loading={mutation.isPending}
          >
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-installment-form" onSubmit={onSubmit} aria-label="Edit installment">
        {mutation.isError ? (
          <Alert variant="danger">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Could not save the installment."}
          </Alert>
        ) : null}
        <Field label="Due date" required hint="DD/MM/YYYY." error={error ?? ""}>
          <Input
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            placeholder="15/11/2026"
            maxLength={10}
          />
        </Field>
        <Field label="Amount (read-only)">
          <Input
            value={formatMinorMoney(installment.amount_minor, currency)}
            disabled
          />
        </Field>
        <Field label="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={1000}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** Today as DD/MM/YYYY in the browser's local date. */
export function todayDdmmyyyy(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
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

/* ------------------------------------------------------------------ */
/* Create Order wizard — POST /api/v1/admin/orders (orders.manage)     */
/*                                                                     */
/* Steps: (1) Customer — existing or inline new (same fields +        */
/* dedupe as Add Customer); (2) Item — package or custom offer;        */
/* (3) Payment plan — full / advance+rest / equal installments;        */
/* (4) Activation policy + payment method + optional first payment;    */
/* (5) Review → create.                                                */
/*                                                                     */
/* The wizard never bypasses verification: an optional first payment   */
/* is recorded as a staff claim AFTER the order is created, and still  */
/* needs approval in Payment Review. The order starts                   */
/* awaiting_payment/unpaid.                                            */
/* ------------------------------------------------------------------ */
interface WizardProductDto {
  id: string;
  name: string;
  status: string;
}

interface WizardPaymentMethodDto {
  id: string;
  display_name: string;
  is_enabled: boolean;
  method_kind: string;
}

interface WizardPrefill {
  customerId: string | null;
  leadId: string | null;
}

interface PlanPreviewRow {
  n: number;
  amount: number;
  due: string;
}

function parseFeatureValue(raw: string): unknown {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function CreateOrderWizard({
  prefill,
  onClose,
  onCreated,
}: {
  prefill: WizardPrefill | null;
  onClose: () => void;
  onCreated: (orderId: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdOrderId, setCreatedOrderId] = useState<string | null>(null);

  /* Step 1 — customer */
  const [customerMode, setCustomerMode] = useState<"existing" | "new">("existing");
  const [customerId, setCustomerId] = useState(prefill?.customerId ?? "");
  const [customerSearch, setCustomerSearch] = useState("");
  const [newCustomer, setNewCustomer] = useState<CustomerFormValues>(emptyCustomerForm);
  const [customerErrors, setCustomerErrors] = useState<Record<string, string>>({});
  const customersQuery = useAdminList<CustomerDto>("customers", "/api/v1/admin/customers");
  const customerOptions = (customersQuery.data ?? []).filter((c) => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q) ||
      (c.phone ?? "").includes(q)
    );
  });

  /* Step 2 — item */
  const [itemKind, setItemKind] = useState<"package" | "custom">("package");
  const [productId, setProductId] = useState("");
  const [packageId, setPackageId] = useState("");
  const [priceId, setPriceId] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customPriceKind, setCustomPriceKind] = useState<
    "one_time" | "recurring" | "lifetime" | "free"
  >("one_time");
  const [customFeatures, setCustomFeatures] = useState<
    { featureId: string; value: string }[]
  >([{ featureId: "", value: "" }]);
  const [quantity, setQuantity] = useState("1");
  const [discount, setDiscount] = useState("0");
  const [tax, setTax] = useState("0");
  const [notes, setNotes] = useState("");
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const productsQuery = useAdminList<WizardProductDto>("products", "/api/v1/admin/products");
  const packagesQuery = useQuery({
    queryKey: ["admin", "products", productId, "packages"],
    queryFn: async () => {
      const res = await apiRequest<{ items: PackageDto[] }>(
        `/api/v1/admin/products/${productId}/packages`,
      );
      return res.items;
    },
    enabled: productId !== "" && itemKind === "package",
  });
  const selectedPackage = (packagesQuery.data ?? []).find((p) => p.id === packageId);
  const publishedVersion = selectedPackage?.versions.find(
    (v) => v.status === "published",
  );
  const pricesQuery = useQuery({
    queryKey: ["admin", "package-versions", publishedVersion?.id, "prices"],
    queryFn: async () => {
      const res = await apiRequest<{ items: PackagePriceDto[] }>(
        `/api/v1/admin/package-versions/${publishedVersion!.id}/prices`,
      );
      return res.items;
    },
    enabled: Boolean(publishedVersion),
  });
  const featuresQuery = useQuery({
    queryKey: ["admin", "products", productId, "features"],
    queryFn: async () => {
      const res = await apiRequest<{ items: FeatureDto[] }>(
        `/api/v1/admin/products/${productId}/features`,
      );
      return res.items;
    },
    enabled: productId !== "" && itemKind === "custom",
  });
  const selectedPrice = (pricesQuery.data ?? []).find((p) => p.id === priceId);

  /* Step 3 — plan */
  const [planKind, setPlanKind] = useState<"full" | "advance_rest" | "equal_installments">(
    "full",
  );
  const [dueDate, setDueDate] = useState(todayDdmmyyyy());
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advancePercent, setAdvancePercent] = useState("");
  const [restDueDate, setRestDueDate] = useState("");
  const [installmentCount, setInstallmentCount] = useState("3");
  const [intervalDays, setIntervalDays] = useState("30");
  const [startDate, setStartDate] = useState(todayDdmmyyyy());
  const [planErrors, setPlanErrors] = useState<Record<string, string>>({});

  /* Step 4 — activation + method + first payment */
  const [activationMode, setActivationMode] = useState<
    "on_full_payment" | "on_percent" | "on_date"
  >("on_full_payment");
  const [activationPercent, setActivationPercent] = useState("50");
  const [activationDate, setActivationDate] = useState("");
  const [suspendOnMissed, setSuspendOnMissed] = useState(false);
  const [graceDays, setGraceDays] = useState("3");
  const [paymentMethodId, setPaymentMethodId] = useState("");
  const [firstPaymentAmount, setFirstPaymentAmount] = useState("");
  const [firstPaymentSender, setFirstPaymentSender] = useState("");
  const [firstPaymentPhone, setFirstPaymentPhone] = useState("");
  const [firstPaymentRef, setFirstPaymentRef] = useState("");
  const [firstPaymentDate, setFirstPaymentDate] = useState("");
  const [step4Errors, setStep4Errors] = useState<Record<string, string>>({});
  const methodsQuery = useAdminList<WizardPaymentMethodDto>(
    "payment-methods",
    "/api/v1/admin/payment-methods",
  );
  const enabledMethods = (methodsQuery.data ?? []).filter((m) => m.is_enabled);

  /* Derived totals (same formula the server uses: unit × qty − discount
   * + tax). The review shows the estimated total; the created order's
   * authoritative total comes from the server. */
  const unitAmount =
    itemKind === "package"
      ? (selectedPrice?.amount_minor ?? 0)
      : Number(customPrice) || 0;
  const qty = Number(quantity) || 0;
  const discountMinor = Number(discount) || 0;
  const taxMinor = Number(tax) || 0;
  const estimatedTotal = Math.max(0, unitAmount * qty - discountMinor + taxMinor);

  const planPreview: PlanPreviewRow[] = (() => {
    if (estimatedTotal <= 0) return [];
    if (planKind === "full") {
      return [{ n: 1, amount: estimatedTotal, due: dueDate }];
    }
    if (planKind === "advance_rest") {
      const advance = advanceAmount.trim()
        ? Number(advanceAmount)
        : Math.round((estimatedTotal * (Number(advancePercent) || 0)) / 100);
      if (!Number.isInteger(advance) || advance <= 0 || advance >= estimatedTotal) return [];
      return [
        { n: 1, amount: advance, due: todayDdmmyyyy() },
        { n: 2, amount: estimatedTotal - advance, due: restDueDate },
      ];
    }
    const count = Number(installmentCount) || 0;
    const interval = Number(intervalDays) || 0;
    const startIso = ddmmyyyyToIso(startDate);
    if (count < 2 || interval < 1 || !startIso) return [];
    const part = Math.floor(estimatedTotal / count);
    return Array.from({ length: count }, (_, i) => ({
      n: i + 1,
      amount: i === count - 1 ? estimatedTotal - part * (count - 1) : part,
      due: isoToDdmmyyyy(addDaysIso(startIso, i * interval)),
    }));
  })();

  // Live defect 2026-11-17: step-2 errors were set only by validateStep
  // (on Continue) and never cleared — a "Choose a price." error stayed
  // visible after the price was chosen. Each field clears its own
  // error as soon as its value changes.
  const clearItemError = (key: string) =>
    setItemErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const validateStep = (s: number): boolean => {
    if (s === 1) {
      if (customerMode === "existing") {
        if (!customerId) {
          setCustomerErrors({ customer: "Choose a customer, or switch to New customer." });
          return false;
        }
        setCustomerErrors({});
        return true;
      }
      const next = validateCustomerForm(newCustomer);
      setCustomerErrors(next);
      return Object.keys(next).length === 0;
    }
    if (s === 2) {
      const next: Record<string, string> = {};
      if (!productId) next.product = "Choose a product.";
      if (itemKind === "package") {
        if (!packageId) next.package = "Choose a package.";
        else if (!publishedVersion) next.package = "This package has no published version.";
        if (!priceId) next.price = "Choose a price.";
      } else {
        if (customLabel.trim().length < 2) next.customLabel = "Label must be at least 2 characters.";
        if (!Number.isInteger(Number(customPrice)) || Number(customPrice) < 0)
          next.customPrice = "Enter the price in minor units (0 or more).";
        if (customFeatures.filter((f) => f.featureId).length < 1)
          next.customFeatures = "Pick at least one feature for the custom offer.";
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > 100)
        next.quantity = "Quantity must be 1–100.";
      if (!Number.isInteger(discountMinor) || discountMinor < 0)
        next.discount = "Discount must be 0 or more (minor units).";
      if (!Number.isInteger(taxMinor) || taxMinor < 0)
        next.tax = "Tax must be 0 or more (minor units).";
      setItemErrors(next);
      return Object.keys(next).length === 0;
    }
    if (s === 3) {
      const next: Record<string, string> = {};
      if (planKind === "full") {
        if (!ddmmyyyyToIso(dueDate)) next.dueDate = "Due date must be DD/MM/YYYY.";
      } else if (planKind === "advance_rest") {
        const hasAmount = advanceAmount.trim() !== "";
        const hasPercent = advancePercent.trim() !== "";
        if (hasAmount === hasPercent)
          next.advance = "Enter an advance amount OR a percent, not both.";
        else if (hasAmount && (!Number.isInteger(Number(advanceAmount)) || Number(advanceAmount) <= 0))
          next.advance = "Advance amount must be a positive integer (minor units).";
        else if (hasPercent && (!Number.isInteger(Number(advancePercent)) || Number(advancePercent) < 1 || Number(advancePercent) > 99))
          next.advance = "Advance percent must be 1–99.";
        else if (hasAmount && Number(advanceAmount) >= estimatedTotal)
          next.advance = "Advance must be less than the order total.";
        if (!ddmmyyyyToIso(restDueDate)) next.restDueDate = "Rest due date must be DD/MM/YYYY.";
      } else {
        if (!Number.isInteger(Number(installmentCount)) || Number(installmentCount) < 2 || Number(installmentCount) > 24)
          next.installmentCount = "Installments must be 2–24.";
        if (!Number.isInteger(Number(intervalDays)) || Number(intervalDays) < 1 || Number(intervalDays) > 365)
          next.intervalDays = "Interval must be 1–365 days.";
        if (!ddmmyyyyToIso(startDate)) next.startDate = "Start date must be DD/MM/YYYY.";
      }
      setPlanErrors(next);
      return Object.keys(next).length === 0;
    }
    if (s === 4) {
      const next: Record<string, string> = {};
      if (activationMode === "on_percent") {
        if (!Number.isInteger(Number(activationPercent)) || Number(activationPercent) < 1 || Number(activationPercent) > 100)
          next.activationPercent = "Percent must be 1–100.";
      }
      if (activationMode === "on_date" && !ddmmyyyyToIso(activationDate))
        next.activationDate = "Activation date must be DD/MM/YYYY.";
      if (!Number.isInteger(Number(graceDays)) || Number(graceDays) < 0 || Number(graceDays) > 90)
        next.graceDays = "Grace days must be 0–90.";
      const firstAmount = firstPaymentAmount.trim() === "" ? 0 : Number(firstPaymentAmount);
      if (firstPaymentAmount.trim() !== "" && (!Number.isInteger(firstAmount) || firstAmount <= 0))
        next.firstPaymentAmount = "First payment must be a positive amount (minor units).";
      else if (firstAmount > 0 && !paymentMethodId)
        next.paymentMethod = "Choose a payment method for the first payment.";
      if (firstAmount > 0 && firstPaymentPhone.trim() !== "" && firstPaymentPhone.trim().length < 6)
        next.firstPaymentPhone = "Phone must be at least 6 characters.";
      if (firstAmount > 0 && firstPaymentDate.trim() !== "" && !/^\d{2}\/\d{2}\/\d{4}$/.test(firstPaymentDate.trim()))
        next.firstPaymentDate = "Use DD/MM/YYYY.";
      setStep4Errors(next);
      return Object.keys(next).length === 0;
    }
    return true;
  };

  const create = async () => {
    if (!validateStep(4)) {
      setStep(4);
      return;
    }
    setFormError(null);
    setCreating(true);
    try {
      const planBody: Record<string, unknown> =
        planKind === "full"
          ? { kind: "full", due_date: ddmmyyyyToIso(dueDate) }
          : planKind === "advance_rest"
            ? {
                kind: "advance_rest",
                ...(advanceAmount.trim()
                  ? { advance_amount_minor: Number(advanceAmount) }
                  : { advance_percent: Number(advancePercent) }),
                rest_due_date: ddmmyyyyToIso(restDueDate),
              }
            : {
                kind: "equal_installments",
                installment_count: Number(installmentCount),
                interval_days: Number(intervalDays),
                start_date: ddmmyyyyToIso(startDate),
              };
      const body: Record<string, unknown> = {
        ...(customerMode === "existing"
          ? { customer_id: customerId }
          : { new_customer: customerFormToCreateBody(newCustomer) }),
        product_id: productId,
        item_kind: itemKind,
        ...(itemKind === "package"
          ? {
              package_version_id: publishedVersion!.id,
              package_price_id: priceId,
            }
          : {
              custom_offer: {
                label: customLabel.trim(),
                price_kind: customPriceKind,
                unit_amount_minor: Number(customPrice),
                currency_code: "BDT",
                activation_limit: 1,
                features: customFeatures
                  .filter((f) => f.featureId)
                  .map((f) => {
                    // Entitlement values are STRUCTURED { value_type, value }
                    // (validateFeatureEntitlementValue, contracts catalog.ts):
                    // the wizard used to send the bare parseFeatureValue
                    // result, which the server rejected with a plain-Error
                    // 500 on every custom-offer create (live defect
                    // 2026-11-18). The feature's value_type comes from the
                    // loaded product features; quota/metered defaults
                    // (period month, overage block) are filled server-side.
                    const feat = (featuresQuery.data ?? []).find(
                      (x) => x.id === f.featureId,
                    );
                    return {
                      product_feature_id: f.featureId,
                      entitlement_value: feat
                        ? { value_type: feat.value_type, value: parseFeatureValue(f.value) }
                        : parseFeatureValue(f.value),
                    };
                  }),
              },
            }),
        quantity: qty,
        discount_minor: discountMinor,
        tax_minor: taxMinor,
        ...(notes.trim() ? { internal_note: notes.trim() } : {}),
        ...(paymentMethodId ? { payment_method_id: paymentMethodId } : {}),
        payment_plan: planBody,
        activation_mode: activationMode,
        ...(activationMode === "on_percent"
          ? { activation_percent: Number(activationPercent) }
          : {}),
        ...(activationMode === "on_date"
          ? { activation_date: ddmmyyyyToIso(activationDate) }
          : {}),
        suspend_on_missed_schedule: suspendOnMissed,
        grace_days: Number(graceDays),
        ...(prefill?.leadId ? { lead_id: prefill.leadId } : {}),
      };
      // POST /api/v1/admin/orders returns { order, invoice } — NOT a
      // bare order. The wizard used to type this as OrderDto and read
      // created.id (undefined), navigating to /orders/undefined after
      // a successful create (live defect 2026-11-17).
      const created = await apiRequest<{ order: OrderDto; invoice: InvoiceDto }>(
        "/api/v1/admin/orders",
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
      const createdOrder = created.order;
      // Optional first payment — a second request, recorded as a staff
      // claim (never auto-approved). The order exists even if the claim
      // fails; the error is shown and the order can be opened.
      const firstAmount =
        firstPaymentAmount.trim() === "" ? 0 : Number(firstPaymentAmount);
      if (firstAmount > 0) {
        try {
          await apiRequest(`/api/v1/admin/orders/${createdOrder.id}/payment-submissions`, {
            method: "POST",
            body: JSON.stringify({
              payment_method_id: paymentMethodId,
              amount_minor: firstAmount,
              currency_code: createdOrder.currency_code,
              ...(firstPaymentSender.trim()
                ? { sender_name: firstPaymentSender.trim() }
                : {}),
              ...(firstPaymentPhone.trim()
                ? { sender_phone: firstPaymentPhone.trim() }
                : {}),
              ...(firstPaymentRef.trim()
                ? { transaction_id: firstPaymentRef.trim() }
                : {}),
              ...(firstPaymentDate.trim()
                ? { payment_date_display: firstPaymentDate.trim() }
                : {}),
            }),
          });
        } catch (err) {
          setCreatedOrderId(createdOrder.id);
          setFormError(
            `Order ${createdOrder.order_number} was created, but the first payment claim failed: ${err instanceof Error ? err.message : "Request failed"}. Open the order to record it from Payment Review.`,
          );
          setCreating(false);
          return;
        }
      }
      void queryClient.invalidateQueries({ queryKey: listKey("orders") });
      onCreated(createdOrder.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the order.");
    } finally {
      setCreating(false);
    }
  };

  const stepTitles = [
    "Customer",
    "Item",
    "Payment plan",
    "Activation & payment",
    "Review",
  ];
  const selectedCustomer =
    customerMode === "existing"
      ? (customersQuery.data ?? []).find((c) => c.id === customerId) ?? null
      : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create order"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {step > 1 ? (
            <Button variant="secondary" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          ) : null}
          {step < 5 ? (
            <Button
              variant="accent"
              onClick={() => {
                if (validateStep(step)) setStep(step + 1);
              }}
            >
              Continue
            </Button>
          ) : (
            <Button variant="primary" loading={creating} onClick={() => void create()}>
              Create order
            </Button>
          )}
        </>
      }
    >
      <p className="sm-hint">
        Step {step} of 5 — {stepTitles[step - 1]}
      </p>
      {formError ? (
        <div style={{ marginTop: 12 }}>
          <Alert variant="danger">{formError}</Alert>
          {createdOrderId ? (
            <div style={{ marginTop: 12 }}>
              <Button
                variant="secondary"
                onClick={() => onCreated(createdOrderId)}
              >
                Open order
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div style={{ marginTop: 12 }}>
          <Field label="Customer">
            <Select
              value={customerMode}
              onChange={(e) => setCustomerMode(e.target.value as "existing" | "new")}
            >
              <option value="existing">Existing customer</option>
              <option value="new">New customer</option>
            </Select>
          </Field>
          {customerMode === "existing" ? (
            <>
              <Field label="Search customers">
                <Input
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Name, email or phone"
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Customer"
                required
                error={customerErrors.customer ?? ""}
              >
                <Select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  disabled={customersQuery.isPending}
                >
                  <option value="">Select a customer…</option>
                  {customerOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.email ? ` — ${c.email}` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              {prefill?.leadId ? (
                <p className="sm-hint">
                  Converting lead — the lead becomes converted when this order
                  is created.
                </p>
              ) : null}
            </>
          ) : (
            <CustomerFormFields
              values={newCustomer}
              onChange={(patch) => setNewCustomer((v) => ({ ...v, ...patch }))}
              errors={customerErrors}
              idPrefix="wizard-new-customer"
            />
          )}
        </div>
      ) : null}

      {step === 2 ? (
        <div style={{ marginTop: 12 }}>
          <Field label="Item type">
            <Select
              value={itemKind}
              onChange={(e) => {
                setItemKind(e.target.value as "package" | "custom");
                setPackageId("");
                setPriceId("");
              }}
            >
              <option value="package">Published package</option>
              <option value="custom">Custom offer</option>
            </Select>
          </Field>
          <Field label="Product" required error={itemErrors.product ?? ""}>
            <Select
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                setPackageId("");
                setPriceId("");
                setCustomFeatures([{ featureId: "", value: "" }]);
                clearItemError("product");
                clearItemError("package");
                clearItemError("price");
              }}
              disabled={productsQuery.isPending}
            >
              <option value="">Select a product…</option>
              {(productsQuery.data ?? [])
                .filter((p) => p.status === "active")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          {itemKind === "package" ? (
            <>
              <Field label="Package" required error={itemErrors.package ?? ""}>
                <Select
                  value={packageId}
                  onChange={(e) => {
                    setPackageId(e.target.value);
                    setPriceId("");
                    clearItemError("package");
                    clearItemError("price");
                  }}
                  disabled={!productId || packagesQuery.isPending}
                >
                  <option value="">Select a package…</option>
                  {(packagesQuery.data ?? [])
                    .filter((p) => p.status === "active")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </Select>
              </Field>
              {packageId && !publishedVersion ? (
                <Alert variant="warning">
                  This package has no published version — publish one before
                  ordering it.
                </Alert>
              ) : null}
              <Field label="Price" required error={itemErrors.price ?? ""}>
                {/* MenuSelect, not the native Select: the native popup
                    is OS-rendered and never opened on click in the
                    user's extension-driven browser (live defect
                    2026-11-17 — only type-ahead worked). The DOM
                    listbox opens on an ordinary click. */}
                <MenuSelect
                  value={priceId}
                  onChange={(v) => {
                    setPriceId(v);
                    clearItemError("price");
                  }}
                  options={(pricesQuery.data ?? [])
                    .filter((p) => p.status === "active")
                    .map((p) => ({
                      value: p.id,
                      label: `${formatMinorMoney(p.amount_minor, p.currency_code)}${
                        p.price_kind === "recurring" && p.interval_unit
                          ? ` / ${p.interval_count ?? 1} ${p.interval_unit}${(p.interval_count ?? 1) > 1 ? "s" : ""}`
                          : ` (${p.price_kind.replace(/_/g, " ")})`
                      }`,
                    }))}
                  placeholder={
                    pricesQuery.isPending ? "Loading prices…" : "Select a price…"
                  }
                  disabled={!publishedVersion || pricesQuery.isPending}
                  ariaLabel="Price"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Offer label" required error={itemErrors.customLabel ?? ""}>
                <Input
                  value={customLabel}
                  onChange={(e) => {
                    setCustomLabel(e.target.value);
                    clearItemError("customLabel");
                  }}
                  maxLength={160}
                  placeholder="e.g. Custom ERP setup"
                />
              </Field>
              <Field label="Price (minor units)" required error={itemErrors.customPrice ?? ""}>
                <Input
                  inputMode="numeric"
                  value={customPrice}
                  onChange={(e) => {
                    setCustomPrice(e.target.value);
                    clearItemError("customPrice");
                  }}
                  placeholder="500000"
                />
              </Field>
              <Field label="Billing kind">
                <Select
                  value={customPriceKind}
                  onChange={(e) =>
                    setCustomPriceKind(
                      e.target.value as "one_time" | "recurring" | "lifetime" | "free",
                    )
                  }
                >
                  <option value="one_time">One-time</option>
                  <option value="recurring">Recurring</option>
                  <option value="lifetime">Lifetime</option>
                  <option value="free">Free</option>
                </Select>
              </Field>
              <Field
                label="Features"
                hint="At least one feature from this product, with its entitlement value (true/false, a number, or text)."
                error={itemErrors.customFeatures ?? ""}
              >
                <div>
                  {customFeatures.map((f, i) => (
                    <div key={i} className="sm-form-grid" style={{ marginTop: i > 0 ? 8 : 0 }}>
                      <Select
                        value={f.featureId}
                        onChange={(e) =>
                          setCustomFeatures((rows) =>
                            rows.map((r, j) =>
                              j === i ? { ...r, featureId: e.target.value } : r,
                            ),
                          )
                        }
                        disabled={!productId || featuresQuery.isPending}
                        aria-label="Feature"
                      >
                        <option value="">Select a feature…</option>
                        {(featuresQuery.data ?? [])
                          .filter((feat) => feat.status === "active")
                          .map((feat) => (
                            <option key={feat.id} value={feat.id}>
                              {feat.name} ({feat.value_type})
                            </option>
                          ))}
                      </Select>
                      <Input
                        value={f.value}
                        onChange={(e) =>
                          setCustomFeatures((rows) =>
                            rows.map((r, j) =>
                              j === i ? { ...r, value: e.target.value } : r,
                            ),
                          )
                        }
                        placeholder="Value"
                        aria-label="Entitlement value"
                      />
                    </div>
                  ))}
                  <div style={{ marginTop: 8 }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setCustomFeatures((rows) => [...rows, { featureId: "", value: "" }])
                      }
                    >
                      Add feature
                    </Button>
                  </div>
                </div>
              </Field>
            </>
          )}
          <Field label="Quantity" required error={itemErrors.quantity ?? ""}>
            <Input
              inputMode="numeric"
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
                clearItemError("quantity");
              }}
            />
          </Field>
          <Field label="Discount (minor units)" error={itemErrors.discount ?? ""}>
            <Input
              inputMode="numeric"
              value={discount}
              onChange={(e) => {
                setDiscount(e.target.value);
                clearItemError("discount");
              }}
            />
          </Field>
          <Field label="Tax (minor units)" error={itemErrors.tax ?? ""}>
            <Input
              inputMode="numeric"
              value={tax}
              onChange={(e) => {
                setTax(e.target.value);
                clearItemError("tax");
              }}
            />
          </Field>
          <Field label="Internal notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
            />
          </Field>
        </div>
      ) : null}

      {step === 3 ? (
        <div style={{ marginTop: 12 }}>
          <p className="sm-hint">
            Estimated total {formatMinorMoney(estimatedTotal, "BDT")} — the plan
            below is built from it.
          </p>
          <Field label="Payment plan">
            <Select
              value={planKind}
              onChange={(e) =>
                setPlanKind(e.target.value as "full" | "advance_rest" | "equal_installments")
              }
            >
              <option value="full">One-time full payment</option>
              <option value="advance_rest">Advance + rest</option>
              <option value="equal_installments">Equal installments</option>
            </Select>
          </Field>
          {planKind === "full" ? (
            <Field label="Due date" required hint="DD/MM/YYYY." error={planErrors.dueDate ?? ""}>
              <Input
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                placeholder="15/11/2026"
                maxLength={10}
              />
            </Field>
          ) : null}
          {planKind === "advance_rest" ? (
            <>
              <Field
                label="Advance amount (minor units)"
                hint="Or a percent below — one of the two."
                error={planErrors.advance ?? ""}
              >
                <Input
                  inputMode="numeric"
                  value={advanceAmount}
                  onChange={(e) => setAdvanceAmount(e.target.value)}
                  placeholder="e.g. 50000"
                />
              </Field>
              <Field
                label="Advance percent"
                hint="1–99% of the total. Leave blank when an amount is given."
                error={planErrors.advance ?? ""}
              >
                <Input
                  inputMode="numeric"
                  value={advancePercent}
                  onChange={(e) => setAdvancePercent(e.target.value)}
                  placeholder="e.g. 50"
                />
              </Field>
              <Field
                label="Rest due date"
                required
                hint="DD/MM/YYYY."
                error={planErrors.restDueDate ?? ""}
              >
                <Input
                  value={restDueDate}
                  onChange={(e) => setRestDueDate(e.target.value)}
                  placeholder="15/12/2026"
                  maxLength={10}
                />
              </Field>
            </>
          ) : null}
          {planKind === "equal_installments" ? (
            <>
              <Field
                label="Number of installments"
                required
                error={planErrors.installmentCount ?? ""}
              >
                <Input
                  inputMode="numeric"
                  value={installmentCount}
                  onChange={(e) => setInstallmentCount(e.target.value)}
                />
              </Field>
              <Field
                label="Every X days"
                required
                error={planErrors.intervalDays ?? ""}
              >
                <Input
                  inputMode="numeric"
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(e.target.value)}
                />
              </Field>
              <Field
                label="Start date"
                required
                hint="DD/MM/YYYY — the first installment is due on this date."
                error={planErrors.startDate ?? ""}
              >
                <Input
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  placeholder="15/11/2026"
                  maxLength={10}
                />
              </Field>
            </>
          ) : null}
          {planPreview.length > 0 ? (
            <Card title="Installment preview">
              <div className="sm-table-wrap">
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Due</th>
                      <th scope="col">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planPreview.map((row) => (
                      <tr key={row.n}>
                        <td>{row.n}</td>
                        <td>{row.due}</td>
                        <td>{formatMinorMoney(row.amount, "BDT")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {step === 4 ? (
        <div style={{ marginTop: 12 }}>
          <Field label="License activation">
            <Select
              value={activationMode}
              onChange={(e) =>
                setActivationMode(
                  e.target.value as "on_full_payment" | "on_percent" | "on_date",
                )
              }
            >
              <option value="on_full_payment">On full payment</option>
              <option value="on_percent">On X% paid</option>
              <option value="on_date">On a fixed date</option>
            </Select>
          </Field>
          {activationMode === "on_percent" ? (
            <Field
              label="Activation percent"
              required
              hint="The license activates once this much of the total is paid."
              error={step4Errors.activationPercent ?? ""}
            >
              <Input
                inputMode="numeric"
                value={activationPercent}
                onChange={(e) => setActivationPercent(e.target.value)}
              />
            </Field>
          ) : null}
          {activationMode === "on_date" ? (
            <Field
              label="Activation date"
              required
              hint="DD/MM/YYYY — activates on this date regardless of payment."
              error={step4Errors.activationDate ?? ""}
            >
              <Input
                value={activationDate}
                onChange={(e) => setActivationDate(e.target.value)}
                placeholder="01/12/2026"
                maxLength={10}
              />
            </Field>
          ) : null}
          <Checkbox
            label="Suspend license when an installment passes its due date unpaid"
            checked={suspendOnMissed}
            onChange={(e) => setSuspendOnMissed(e.target.checked)}
          />
          {activationMode === "on_full_payment" ? (
            <p className="sm-hint">
              The suspend toggle has no effect before activation — the license
              does not exist yet until the order is fully paid.
            </p>
          ) : null}
          <Field
            label="Subscription grace days"
            hint="After a renewal is missed, the license keeps working for this many days before it is suspended."
            error={step4Errors.graceDays ?? ""}
          >
            <Input
              inputMode="numeric"
              value={graceDays}
              onChange={(e) => setGraceDays(e.target.value)}
            />
          </Field>
          <CollapsibleSection title="Payment method & first payment (optional)">
            <Field label="Payment method" error={step4Errors.paymentMethod ?? ""}>
              <Select
                value={paymentMethodId}
                onChange={(e) => setPaymentMethodId(e.target.value)}
                disabled={methodsQuery.isPending}
              >
                <option value="">No method yet</option>
                {enabledMethods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="First payment amount (minor units)"
              hint="Recorded as a claim after the order is created — it still needs approval in Payment Review."
              error={step4Errors.firstPaymentAmount ?? ""}
            >
              <Input
                inputMode="numeric"
                value={firstPaymentAmount}
                onChange={(e) => setFirstPaymentAmount(e.target.value)}
                placeholder="Leave blank for no first payment"
              />
            </Field>
            <Field label="Sender name">
              <Input
                value={firstPaymentSender}
                onChange={(e) => setFirstPaymentSender(e.target.value)}
              />
            </Field>
            <Field label="Sender phone" error={step4Errors.firstPaymentPhone ?? ""}>
              <Input
                value={firstPaymentPhone}
                onChange={(e) => setFirstPaymentPhone(e.target.value)}
                placeholder="01XXXXXXXXX"
              />
            </Field>
            <Field label="Transaction reference">
              <Input
                value={firstPaymentRef}
                onChange={(e) => setFirstPaymentRef(e.target.value)}
              />
            </Field>
            <Field label="Payment date" hint="DD/MM/YYYY, if known." error={step4Errors.firstPaymentDate ?? ""}>
              <Input
                value={firstPaymentDate}
                onChange={(e) => setFirstPaymentDate(e.target.value)}
                placeholder="15/11/2026"
                maxLength={10}
              />
            </Field>
          </CollapsibleSection>
        </div>
      ) : null}

      {step === 5 ? (
        <div style={{ marginTop: 12 }}>
          <DetailFacts
            facts={[
              {
                label: "Customer",
                value:
                  customerMode === "existing"
                    ? (selectedCustomer?.name ?? "—")
                    : `${newCustomer.name.trim()} (new)`,
              },
              {
                label: "Item",
                value:
                  itemKind === "package"
                    ? `${selectedPackage?.name ?? "—"} — ${selectedPrice ? formatMinorMoney(selectedPrice.amount_minor, selectedPrice.currency_code) : "—"}`
                    : `${customLabel.trim()} — ${formatMinorMoney(Number(customPrice) || 0, "BDT")}`,
              },
              { label: "Quantity", value: String(qty) },
              {
                label: "Estimated total",
                value: formatMinorMoney(estimatedTotal, "BDT"),
              },
              {
                label: "Payment plan",
                value:
                  planKind === "full"
                    ? `Full — due ${dueDate}`
                    : planKind === "advance_rest"
                      ? `Advance + rest — rest due ${restDueDate}`
                      : `${installmentCount} installments every ${intervalDays} days from ${startDate}`,
              },
              {
                label: "Activation",
                value:
                  activationMode === "on_percent"
                    ? `On ${activationPercent}% paid`
                    : activationMode === "on_date"
                      ? `On ${activationDate}`
                      : "On full payment",
              },
              {
                label: "First payment",
                value:
                  firstPaymentAmount.trim() !== ""
                    ? `${formatMinorMoney(Number(firstPaymentAmount), "BDT")} (as a claim — needs approval)`
                    : "None",
              },
            ]}
          />
          {planPreview.length > 0 ? (
            <Card title="Installments">
              <div className="sm-table-wrap">
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Due</th>
                      <th scope="col">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planPreview.map((row) => (
                      <tr key={row.n}>
                        <td>{row.n}</td>
                        <td>{row.due}</td>
                        <td>{formatMinorMoney(row.amount, "BDT")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
          <p className="sm-hint">
            The order starts awaiting payment. A first payment above is only a
            claim — Payment Review still has to verify it.
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
