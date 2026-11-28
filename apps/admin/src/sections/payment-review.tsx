/**
 * Payment Review — queue list + submission detail (design spec §4.1/§4.2).
 *
 * Routes (wired by the parent after delivery): /payment-review and
 * /payment-review/$submissionId. List search/page state is URL-backed
 * via useRouterState + useNavigate (see payment-methods.tsx header —
 * useSearch({ from }) only typechecks once the routes are registered).
 *
 * A submitted manual payment is NEVER shown as paid. Approval only
 * marks it verified after staff confirm actual receipt; approval then
 * marks the order paid and triggers fulfillment server-side.
 *
 * Endpoints used (all verified in apps/api/src/app.ts):
 *  - GET  /api/v1/admin/payment-submissions               payments.read
 *  - GET  /api/v1/admin/payment-submissions/:id           payments.read
 *  - GET  /api/v1/admin/payment-submissions/:id/history   payments.read
 *  - POST /api/v1/admin/payment-submissions/:id/approve   payments.approve
 *  - POST /api/v1/admin/payment-submissions/:id/reject    payments.reject
 *  - POST /api/v1/admin/orders/:id/payment-submissions    payments.approve (201, staff-recorded claim)
 *  - POST /api/v1/admin/orders/:id/payment-evidence       (JSON+base64; 503 fail-closed without a real bucket; PNG/JPEG/WEBP/PDF)
 *  - GET  /api/v1/admin/orders                            orders.read (order picker)
 *  - GET  /api/v1/admin/payment-methods                   payments.read (method picker)
 *  - GET  /api/v1/admin/refunds                           payments.read (Refunds tab)
 *  - POST /api/v1/admin/refunds                           payments.approve (manual refund record — no gateway)
 *
 * Evidence can be picked from the media library (PNG/JPEG/WEBP/PDF)
 * via the shared MediaPicker (PLAN §31) or uploaded directly — the
 * picked file's bytes are fetched back and sent through the unchanged
 * base64 evidence endpoint.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, ClipboardCheck, Plus } from "lucide-react";
import { ApiClientError, apiRequest, formatMinorMoney } from "../lib/api-client";
import { detailKey, listKey, queryClient } from "../lib/query";
import {
  DetailFacts,
  DetailLayout,
  ListTable,
  PageHeader,
  downloadCsv,
  loadListOptions,
  parseListSearch,
  useAdminDetail,
  useAdminList,
  useAdminMutation,
  useIdempotencyKey,
  type ListSearch,
} from "../lib/section-kit";
import { MediaPicker } from "../components/media-picker";
import { fetchMediaFile, type MediaAssetView } from "../lib/media";
import {
  Alert,
  Button,
  Card,
  Chip,
  CopyButton,
  DateCell,
  DateTimeCell,
  Dialog,
  Drawer,
  ErrorState,
  Field,
  Input,
  MoneyCell,
  SearchableSelect,
  Select,
  type SearchableOption,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  useToast,
} from "../components/primitives";
import { shortId } from "../lib/resolve-names";
import type { PaymentMethod } from "./payment-methods";
import { ddmmyyyyToIso, normalizeDateInput, normalizePastedDate } from "../lib/dates";

/* ------------------------------------------------------------------ */
/* Types (mirror apps/api/src/platform/db/store.ts + contracts)        */
/* ------------------------------------------------------------------ */
export interface PaymentVerificationLog {
  id: string;
  payment_submission_id: string;
  actor_user_id: string;
  decision: "approved" | "rejected" | "requested_information" | "reopened";
  reason_code: string | null;
  customer_message: string | null;
  notes: string | null;
  created_at: string;
}

export interface PaymentSubmission {
  id: string;
  order_id: string;
  customer_id: string;
  payment_method_id: string;
  amount_minor: number;
  currency_code: string;
  sender_name: string | null;
  sender_phone: string | null;
  sender_bank_name: string | null;
  sender_account_reference: string | null;
  transfer_rail_key: string | null;
  transaction_reference: string | null;
  normalized_transaction_reference: string | null;
  payment_date: string | null;
  proof_asset_id: string | null;
  duplicate_risk_Warning: boolean;
  status: "submitted" | "under_review" | "approved" | "rejected" | "cancelled";
  customer_note: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
  order_number?: string | null;
  order_total_minor?: number | null;
  // ADR-0009: the approve form needs the order's remaining amount and
  // the customer's credit balance to offer apply-credit explicitly.
  order_remaining_minor?: number | null;
  customer_credit_balance_minor?: number | null;
  customer_name?: string | null;
  payment_method_name?: string | null;
  /** E-15: Product + Gateway columns (PRD §11.6) — sent by the API
   *  once the list DTO carries them; "—" on older API builds. */
  product_name?: string | null;
  gateway_name?: string | null;
  submitted_date_display?: string | null;
  verification_logs?: PaymentVerificationLog[];
}

export interface OrderSummary {
  id: string;
  order_number: string;
  public_reference: string;
  customer_id: string;
  status: string;
  payment_status: string;
  currency_code: string;
  total_minor: number;
  // ADR-0009: computed from verified payments (API order list/detail).
  paid_amount_minor?: number;
  remaining_minor?: number;
  created_at: string;
}

