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
 *  - POST /api/v1/admin/orders/:id/payment-evidence       (JSON+base64; 503 fail-closed without R2)
 *  - GET  /api/v1/admin/orders                            orders.read (order picker)
 *  - GET  /api/v1/admin/payment-methods                   payments.read (method picker)
 */
import { useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, ClipboardCheck, Plus } from "lucide-react";
import { apiRequest, formatMinorMoney } from "../lib/api-client";
import { detailKey, listKey } from "../lib/query";
import {
  DetailFacts,
  DetailLayout,
  ListTable,
  PageHeader,
  loadListOptions,
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
  Chip,
  CopyButton,
  DateCell,
  DateTimeCell,
  Dialog,
  ErrorState,
  Field,
  Input,
  MoneyCell,
  SearchableSelect,
  Select,
  Skeleton,
  StatusBadge,
  Textarea,
} from "../components/primitives";
import type { PaymentMethod } from "./payment-methods";

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
  return (id: string) =>
    (navigate as unknown as (opts: { to: string; params: Record<string, string> }) => void)({
      to: `${base}/$${param}`,
      params: { [param]: id },
    });
}

/* ------------------------------------------------------------------ */
/* Payment Review — queue list                                         */
/* ------------------------------------------------------------------ */
export function PaymentReviewSection() {
  const { parsed, setSearch } = useListSearch();
  const goDetail = useGoDetail("/payment-review", "submissionId");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [recordOpen, setRecordOpen] = useState(false);

  const submissions = useAdminList<PaymentSubmission>(
    "payment-submissions",
    "/api/v1/admin/payment-submissions",
  );
  const filtered = useMemo(
    () =>
      (submissions.data ?? []).filter((s) =>
        statusFilter === "all" ? true : s.status === statusFilter,
      ),
    [submissions.data, statusFilter],
  );
  const pendingCount = useMemo(
    () =>
      (submissions.data ?? []).filter(
        (s) => s.status === "submitted" || s.status === "under_review",
      ).length,
    [submissions.data],
  );

  const columns: ColumnDef<PaymentSubmission, unknown>[] = [
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
  ];

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
          <Button variant="accent" icon={Plus} onClick={() => setRecordOpen(true)}>
            Record payment
          </Button>
        }
      />
      <ListTable<PaymentSubmission>
        columns={columns}
        data={filtered}
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
      {recordOpen ? (
        <Dialog open size="md" onClose={() => setRecordOpen(false)} title="Record manual payment">
          <RecordPaymentForm onDone={() => setRecordOpen(false)} onCancel={() => setRecordOpen(false)} />
        </Dialog>
      ) : null}
    </section>
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

  const mutation = useAdminMutation<
    { payment_submission: PaymentSubmission; order: OrderSummary },
    Record<string, unknown>
  >({
    mutationFn: (body) =>
      apiRequest<{ payment_submission: PaymentSubmission; order: OrderSummary }>(
        `/api/v1/admin/orders/${orderId}/payment-submissions`,
        { method: "POST", body: JSON.stringify(body) },
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
    if (paymentDate.trim() && !/^\d{2}\/\d{2}\/\d{4}$/.test(paymentDate.trim()))
      next.payment_date_display = "Use DD/MM/YYYY.";
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

  return (
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
        <Field label="Order" required hint="Unpaid orders only." error={errors.order_id ?? ""}>
          {/* Searchable (PLAN §29): the query runs server-side over
             the full order set (by number, reference or customer
             name). Unpaid-only filtering happens in the loader over
             the first 100 matches — the typed query narrows first, so
             the open order is among them (see ADR-0010). */}
          <SearchableSelect
            value={orderId}
            onChange={(v, option) => onOrderChange(v, option)}
            loadOptions={async (q, signal) => {
              const all = await loadListOptions<OrderSummary>(
                "/api/v1/admin/orders",
                q,
                (o) => ({
                  value: o.id,
                  label: `${o.order_number} — ${formatMinorMoney(o.total_minor, o.currency_code)} (${o.payment_status})`,
                  data: o,
                }),
                signal,
                { limit: 100 },
              );
              return all.filter((o) => {
                const d = o.data as OrderSummary | undefined;
                return d !== undefined && d.payment_status !== "paid" && d.status !== "cancelled";
              });
            }}
            placeholder="Type an order number or customer…"
            ariaLabel="Order"
          />
        </Field>
        <Field label="Payment method" required error={errors.payment_method_id ?? ""}>
          {/* Searchable (PLAN §29): only enabled methods are offered
             (the loader filters). */}
          <SearchableSelect
            value={methodId}
            onChange={(v, option) => onMethodChange(v, option)}
            loadOptions={async (q, signal) => {
              const all = await loadListOptions<PaymentMethod>(
                "/api/v1/admin/payment-methods",
                q,
                (m) => ({ value: m.id, label: m.display_name, data: m }),
                signal,
              );
              return all.filter(
                (o) => (o.data as PaymentMethod | undefined)?.is_enabled,
              );
            }}
            placeholder="Type a method name…"
            ariaLabel="Payment method"
          />
        </Field>
        <Field
          label="Amount (minor units)"
          required
          hint={
            amountPreview
              ? `= ${amountPreview}${selectedOrder ? ` · Remaining ${formatMinorMoney(selectedOrder.remaining_minor ?? selectedOrder.total_minor, selectedOrder.currency_code)}` : ""}${selectedOrder && amountNum > (selectedOrder.remaining_minor ?? selectedOrder.total_minor) ? ` · Exceeds the remaining amount by ${formatMinorMoney(amountNum - (selectedOrder.remaining_minor ?? selectedOrder.total_minor), selectedOrder.currency_code)} — the excess becomes the customer's credit balance at approval.` : ""}`
              : "Minor units, e.g. 50000 = ৳500.00."
          }
          error={errors.amount_minor ?? ""}
        >
          <Input
            inputMode="numeric"
            value={amountMinor}
            onChange={(e) => setAmountMinor(e.target.value)}
            aria-invalid={Boolean(errors.amount_minor) || undefined}
          />
        </Field>
        {orderId !== "" ? (
          <Field label="Apply to installment" hint="Optional — oldest unpaid first when left blank.">
            {/* Local mode: installments are this order's complete set. */}
            <SearchableSelect
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
        <Field label="Currency" required error={errors.currency_code ?? ""}>
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            aria-invalid={Boolean(errors.currency_code) || undefined}
          />
        </Field>
        <Field label="Sender name">
          <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} />
        </Field>
        <Field label="Sender phone">
          <Input value={senderPhone} onChange={(e) => setSenderPhone(e.target.value)} placeholder="01XXXXXXXXX" />
        </Field>
        <Field label="Sender bank name">
          <Input value={senderBank} onChange={(e) => setSenderBank(e.target.value)} />
        </Field>
        <Field label="Sender account reference">
          <Input value={senderRef} onChange={(e) => setSenderRef(e.target.value)} />
        </Field>
        {selectedMethod?.method_kind === "bank_account" ? (
          <Field label="Transfer rail" required error={errors.transfer_rail ?? ""}>
            <Select
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
          error={errors.transaction_id ?? ""}
        >
          <Input value={transactionId} onChange={(e) => setTransactionId(e.target.value)} />
        </Field>
        <Field label="Payment date" hint="DD/MM/YYYY, if known." error={errors.payment_date_display ?? ""}>
          <Input value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} placeholder="15/11/2026" />
        </Field>
        <Field label="Evidence file" hint="Screenshot or receipt. Uploaded to private storage.">
          <Input
            type="file"
            accept="image/*,.pdf"
            onChange={(e) => setEvidenceFile(e.target.files?.[0] ?? null)}
          />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Customer note">
          <Textarea value={customerNote} onChange={(e) => setCustomerNote(e.target.value)} />
        </Field>
      </div>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer" style={{ padding: 0, marginTop: 20 }}>
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
        subtitle="Verify actual receipt before approving — approval marks the order paid"
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

  const mutation = useAdminMutation<unknown, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<unknown>(`/api/v1/admin/payment-submissions/${submission.id}/approve`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [
      detailKey("payment-submissions", submission.id),
      listKey("payment-submissions"),
      listKey("orders"),
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
        <Field label="Verified amount (minor units)" required error={errors.verified_amount_minor ?? ""}>
          <Input
            inputMode="numeric"
            value={verifiedAmount}
            onChange={(e) => setVerifiedAmount(e.target.value)}
            aria-invalid={Boolean(errors.verified_amount_minor) || undefined}
          />
        </Field>
        <Field label="Currency" required error={errors.currency_code ?? ""}>
          <Input value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </Field>
        <Field
          label="Apply customer credit (minor units)"
          hint={
            creditBalance > 0
              ? `Customer credit balance ${formatMinorMoney(creditBalance, submission.currency_code)} · order remaining ${formatMinorMoney(orderRemaining, submission.currency_code)} · at most ${formatMinorMoney(maxCredit, submission.currency_code)} can be applied.`
              : "This customer has no credit balance."
          }
          error={errors.apply_credit_minor ?? ""}
        >
          <Input
            inputMode="numeric"
            value={applyCredit}
            onChange={(e) => setApplyCredit(e.target.value)}
            aria-invalid={Boolean(errors.apply_credit_minor) || undefined}
            disabled={maxCredit <= 0}
          />
        </Field>
        <Field label="Verification reference" required hint="Bank statement or receipt reference." error={errors.verification_reference ?? ""}>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            aria-invalid={Boolean(errors.verification_reference) || undefined}
            placeholder="e.g. bKash TrxID confirmed on statement"
          />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Internal note">
          <Textarea value={internalNote} onChange={(e) => setInternalNote(e.target.value)} />
        </Field>
      </div>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer" style={{ padding: 0, marginTop: 20 }}>
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

  const mutation = useAdminMutation<unknown, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<unknown>(`/api/v1/admin/payment-submissions/${submission.id}/reject`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [
      detailKey("payment-submissions", submission.id),
      listKey("payment-submissions"),
      listKey("orders"),
    ],
    successTitle: "Payment rejected",
    onSuccess: onDone,
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (!/^[A-Z0-9_]{2,80}$/.test(reasonCode)) next.reason_code = "Choose a reason code.";
    if (customerMessage.trim().length < 5)
      next.customer_message = "Explain the rejection to the customer (at least 5 characters).";
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
        <Field label="Reason code" required error={errors.reason_code ?? ""}>
          <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {REJECT_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Message to customer" required error={errors.customer_message ?? ""}>
          <Textarea
            value={customerMessage}
            onChange={(e) => setCustomerMessage(e.target.value)}
            aria-invalid={Boolean(errors.customer_message) || undefined}
            placeholder="We could not verify this payment because…"
          />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Internal note">
          <Textarea value={internalNote} onChange={(e) => setInternalNote(e.target.value)} />
        </Field>
      </div>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer" style={{ padding: 0, marginTop: 20 }}>
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