/** Manual refund record (apps/api/src/platform/db/store.ts — PaymentRefundRecord). */
export interface PaymentRefund {
  id: string;
  payment_transaction_id: string;
  amount_minor: number;
  currency_code: string;
  status: "requested" | "pending" | "succeeded" | "failed" | "cancelled";
  reason: string;
  provider_refund_id: string | null;
  requested_by_user_id: string | null;
  processed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderInstallmentOption {
  id: string;
  installment_number: number;
  amount_minor: number;
  paid_amount_minor: number;
  due_date: string;
  status: string;
}

const STATUS_FILTERS = ["all", "submitted", "under_review", "approved", "rejected", "cancelled"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const REJECT_REASONS = [
  { code: "PAYMENT_NOT_RECEIVED", label: "Payment not received" },
  { code: "AMOUNT_MISMATCH", label: "Amount mismatch" },
  { code: "INVALID_REFERENCE", label: "Invalid transaction reference" },
  { code: "INSUFFICIENT_EVIDENCE", label: "Insufficient evidence" },
  { code: "DUPLICATE_PAYMENT", label: "Duplicate payment" },
  { code: "OTHER", label: "Other" },
] as const;

/* ------------------------------------------------------------------ */
/* URL-backed list search + SPA navigation (routes wired by parent)    */
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

function useGoDetail(base: string, param: string) {
  const navigate = useNavigate();
  return useCallback(
    (id: string) =>
      (navigate as unknown as (opts: { to: string; params: Record<string, string> }) => void)({
        to: `${base}/$${param}`,
        params: { [param]: id },
      }),
    [navigate, base, param],
  );
}



/* ------------------------------------------------------------------ */
/* Payment Review — queue list                                         */
/* ------------------------------------------------------------------ */
export function PaymentReviewSection() {
  const { parsed, setSearch } = useListSearch();
  const goDetail = useGoDetail("/payment-review", "submissionId");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [recordOpen, setRecordOpen] = useState(false);
  const [tab, setTab] = useState<"submissions" | "refunds">("submissions");
  const [refundOpen, setRefundOpen] = useState(false);

  // D-01: thread ?status= server-side, together with two separate
  // unfiltered count queries (pageSize 1 — only their `total` is
  // read) so the header's pending count stays the TRUE pending total
  // even when the chip filter is not "all". The client filter below
  // stays as the fallback until the API reads ?status=.
  const [sort, setSort] = useState<string | undefined>(undefined);
  const submissions = useAdminList<PaymentSubmission>(
    "payment-submissions",
    "/api/v1/admin/payment-submissions",
    {
      q: parsed.q,
      page: parsed.page,
      pageSize: parsed.pageSize,
      extra: {
        ...(statusFilter !== "all" ? { status: statusFilter } : {}),
        ...(sort ? { sort } : {}),
      },
    },
  );
  const pendingSubmitted = useAdminList<PaymentSubmission>(
    "payment-submissions",
    "/api/v1/admin/payment-submissions",
    { page: 1, pageSize: 1, extra: { status: "submitted" } },
  );
  const pendingUnderReview = useAdminList<PaymentSubmission>(
    "payment-submissions",
    "/api/v1/admin/payment-submissions",
    { page: 1, pageSize: 1, extra: { status: "under_review" } },
  );
  const pendingCount = pendingSubmitted.total + pendingUnderReview.total;
  // SPA M-22: default newest-first by submitted_at. When a server
  // sort is active the rows arrive already ordered — do not re-sort
  // them client-side (that would undo an ascending sort).
  const filtered = useMemo(() => {
    const rows = (submissions.data ?? []).filter((s) =>
      statusFilter === "all" ? true : s.status === statusFilter,
    );
    return sort
      ? rows
      : rows.slice().sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  }, [submissions.data, statusFilter, sort]);
  const { toast } = useToast();

  // D-15: memoized — goDetail is the only changing dep (useCallback).
  const columns: ColumnDef<PaymentSubmission, unknown>[] = useMemo(
    () => [
    {
      accessorKey: "id",
      header: "Submission",
      cell: ({ row }) => (
        <span className="sm-mono">
          {row.original.id.slice(0, 8)}… <CopyButton value={row.original.id} />
        </span>
      ),
    },
    {
      accessorKey: "order_number",
      header: "Order",
      cell: ({ row }) => row.original.order_number ?? "—",
    },
    {
      accessorKey: "customer_name",
      header: "Customer",
      cell: ({ row }) => row.original.customer_name ?? "—",
    },
    {
      // E-15: Product column (PRD §11.6).
      accessorKey: "product_name",
      header: "Product",
      enableSorting: false,
      cell: ({ row }) => row.original.product_name ?? "—",
    },
    {
      // E-15: Gateway column (PRD §11.6).
      accessorKey: "gateway_name",
      header: "Gateway",
      enableSorting: false,
      cell: ({ row }) => row.original.gateway_name ?? "—",
    },
    {
      accessorKey: "payment_method_name",
      header: "Method",
      cell: ({ row }) => row.original.payment_method_name ?? "—",
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
      cell: ({ row }) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <StatusBadge status={row.original.status} />
          {row.original.duplicate_risk_Warning ? (
            <span title="Duplicate transaction reference — another open submission uses this reference.">
              <AlertTriangle size={14} strokeWidth={2} aria-label="Duplicate risk" />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      accessorKey: "submitted_at",
      header: "Submitted",
      cell: ({ row }) => <DateTimeCell value={row.original.submitted_at} />,
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => (
        <Button variant="secondary" size="sm" onClick={() => goDetail(row.original.id)}>
          Review
        </Button>
      ),
    },
    ],
    [goDetail],
  );

  return (
    <section aria-labelledby="payment-review-heading">
      <PageHeader
        breadcrumb={[{ label: "Commerce" }, { label: "Payment Review" }]}
        title="Payment Review"
        help={
          pendingCount > 0
            ? `${pendingCount} submission${pendingCount === 1 ? "" : "s"} awaiting verification`
            : "No submissions awaiting verification"
        }
        action={
          tab === "submissions" ? (
            <Button variant="primary" icon={Plus} onClick={() => setRecordOpen(true)}>
              Record payment
            </Button>
          ) : (
            <Button variant="primary" icon={Plus} onClick={() => setRefundOpen(true)}>
              Record refund
            </Button>
          )
        }
      />
      <Tabs
        tabs={[
          { key: "submissions", label: "Submissions" },
          { key: "refunds", label: "Refunds" },
        ]}
        active={tab}
        onChange={(key) => setTab(key as "submissions" | "refunds")}
      />
      {tab === "submissions" ? (
      <ListTable<PaymentSubmission>
        columns={columns}
        data={filtered}
        serverSearch
        serverPagination
        serverSort={{ sortableColumns: ["submitted_at"], value: sort, onChange: setSort }}
        enableRowSelection
        bulkActions={[
          {
            label: "Export selected (CSV)",
            onSelect: (rows) => {
              downloadCsv(
                "payment-submissions.csv",
                ["Submission", "Order", "Customer", "Product", "Gateway", "Method", "Amount", "Status", "Submitted"],
                rows.map((r) => [
                  r.id,
                  r.order_number ?? "",
                  r.customer_name ?? "",
                  r.product_name ?? "",
                  r.gateway_name ?? "",
                  r.payment_method_name ?? "",
                  formatMinorMoney(r.amount_minor, r.currency_code),
                  r.status,
                  r.submitted_at,
                ]),
              );
              toast({ title: "Exported", message: `${rows.length} submission(s) downloaded as CSV.`, variant: "success" });
            },
          },
        ]}
        refreshSection="payment-submissions"
        filtersActive={statusFilter !== "all"}
        total={submissions.total}
        search={parsed.q ?? ""}
        onSearchChange={(q) => setSearch({ q: q || null, page: 1 })}
        page={parsed.page ?? 1}
        onPageChange={(page) => setSearch({ page })}
        pageSize={parsed.pageSize ?? 25}
        onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
        isLoading={submissions.isPending}
        isError={submissions.isError}
        error={submissions.error}
        onRetry={() => void submissions.refetch()}
        emptyIcon={ClipboardCheck}
        emptyTitle="No payment submissions yet"
        emptyBody="Manual payments customers submit — or staff record — appear here for verification."
        emptyActionLabel="Record payment"
        onEmptyAction={() => setRecordOpen(true)}
        toolbar={
          <>
            {STATUS_FILTERS.map((f) => (
              <Chip
                key={f}
                active={statusFilter === f}
                onClick={() => {
                  setStatusFilter(f);
                  setSearch({ page: 1 });
                }}
              >
                {f === "all" ? "All" : f.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}
              </Chip>
            ))}
          </>
        }
        getRowId={(row) => row.id}
      />
      ) : (
        <RefundsList />
      )}
      {recordOpen ? (
        <Dialog open size="md" onClose={() => setRecordOpen(false)} title="Record manual payment">
          <RecordPaymentForm onDone={() => setRecordOpen(false)} onCancel={() => setRecordOpen(false)} />
        </Dialog>
      ) : null}
      {refundOpen ? (
        <Dialog open size="md" onClose={() => setRefundOpen(false)} title="Record refund">
          <RecordRefundForm onDone={() => setRefundOpen(false)} onCancel={() => setRefundOpen(false)} />
        </Dialog>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Refunds — minimal list + record form (D-4: manual refunds only,    */
/* no gateway). The record draws from the order's latest refundable   */
/* transaction server-side; the amount ceiling is enforced there.      */
/* ------------------------------------------------------------------ */
function RefundsList() {
  const { parsed, setSearch } = useListSearch();
  const [selected, setSelected] = useState<PaymentRefund | null>(null);
  const refunds = useAdminList<PaymentRefund>("refunds", "/api/v1/admin/refunds", {
    q: parsed.q,
    page: parsed.page,
    pageSize: parsed.pageSize,
  });

  const columns: ColumnDef<PaymentRefund, unknown>[] = useMemo(
    () => [
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
  ],
    [],
  )

  return (
    <>
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
    </>
  );
}

function RecordRefundForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [orderId, setOrderId] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<OrderSummary | null>(null);
  const [amountMinor, setAmountMinor] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const [reason, setReason] = useState("");
  const [providerRefundId, setProviderRefundId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A-04: one key per form instance — a retried refund replays.
  const formKey = useIdempotencyKey();
  const mutation = useAdminMutation<{ refund: PaymentRefund }, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<{ refund: PaymentRefund }>("/api/v1/admin/refunds", {
        method: "POST",
        body: JSON.stringify(body),
        idempotencyKey: formKey,
      }),
    invalidateKeys: [listKey("refunds"), listKey("orders")],
    successTitle: "Refund recorded",
    successMessage: "The refund was recorded and the order balance adjusted.",
  });

  const amountNum = Number(amountMinor);
  const amountPreview =
    amountMinor.trim() !== "" && Number.isInteger(amountNum) && amountNum > 0
      ? formatMinorMoney(amountNum, currency.trim().toUpperCase() || "BDT")
      : null;
  const paidMinor = selectedOrder
    ? selectedOrder.total_minor - (selectedOrder.remaining_minor ?? 0)
    : null;

  const onOrderChange = (nextId: string, option?: { data?: unknown }) => {
    setOrderId(nextId);
    const order = (option?.data as OrderSummary | undefined) ?? null;
    setSelectedOrder(order);
    if (order) {
      // Default to the order's paid amount — the server enforces the
      // refundable ceiling (transaction amount minus refunds already
      // recorded) and 422s above it.
      setAmountMinor(String(order.total_minor - (order.remaining_minor ?? 0)));
      setCurrency(order.currency_code);
    }
  };

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!orderId) next.order_id = "Choose an order.";
    if (amountMinor.trim() === "" || !Number.isInteger(amountNum) || amountNum <= 0) {
      next.amount_minor = "Enter a positive whole amount in minor units.";
    }
    if (!/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) {
      next.currency_code = "Currency must be a 3-letter code.";
    }
    if (reason.trim() === "") next.reason = "A reason is required.";
    else if (reason.trim().length > 1000) next.reason = "Reason must be at most 1000 characters.";
    if (providerRefundId.trim().length > 180) {
      next.provider_refund_id = "At most 180 characters.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    setSubmitting(true);
    try {
      await mutation.mutateAsync({
        order_id: orderId,
        amount_minor: amountNum,
        currency_code: currency.trim().toUpperCase(),
        reason: reason.trim(),
        ...(providerRefundId.trim() ? { provider_refund_id: providerRefundId.trim() } : {}),
      });
      onDone();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not record the refund.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label="Record refund"
    >
      <Field label="Order" required htmlFor="refund-order" error={errors.order_id ?? ""}>
        {/* All orders, not open-only: a fully-paid order is exactly the
           refundable case (open_only would hide it). The server picks
           the order's latest refundable transaction and 422s when the
           order has none. */}
        <SearchableSelect
          id="refund-order"
          value={orderId}
          onChange={(v, option) => onOrderChange(v, option)}
          loadOptions={(q, signal) =>
            loadListOptions<OrderSummary>(
              "/api/v1/admin/orders",
              q,
              (o) => ({
                value: o.id,
                label: `${o.order_number} — ${formatMinorMoney(o.total_minor, o.currency_code)} (${o.payment_status})`,
                data: o,
              }),
              signal,
            )
          }
          placeholder="Type an order number or customer…"
          ariaLabel="Order"
        />
      </Field>
      <Field
        label="Amount (minor units)"
        required
        htmlFor="refund-amount"
        hint={
          amountPreview
            ? `= ${amountPreview}${paidMinor !== null ? ` · Paid ${formatMinorMoney(paidMinor, currency.trim().toUpperCase() || "BDT")}` : ""}`
            : "Minor units, e.g. 50000 = ৳500.00."
        }
        error={errors.amount_minor ?? ""}
      >
        <Input
          id="refund-amount"
          name="amount_minor"
          inputMode="numeric"
          value={amountMinor}
          onChange={(e) => setAmountMinor(e.target.value)}
          aria-invalid={Boolean(errors.amount_minor) || undefined}
        />
      </Field>
      <Field label="Currency" required htmlFor="refund-currency" error={errors.currency_code ?? ""}>
        <Input
          id="refund-currency"
          name="currency_code"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          aria-invalid={Boolean(errors.currency_code) || undefined}
        />
      </Field>
      <Field label="Reason" required htmlFor="refund-reason" error={errors.reason ?? ""}>
        <Textarea
          id="refund-reason"
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
        />
      </Field>
      <Field
        label="Provider refund ID"
        htmlFor="refund-provider-ref"
        hint="Reference from the bank / MFS provider, if any."
        error={errors.provider_refund_id ?? ""}
      >
        <Input
          id="refund-provider-ref"
          name="provider_refund_id"
          value={providerRefundId}
          onChange={(e) => setProviderRefundId(e.target.value)}
          maxLength={180}
        />
      </Field>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer sm-dialog-footer-flush">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="accent" loading={submitting || mutation.isPending} onClick={() => void submit()}>
          Record refund
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Record manual payment (staff-recorded claim — NEVER marks paid)     */
/* ------------------------------------------------------------------ */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? (result.split(",")[1] ?? "") : result);
    };
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function RecordPaymentForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const goDetail = useGoDetail("/payment-review", "submissionId");

  const [orderId, setOrderId] = useState("");
  const [methodId, setMethodId] = useState("");
  const [amountMinor, setAmountMinor] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const [senderName, setSenderName] = useState("");
  const [senderPhone, setSenderPhone] = useState("");
  const [senderBank, setSenderBank] = useState("");
  const [senderRef, setSenderRef] = useState("");
  const [transferRail, setTransferRail] = useState<"npsb" | "beftn" | "rtgs" | "">("");
  const [transactionId, setTransactionId] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The picked records come from the SearchableSelect option's data
  // payload (PLAN §29) — the form no longer loads the full order /
  // method lists. `selectedOrder`/`selectedMethod` drive the amount
  // default, the currency check and the transfer-rail rules.
  const [selectedOrder, setSelectedOrder] = useState<OrderSummary | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod | null>(null);
  const amountNum = Number(amountMinor);
  const amountPreview =
    amountMinor.trim() !== "" && Number.isInteger(amountNum) && amountNum > 0
      ? formatMinorMoney(amountNum, currency.trim().toUpperCase() || "BDT")
      : null;

  const onOrderChange = (nextId: string, option?: { data?: unknown }) => {
    setOrderId(nextId);
    setInstallmentId("");
    const order = (option?.data as OrderSummary | undefined) ?? null;
    setSelectedOrder(order);
    if (order) {
      // Default to the remaining amount (ADR-0009: partial payments
      // are allowed; the claim no longer has to match the full total).
      setAmountMinor(String(order.remaining_minor ?? order.total_minor));
      setCurrency(order.currency_code);
    }
  };

  const onMethodChange = (nextId: string, option?: { data?: unknown }) => {
    setMethodId(nextId);
    setSelectedMethod((option?.data as PaymentMethod | undefined) ?? null);
    setTransferRail("");
  };

  // Installments for the picked order (ADR-0009): the claim may name
  // one; otherwise the server allocates oldest-first.
  const installmentsQuery = useQuery({
    queryKey: ["admin", "orders", "installments", orderId],
    queryFn: async () => {
      const res = await apiRequest<{ items: OrderInstallmentOption[] }>(
        `/api/v1/admin/orders/${orderId}/installments`,
      );
      return res.items;
    },
    enabled: orderId !== "",
  });
  const [installmentId, setInstallmentId] = useState("");

  // A-04: one key per form instance — a retried claim replays.
  const formKey = useIdempotencyKey();
  const mutation = useAdminMutation<
    { payment_submission: PaymentSubmission; order: OrderSummary },
    Record<string, unknown>
  >({
    mutationFn: (body) =>
      apiRequest<{ payment_submission: PaymentSubmission; order: OrderSummary }>(
        `/api/v1/admin/orders/${orderId}/payment-submissions`,
        { method: "POST", body: JSON.stringify(body), idempotencyKey: formKey },
      ),
    invalidateKeys: [listKey("payment-submissions"), listKey("orders")],
    successTitle: "Payment recorded for review",
    successMessage: "The order stays pending verification until staff approve it.",
    onSuccess: (data) => {
      onDone();
      goDetail(data.payment_submission.id);
    },
  });

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!selectedOrder) next.order_id = "Choose an unpaid order.";
    if (!selectedMethod) next.payment_method_id = "Choose an enabled payment method.";
    if (!Number.isInteger(amountNum) || amountNum <= 0)
      next.amount_minor = "Enter the amount in minor units (e.g. 50000 = ৳500.00).";
    // ADR-0009: partial payments are allowed — any positive amount.
    // Above the remaining amount is NOT an error: the excess becomes
    // the customer's credit balance at approval (the form says so
    // under the amount field); the server 422s only on <= 0 or a
    // currency mismatch.
    if (!/^[A-Za-z]{3}$/.test(currency.trim()))
      next.currency_code = "Currency must be a 3-letter code.";
    else if (selectedOrder && currency.trim().toUpperCase() !== selectedOrder.currency_code)
      next.currency_code = `Currency must match the order (${selectedOrder.currency_code}).`;
    if (selectedMethod) {
      const req = selectedMethod.configuration.transaction_id_requirement;
      if (req === "required" && !transactionId.trim())
        next.transaction_id = "Transaction ID is required for this method.";
      if (req === "disabled" && transactionId.trim())
        next.transaction_id = "Transaction ID is disabled for this method.";
      if (selectedMethod.method_kind === "bank_account") {
        if (!transferRail) next.transfer_rail = "Choose a transfer rail for bank payments.";
        else if (!selectedMethod.transfer_rails.includes(transferRail))
          next.transfer_rail = "This rail is not supported by the selected method.";
      }
    }
    if (senderPhone.trim() && senderPhone.trim().length < 6)
      next.sender_phone = "Phone needs at least 6 characters.";
    if (senderPhone.trim().length > 40)
      next.sender_phone = "Phone must be at most 40 characters.";
    if (senderName.trim().length > 160)
      next.sender_name = "Sender name must be at most 160 characters.";
    if (senderBank.trim().length > 160)
      next.sender_bank_name = "Sender bank name must be at most 160 characters.";
    if (senderRef.trim().length > 160)
      next.sender_account_reference = "Sender account reference must be at most 160 characters.";
    if (transactionId.trim().length > 160)
      next.transaction_id = "Transaction ID must be at most 160 characters.";
    if (customerNote.trim().length > 1000)
      next.customer_note = "Customer note must be at most 1000 characters.";
    // D-06: strict validation — the regex alone accepted 99/99/2026.
    if (paymentDate.trim() && ddmmyyyyToIso(paymentDate.trim()) === null)
      next.payment_date_display = "Use a valid DD/MM/YYYY date.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setFormError(null);
    setSubmitting(true);
    try {
      let evidenceAssetId: string | undefined;
      if (evidenceFile) {
        const fileBase64 = await readFileAsBase64(evidenceFile);
        const asset = await apiRequest<{ id: string }>(
          `/api/v1/admin/orders/${orderId}/payment-evidence`,
          {
            method: "POST",
            // A-04: the form's key — a retried evidence upload replays
            // instead of storing the same file twice.
            idempotencyKey: formKey,
            body: JSON.stringify({
              filename: evidenceFile.name,
              content_type: evidenceFile.type || "application/octet-stream",
              file_base64: fileBase64,
            }),
          },
        );
        evidenceAssetId = asset.id;
      }
      mutation.mutate(
        {
          payment_method_id: methodId,
          amount_minor: amountNum,
          currency_code: currency.trim().toUpperCase(),
          ...(installmentId ? { installment_id: installmentId } : {}),
          ...(senderPhone.trim() ? { sender_phone: senderPhone.trim() } : {}),
          ...(senderName.trim() ? { sender_name: senderName.trim() } : {}),
          ...(senderBank.trim() ? { sender_bank_name: senderBank.trim() } : {}),
          ...(senderRef.trim() ? { sender_account_reference: senderRef.trim() } : {}),
          ...(transferRail ? { transfer_rail: transferRail } : {}),
          ...(transactionId.trim() ? { transaction_id: transactionId.trim() } : {}),
          ...(paymentDate.trim() ? { payment_date_display: paymentDate.trim() } : {}),
          ...(evidenceAssetId ? { evidence_asset_id: evidenceAssetId } : {}),
          ...(customerNote.trim() ? { customer_note: customerNote.trim() } : {}),
        },
        {
          onError: (err) => {
            setFormError(err instanceof Error ? err.message : "Request failed");
            setSubmitting(false);
          },
        },
      );
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : "Evidence upload failed. The payment was not recorded.",
      );
      setSubmitting(false);
    }
  };

  // Library pick (PLAN §31): fetch the picked file's bytes back
  // through its authenticated content URL, then run the unchanged
  // evidence upload — the evidence keeps its own storage key
  // (payment-evidence/<order>/<uuid>), it is NOT the library row.
  async function handleLibraryPick(asset: MediaAssetView) {
    try {
      const file = await fetchMediaFile(asset);
      setEvidenceFile(file);
    } catch (err) {
      setFormError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not use the selected file."
      );
    }
  }

  return (
    <>
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Alert variant="warning">
        This records a payment claim for review. It does not mark the order
        paid — the order stays pending verification until staff approve it.
      </Alert>
      <div className="sm-form-grid" style={{ marginTop: 16 }}>
        <Field label="Order" required htmlFor="claim-order" hint="Unpaid orders only." error={errors.order_id ?? ""}>
          {/* Searchable (PLAN §29): the query runs server-side over
             the full order set (by number, reference or customer
             name). Unpaid-only is a server param now (audit H-04) —
             the typed query narrows among unpaid orders, so an open
             order beyond the first 100 loaded matches is still found. */}
          <SearchableSelect
            id="claim-order"
            value={orderId}
            onChange={(v, option) => onOrderChange(v, option)}
            loadOptions={(q, signal) =>
              loadListOptions<OrderSummary>(
                "/api/v1/admin/orders",
                q,
                (o) => ({
                  value: o.id,
                  label: `${o.order_number} — ${formatMinorMoney(o.total_minor, o.currency_code)} (${o.payment_status})`,
                  data: o,
                }),
                signal,
                { extra: { open_only: "true" }, limit: 100 },
              )
            }
            placeholder="Type an order number or customer…"
            ariaLabel="Order"
          />
        </Field>
        <Field label="Payment method" required htmlFor="claim-method" error={errors.payment_method_id ?? ""}>
          {/* Searchable (PLAN §29): only enabled methods are offered —
             is_enabled is a server param now (audit H-03), not a
             client-side filter over the first 25 matches. */}
          <SearchableSelect
            id="claim-method"
            value={methodId}
            onChange={(v, option) => onMethodChange(v, option)}
            loadOptions={(q, signal) =>
              loadListOptions<PaymentMethod>(
                "/api/v1/admin/payment-methods",
                q,
                (m) => ({ value: m.id, label: m.display_name, data: m }),
                signal,
                { extra: { is_enabled: "true" } },
              )
            }
            placeholder="Type a method name…"
            ariaLabel="Payment method"
          />
        </Field>
        <Field
          label="Amount (minor units)"
          required
          htmlFor="claim-amount"
          hint={
            amountPreview
              ? `= ${amountPreview}${selectedOrder ? ` · Remaining ${formatMinorMoney(selectedOrder.remaining_minor ?? selectedOrder.total_minor, selectedOrder.currency_code)}` : ""}${selectedOrder && amountNum > (selectedOrder.remaining_minor ?? selectedOrder.total_minor) ? ` · Exceeds the remaining amount by ${formatMinorMoney(amountNum - (selectedOrder.remaining_minor ?? selectedOrder.total_minor), selectedOrder.currency_code)} — the excess becomes the customer's credit balance at approval.` : ""}`
              : "Minor units, e.g. 50000 = ৳500.00."
          }
          error={errors.amount_minor ?? ""}
        >
          <Input
            id="claim-amount"
            name="amount_minor"
            inputMode="numeric"
            value={amountMinor}
            onChange={(e) => setAmountMinor(e.target.value)}
            aria-invalid={Boolean(errors.amount_minor) || undefined}
          />
        </Field>
        {orderId !== "" ? (
          <Field label="Apply to installment" htmlFor="claim-installment" hint="Optional — oldest unpaid first when left blank.">
            {/* Local mode: installments are this order's complete set. */}
            <SearchableSelect
              id="claim-installment"
              value={installmentId}
              onChange={(v) => setInstallmentId(v)}
              options={(installmentsQuery.data ?? [])
                .filter((i) => i.status !== "paid")
                .map((i) => ({
                  value: i.id,
                  label: `#${i.installment_number} — ${formatMinorMoney(i.amount_minor - i.paid_amount_minor, currency.trim().toUpperCase() || "BDT")} due ${i.due_date} (${i.status.replace(/_/g, " ")})`,
                }))}
              leadingOptions={[{ value: "", label: "Oldest unpaid first" }]}
              placeholder="Oldest unpaid first"
              disabled={installmentsQuery.isPending}
              ariaLabel="Apply to installment"
            />
          </Field>
        ) : null}
        <Field label="Currency" required htmlFor="claim-currency" error={errors.currency_code ?? ""}>
          <Input
            id="claim-currency"
            name="currency_code"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            aria-invalid={Boolean(errors.currency_code) || undefined}
          />
        </Field>
        <Field label="Sender name" htmlFor="claim-sender-name" error={errors.sender_name ?? ""}>
          <Input id="claim-sender-name" name="sender_name" autoComplete="name" value={senderName} onChange={(e) => setSenderName(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Sender phone" htmlFor="claim-sender-phone" error={errors.sender_phone ?? ""}>
          <Input id="claim-sender-phone" name="sender_phone" autoComplete="tel" value={senderPhone} onChange={(e) => setSenderPhone(e.target.value)} placeholder="01XXXXXXXXX" maxLength={40} />
        </Field>
        <Field label="Sender bank name" htmlFor="claim-sender-bank" error={errors.sender_bank_name ?? ""}>
          <Input id="claim-sender-bank" name="sender_bank_name" value={senderBank} onChange={(e) => setSenderBank(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Sender account reference" htmlFor="claim-sender-ref" error={errors.sender_account_reference ?? ""}>
          <Input id="claim-sender-ref" name="sender_account_reference" value={senderRef} onChange={(e) => setSenderRef(e.target.value)} maxLength={160} />
        </Field>
        {selectedMethod?.method_kind === "bank_account" ? (
          <Field label="Transfer rail" required htmlFor="claim-transfer-rail" error={errors.transfer_rail ?? ""}>
            <Select
              id="claim-transfer-rail"
              name="transfer_rail"
              value={transferRail}
              onChange={(e) => setTransferRail(e.target.value as "npsb" | "beftn" | "rtgs")}
              aria-invalid={Boolean(errors.transfer_rail) || undefined}
            >
              <option value="">Select a rail…</option>
              {selectedMethod.transfer_rails.map((rail) => (
                <option key={rail} value={rail}>
                  {rail.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field
          label="Transaction ID"
          required={selectedMethod?.configuration.transaction_id_requirement === "required"}
          htmlFor="claim-transaction-id"
          error={errors.transaction_id ?? ""}
        >
          <Input id="claim-transaction-id" name="transaction_id" value={transactionId} onChange={(e) => setTransactionId(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Payment date" htmlFor="claim-payment-date" hint="DD/MM/YYYY, if known." error={errors.payment_date_display ?? ""}>
          <Input
            id="claim-payment-date"
            name="payment_date_display"
            value={paymentDate}
            onChange={(e) => setPaymentDate(normalizeDateInput(e.target.value))}
            onPaste={(e) => {
              e.preventDefault();
              setPaymentDate(normalizePastedDate(e.clipboardData.getData("text")));
            }}
            placeholder="15/11/2026"
            maxLength={10}
          />
        </Field>
        <Field label="Evidence file" htmlFor="claim-evidence" hint="Screenshot or receipt. Uploaded to private storage.">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Input
              id="claim-evidence"
              name="evidence_file"
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => setEvidenceFile(e.target.files?.[0] ?? null)}
            />
            <div>
              <Button type="button" variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                Choose from library
              </Button>
            </div>
          </div>
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Customer note" htmlFor="claim-customer-note" error={errors.customer_note ?? ""}>
          <Textarea id="claim-customer-note" name="customer_note" value={customerNote} onChange={(e) => setCustomerNote(e.target.value)} maxLength={1000} />
        </Field>
      </div>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer sm-dialog-footer-flush">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="accent"
          loading={submitting || mutation.isPending}
          onClick={() => void submit()}
        >
          Record for review
        </Button>
      </div>
    </form>
    <MediaPicker
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      onSelect={(asset) => void handleLibraryPick(asset)}
      kinds={["image", "document"]}
      mimes={["image/png", "image/jpeg", "image/webp", "application/pdf"]}
      title="Choose evidence from media library"
    />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Payment Submission — detail (facts + approve/reject + history)      */
/* ------------------------------------------------------------------ */
export function PaymentSubmissionDetailSection({ id }: { id: string }) {
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const detail = useAdminDetail<PaymentSubmission>(
    "payment-submissions",
    id,
    `/api/v1/admin/payment-submissions/${id}`,
  );
  const history = useQuery({
    queryKey: ["admin", "payment-submissions", "history", id],
    queryFn: async () => {
      const res = await apiRequest<{ items: PaymentVerificationLog[] }>(
        `/api/v1/admin/payment-submissions/${id}/history`,
      );
      return res.items;
    },
    enabled: detail.isSuccess,
  });

  if (detail.isPending) {
    return (
      <section aria-labelledby="submission-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Commerce" }, { label: "Payment Review", href: "/payment-review" }, { label: "…" }]}
          title="Payment submission"
        />
        <div className="sm-table-wrap sm-table-wrap-pad">
          <Skeleton height={20} width="40%" />
          <div style={{ marginTop: 12 }}>
            <Skeleton height={16} />
          </div>
          <div style={{ marginTop: 12 }}>
            <Skeleton height={16} />
          </div>
        </div>
      </section>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <section aria-labelledby="submission-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Commerce" }, { label: "Payment Review", href: "/payment-review" }, { label: "Not found" }]}
          title="Payment submission"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={detail.error instanceof Error ? detail.error.message : "Payment submission not found."}
            onRetry={() => void detail.refetch()}
          />
        </div>
      </section>
    );
  }

  const sub = detail.data;
  const isReviewable = sub.status === "submitted" || sub.status === "under_review";
  const logs = history.data ?? sub.verification_logs ?? [];

  return (
    <section aria-labelledby="submission-detail-heading">
      <PageHeader
        breadcrumb={[
          { label: "Commerce" },
          { label: "Payment Review", href: "/payment-review" },
          { label: sub.order_number ?? sub.id.slice(0, 8) },
        ]}
        title={`Payment for ${sub.order_number ?? "order"}`}
        help="Verify actual receipt before approving — approval marks the order paid"
        action={
          isReviewable ? (
            <span style={{ display: "inline-flex", gap: 8 }}>
              <Button variant="danger-ghost" onClick={() => setRejectOpen(true)}>
                Reject
              </Button>
              <Button variant="accent" onClick={() => setApproveOpen(true)}>
                Approve
              </Button>
            </span>
          ) : undefined
        }
      />
      <DetailLayout
        title="Submission"
        facts={[
          { label: "Amount", value: <MoneyCell currency={sub.currency_code} minor={sub.amount_minor} /> },
          {
            label: "Order total",
            value:
              sub.order_total_minor != null ? (
                <MoneyCell currency={sub.currency_code} minor={sub.order_total_minor} />
              ) : (
                "—"
              ),
          },
          { label: "Method", value: sub.payment_method_name ?? "—" },
          { label: "Customer", value: sub.customer_name ?? "—" },
          { label: "Submitted", value: <DateTimeCell value={sub.submitted_at} /> },
          { label: "Reviewed", value: <DateTimeCell value={sub.reviewed_at} /> },
        ]}
      >
        <div style={{ marginBottom: 16 }}>
          <StatusBadge status={sub.status} />
        </div>
        {sub.duplicate_risk_Warning ? (
          <div style={{ marginBottom: 16 }}>
            <Alert variant="warning">
              Duplicate transaction reference — another open submission uses this
              reference. Check it before approving.
            </Alert>
          </div>
        ) : null}
        {!isReviewable ? (
          <div style={{ marginBottom: 16 }}>
            <Alert variant="info">
              This submission has already been reviewed ({sub.status}). No further
              action is available.
            </Alert>
          </div>
        ) : null}
        <Card title="Sender & payment details">
          <DetailFacts
            facts={[
              { label: "Sender name", value: sub.sender_name ?? "—" },
              { label: "Sender phone", value: sub.sender_phone ?? "—" },
              { label: "Sender bank", value: sub.sender_bank_name ?? "—" },
              { label: "Sender account ref.", value: sub.sender_account_reference ?? "—" },
              { label: "Transfer rail", value: sub.transfer_rail_key ? sub.transfer_rail_key.toUpperCase() : "—" },
              { label: "Transaction ref.", value: sub.transaction_reference ?? "—" },
              { label: "Payment date", value: <DateCell value={sub.payment_date} /> },
              {
                label: "Evidence",
                value: sub.proof_asset_id ? (
                  <span className="sm-mono">
                    {sub.proof_asset_id.slice(0, 8)}… <CopyButton value={sub.proof_asset_id} />{" "}
                    <a href={`/api/v1/admin/assets/${sub.proof_asset_id}/content`} target="_blank" rel="noreferrer">
                      View evidence
                    </a>
                  </span>
                ) : (
                  "—"
                ),
              },
            ]}
          />
          {sub.customer_note ? <p className="sm-hint">{sub.customer_note}</p> : null}
        </Card>
        <div style={{ marginTop: 24 }}>
          <Card title="Verification history">
            {history.isPending && !sub.verification_logs ? (
              <Skeleton height={20} />
            ) : logs.length === 0 ? (
              <p className="sm-hint">No verification entries yet.</p>
            ) : (
              <div className="sm-table-wrap">
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Decision</th>
                      <th>Reason code</th>
                      <th>Customer message</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id}>
                        <td>
                          <DateTimeCell value={log.created_at} />
                        </td>
                        <td>
                          <StatusBadge status={log.decision} />
                        </td>
                        <td>
                          {log.reason_code ? <span className="sm-mono">{log.reason_code}</span> : "—"}
                        </td>
                        <td>{log.customer_message ?? "—"}</td>
                        <td>{log.notes ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
        {approveOpen ? (
          <Dialog open size="md" onClose={() => setApproveOpen(false)} title="Approve payment">
            <ApproveForm submission={sub} onDone={() => setApproveOpen(false)} onCancel={() => setApproveOpen(false)} />
          </Dialog>
        ) : null}
        {rejectOpen ? (
          <Dialog open size="md" onClose={() => setRejectOpen(false)} title="Reject payment">
            <RejectForm submission={sub} onDone={() => setRejectOpen(false)} onCancel={() => setRejectOpen(false)} />
          </Dialog>
        ) : null}
      </DetailLayout>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Approve form — confirms actual receipt; marks order paid            */
/* ------------------------------------------------------------------ */
function ApproveForm({
  submission,
  onDone,
  onCancel,
}: {
  submission: PaymentSubmission;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [verifiedAmount, setVerifiedAmount] = useState(String(submission.amount_minor));
  const [currency, setCurrency] = useState(submission.currency_code);
  const [reference, setReference] = useState("");
  const [internalNote, setInternalNote] = useState("");
  // ADR-0009 apply-credit: explicit, never silent. Capped at the
  // smaller of the customer's credit balance and the order's
  // remaining amount (the server enforces the same caps).
  const [applyCredit, setApplyCredit] = useState("0");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const creditBalance = submission.customer_credit_balance_minor ?? 0;
  const orderRemaining = submission.order_remaining_minor ?? submission.amount_minor;
  const maxCredit = Math.max(0, Math.min(creditBalance, orderRemaining));

  // A-04: one key per form instance — a retried approval replays.
  const formKey = useIdempotencyKey();
  const mutation = useAdminMutation<unknown, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<unknown>(`/api/v1/admin/payment-submissions/${submission.id}/approve`, {
        method: "POST",
        body: JSON.stringify(body),
        idempotencyKey: formKey,
      }),
    invalidateKeys: [
      detailKey("payment-submissions", submission.id),
      listKey("payment-submissions"),
      listKey("orders"),
      // Q5: the detail page also reads the verification history
      // (["admin", "payment-submissions", "history", id]) — without
      // this the "Verification history" section kept showing the
      // stale (pre-approval) logs after approve/reject.
      ["admin", "payment-submissions", "history", submission.id],
    ],
    successTitle: "Payment approved",
    // ADR-0009: approval may leave the order partially paid — the
    // message must not claim "paid" when the order is not.
    successMessage: "The verified amount was applied to the order.",
    onSuccess: onDone,
  });

  const submit = () => {
    const next: Record<string, string> = {};
    const amount = Number(verifiedAmount);
    const credit = Number(applyCredit);
    if (!Number.isInteger(amount) || amount <= 0)
      next.verified_amount_minor = "Enter the verified amount in minor units.";
    if (!Number.isInteger(credit) || credit < 0)
      next.apply_credit_minor = "Enter 0 or a positive amount in minor units.";
    else if (credit > maxCredit)
      next.apply_credit_minor = `At most ${formatMinorMoney(maxCredit, submission.currency_code)} can be applied (credit ${formatMinorMoney(creditBalance, submission.currency_code)}, remaining ${formatMinorMoney(orderRemaining, submission.currency_code)}).`;
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) next.currency_code = "Currency must be a 3-letter code.";
    if (reference.trim().length < 2) next.verification_reference = "Verification reference is required.";
    else if (reference.trim().length > 160)
      next.verification_reference = "Verification reference must be at most 160 characters.";
    if (internalNote.trim().length > 2000)
      next.internal_note = "Internal note must be at most 2000 characters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    mutation.mutate(
      {
        verified_amount_minor: amount,
        currency_code: currency.trim().toUpperCase(),
        verification_reference: reference.trim(),
        ...(credit > 0 ? { apply_credit_minor: credit } : {}),
        ...(internalNote.trim() ? { internal_note: internalNote.trim() } : {}),
      },
      {
        onError: (err) => setFormError(err instanceof Error ? err.message : "Request failed"),
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Alert variant="warning">
        Approve only after confirming actual receipt. Approval applies the
        verified amount to the order — a partial approval leaves the order
        partially paid; fulfillment (subscriptions and licenses) follows
        the order's activation policy.
      </Alert>
      <div className="sm-form-grid" style={{ marginTop: 16 }}>
        <Field
          label="Verified amount (minor units)"
          required
          htmlFor="approve-verified-amount"
          hint={`Claimed ${formatMinorMoney(submission.amount_minor, submission.currency_code)} · Remaining ${formatMinorMoney(orderRemaining, submission.currency_code)}`}
          error={errors.verified_amount_minor ?? ""}
        >
          <Input
            id="approve-verified-amount"
            name="verified_amount_minor"
            inputMode="numeric"
            value={verifiedAmount}
            onChange={(e) => setVerifiedAmount(e.target.value)}
            aria-invalid={Boolean(errors.verified_amount_minor) || undefined}
          />
        </Field>
        <Field label="Currency" required htmlFor="approve-currency" error={errors.currency_code ?? ""}>
          <Input id="approve-currency" name="currency_code" value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </Field>
        <Field
          label="Apply customer credit (minor units)"
          htmlFor="approve-credit"
          hint={
            creditBalance > 0
              ? `Customer credit balance ${formatMinorMoney(creditBalance, submission.currency_code)} · order remaining ${formatMinorMoney(orderRemaining, submission.currency_code)} · at most ${formatMinorMoney(maxCredit, submission.currency_code)} can be applied.`
              : "This customer has no credit balance."
          }
          error={errors.apply_credit_minor ?? ""}
        >
          <Input
            id="approve-credit"
            name="apply_credit_minor"
            inputMode="numeric"
            value={applyCredit}
            onChange={(e) => setApplyCredit(e.target.value)}
            aria-invalid={Boolean(errors.apply_credit_minor) || undefined}
            disabled={maxCredit <= 0}
          />
        </Field>
        <Field label="Verification reference" required htmlFor="approve-reference" hint="Bank statement or receipt reference." error={errors.verification_reference ?? ""}>
          <Input
            id="approve-reference"
            name="verification_reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            aria-invalid={Boolean(errors.verification_reference) || undefined}
            placeholder="e.g. bKash TrxID confirmed on statement"
            maxLength={160}
          />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Internal note" htmlFor="approve-internal-note" error={errors.internal_note ?? ""}>
          <Textarea id="approve-internal-note" name="internal_note" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} maxLength={2000} />
        </Field>
      </div>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer sm-dialog-footer-flush">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="accent" loading={mutation.isPending} onClick={submit}>
          Approve payment
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Reject form — reason is mandatory (spec §3.8)                       */
/* ------------------------------------------------------------------ */
function RejectForm({
  submission,
  onDone,
  onCancel,
}: {
  submission: PaymentSubmission;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [reasonCode, setReasonCode] = useState<string>(REJECT_REASONS[0].code);
  const [customerMessage, setCustomerMessage] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // A-04: one key per form instance — a retried rejection replays.
  const formKey = useIdempotencyKey();
  const mutation = useAdminMutation<unknown, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<unknown>(`/api/v1/admin/payment-submissions/${submission.id}/reject`, {
        method: "POST",
        body: JSON.stringify(body),
        idempotencyKey: formKey,
      }),
    invalidateKeys: [
      detailKey("payment-submissions", submission.id),
      listKey("payment-submissions"),
      listKey("orders"),
      // Q5: same history invalidation as the approve form — the
      // "Verification history" section must refetch after a reject.
      ["admin", "payment-submissions", "history", submission.id],
    ],
    successTitle: "Payment rejected",
    onSuccess: onDone,
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (!/^[A-Z0-9_]{2,80}$/.test(reasonCode)) next.reason_code = "Choose a reason code.";
    if (customerMessage.trim().length < 5)
      next.customer_message = "Explain the rejection to the customer (at least 5 characters).";
    else if (customerMessage.trim().length > 1000)
      next.customer_message = "Message to the customer must be at most 1000 characters.";
    if (internalNote.trim().length > 2000)
      next.internal_note = "Internal note must be at most 2000 characters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    mutation.mutate(
      {
        reason_code: reasonCode,
        customer_message: customerMessage.trim(),
        ...(internalNote.trim() ? { internal_note: internalNote.trim() } : {}),
      },
      {
        onError: (err) => setFormError(err instanceof Error ? err.message : "Request failed"),
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Alert variant="warning">
        Rejecting closes this submission. The order stays unpaid and the
        customer can submit a new payment.
      </Alert>
      <div className="sm-form-grid" style={{ marginTop: 16 }}>
        <Field label="Reason code" required htmlFor="reject-reason" error={errors.reason_code ?? ""}>
          <Select id="reject-reason" name="reason_code" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {REJECT_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Message to customer" required htmlFor="reject-message" error={errors.customer_message ?? ""}>
          <Textarea
            id="reject-message"
            name="customer_message"
            value={customerMessage}
            onChange={(e) => setCustomerMessage(e.target.value)}
            aria-invalid={Boolean(errors.customer_message) || undefined}
            placeholder="We could not verify this payment because…"
            maxLength={1000}
          />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Internal note" htmlFor="reject-internal-note" error={errors.internal_note ?? ""}>
          <Textarea id="reject-internal-note" name="internal_note" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} maxLength={2000} />
        </Field>
      </div>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer sm-dialog-footer-flush">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" loading={mutation.isPending} onClick={submit}>
          Reject payment
        </Button>
      </div>
    </form>
  );
}
