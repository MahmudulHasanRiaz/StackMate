/**
 * Expenses — operational list (Expense Module, 2026-11-25).
 *
 * Route (registered in router.tsx, under the _main shell): /expenses
 * Main-menu Finance group (shell.tsx NAVIGATION_GROUPS).
 *
 * List: date, vendor, category, product, amount, receipt link.
 * Filters are all URL-persisted (q, categoryId, productId, from, to,
 * page, pageSize) and all server-side: the category/product selects
 * search the full dataset via ?q= (PLAN §29 — never a filter over a
 * loaded page), and the date range follows the dashboard pattern
 * (presets + custom DD/MM/YYYY dialog, same 366-day cap).
 *
 * Endpoints used (contract; API worker builds them in parallel):
 *  - GET    /api/v1/admin/expenses[?q=&categoryId=&productId=&from=&to=&page=&pageSize=]
 *  - POST   /api/v1/admin/expenses
 *  - PATCH  /api/v1/admin/expenses/:id
 *  - DELETE /api/v1/admin/expenses/:id
 * Amounts are integer minor units (BDT); dates are YYYY-MM-DD on the
 * wire, DD/MM/YYYY on screen. Receipts are media-library assets
 * picked with the shared MediaPicker (ADR-0011); the list links the
 * asset through /api/v1/admin/media/:id/content.
 * See lib/api-client.ts for the camelCase/snake_case casing shim.
 */
import { useMemo, useState, type FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Receipt, Trash2 } from "lucide-react";
import {
  createExpense,
  deleteExpense,
  fetchExpenses,
  updateExpense,
  type Expense,
  type ExpenseCategory,
  type ExpenseInput,
} from "../lib/api-client";
import { listKey } from "../lib/query";
import {
  DASHBOARD_PRESETS,
  ddmmyyyyToIso,
  dhakaTodayIso,
  formatRangeLabel,
  isoToDdmmyyyy,
  normalizeDateInput,
  normalizePastedDate,
  presetRange,
  type DashboardPreset,
} from "../lib/dates";
import {
  detailLabelResolver,
  ListTable,
  loadListOptions,
  PageHeader,
  parseListSearch,
  useAdminList,
  useAdminMutation,
} from "../lib/section-kit";
import { MediaPicker } from "../components/media-picker";
import type { MediaAssetView } from "../lib/media";
import {
  Alert,
  Button,
  Dialog,
  Field,
  Input,
  MoneyCell,
  RowMenu,
  SearchableSelect,
  Textarea,
  useConfirm,
} from "../components/primitives";

const EXPENSE_CURRENCY = "BDT";
const MAX_RANGE_DAYS = 366;

/* ------------------------------------------------------------------ */
/* URL-backed search (refunds.tsx shape, extended with the expense     */
/* filters). Every filter lives in the URL, so a filtered list         */
/* survives navigation and refresh.                                    */
/* ------------------------------------------------------------------ */
interface ExpenseSearch {
  q?: string | undefined;
  categoryId?: string | undefined;
  productId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page: number;
  pageSize: number;
}

function readExpenseSearch(raw: Record<string, unknown>): ExpenseSearch {
  const parsed = parseListSearch(raw);
  const str = (key: string) =>
    typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : undefined;
  return {
    ...parsed,
    page: parsed.page ?? 1,
    pageSize: parsed.pageSize ?? 25,
    categoryId: str("categoryId"),
    productId: str("productId"),
    from: str("from"),
    to: str("to"),
  };
}

function useExpenseSearchControls() {
  const rawSearch = useRouterState({ select: (s) => s.location.search }) as Record<
    string,
    unknown
  >;
  const navigate = useNavigate();
  const parsed = readExpenseSearch(rawSearch);
  const update = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...rawSearch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null || value === "") delete next[key];
      else next[key] = value;
    }
    (navigate as unknown as (opts: { search: Record<string, unknown> }) => void)({
      search: next,
    });
  };
  return { parsed, update };
}

/* ------------------------------------------------------------------ */
/* Date-range filter — dashboard pattern, shared with profit-loss.     */
/* Presets write from/to into the URL; Custom opens the DD/MM/YYYY     */
/* dialog; All time clears both. The caller owns the URL update.       */
/* ------------------------------------------------------------------ */
export function DateRangeFilter({
  from,
  to,
  onApply,
}: {
  from: string | undefined;
  to: string | undefined;
  onApply: (range: { from?: string; to?: string } | null) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  const bounds = from && to && from <= to ? { from, to } : null;
  const activePreset: DashboardPreset | "custom" | null = (() => {
    if (!bounds) return from || to ? "custom" : null;
    for (const p of DASHBOARD_PRESETS) {
      if (p.key === "all") continue;
      const r = presetRange(p.key);
      if (r && r.from === bounds.from && r.to === bounds.to) return p.key;
    }
    return "custom";
  })();

  const openCustom = () => {
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
    const spanDays = (() => {
      const [fy, fm, fd] = fromIso.split("-").map(Number);
      const [ty, tm, td] = toIso.split("-").map(Number);
      return (
        Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000) + 1
      );
    })();
    if (spanDays > MAX_RANGE_DAYS) {
      setCustomError(`The range must not exceed ${MAX_RANGE_DAYS} days.`);
      return;
    }
    setCustomOpen(false);
    onApply({ from: fromIso, to: toIso });
  };

  return (
    <>
      <span className="sm-filter-row" role="group" aria-label="Date range" style={{ flexWrap: "wrap" }}>
        {DASHBOARD_PRESETS.map((p) => {
          const isActive =
            p.key === "all" ? !from && !to : activePreset === p.key;
          return (
            <Button
              key={p.key}
              size="sm"
              variant={isActive ? "accent" : "secondary"}
              aria-pressed={isActive}
              onClick={() =>
                p.key === "all"
                  ? onApply(null)
                  : onApply(presetRange(p.key) ?? null)
              }
            >
              {p.label}
            </Button>
          );
        })}
        <Button
          size="sm"
          variant={activePreset === "custom" ? "accent" : "secondary"}
          aria-pressed={activePreset === "custom"}
          onClick={openCustom}
        >
          Custom
        </Button>
        <span className="sm-filter-label" aria-live="polite">
          {formatRangeLabel(bounds)}
        </span>
      </span>
      {customOpen ? (
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
                  onApply(null);
                }}
              >
                Clear
              </Button>
              <Button variant="accent" type="submit" form="expense-custom-range-form">
                Apply
              </Button>
            </>
          }
        >
          <form id="expense-custom-range-form" onSubmit={submitCustom}>
            <Field label="From" required htmlFor="expense-custom-from" hint="DD/MM/YYYY." error={customError ?? ""}>
              <input
                id="expense-custom-from"
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
            <Field label="To" required htmlFor="expense-custom-to" hint="DD/MM/YYYY." error="">
              <input
                id="expense-custom-to"
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
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Server-side option loaders (PLAN §29 — ?q= over the full set)       */
/* ------------------------------------------------------------------ */
function loadCategoryOptions(q: string, signal: AbortSignal) {
  return loadListOptions<ExpenseCategory>(
    "/api/v1/admin/expense-categories",
    q,
    (c) => ({ value: c.id, label: c.name }),
    signal,
    { extra: { is_active: "true" } },
  );
}

export function loadProductOptions(q: string, signal: AbortSignal) {
  return loadListOptions<{ id: string; name: string }>(
    "/api/v1/admin/products",
    q,
    (p) => ({ value: p.id, label: p.name }),
    signal,
  );
}

function loadPaymentMethodOptions(q: string, signal: AbortSignal) {
  return loadListOptions<{ id: string; display_name: string }>(
    "/api/v1/admin/payment-methods",
    q,
    (m) => ({ value: m.id, label: m.display_name }),
    signal,
  );
}

const resolveCategoryLabel = detailLabelResolver<ExpenseCategory>(
  (id) => `/api/v1/admin/expense-categories/${id}`,
  (c) => c.name,
);
export const resolveProductLabel = detailLabelResolver<{ id: string; name: string }>(
  (id) => `/api/v1/admin/products/${id}`,
  (p) => p.name,
);
const resolvePaymentMethodLabel = detailLabelResolver<{ id: string; display_name: string }>(
  (id) => `/api/v1/admin/payment-methods/${id}`,
  (m) => m.display_name,
);

/* ------------------------------------------------------------------ */
/* Expenses — list                                                     */
/* ------------------------------------------------------------------ */
export function ExpensesSection() {
  const { parsed, update } = useExpenseSearchControls();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);

  const query = useQuery({
    queryKey: [
      ...listKey("expenses"),
      {
        q: parsed.q ?? "",
        categoryId: parsed.categoryId ?? "",
        productId: parsed.productId ?? "",
        from: parsed.from ?? "",
        to: parsed.to ?? "",
        page: parsed.page,
        pageSize: parsed.pageSize,
      },
    ],
    queryFn: () =>
      fetchExpenses({
        q: parsed.q,
        categoryId: parsed.categoryId,
        productId: parsed.productId,
        from: parsed.from,
        to: parsed.to,
        page: parsed.page,
        pageSize: parsed.pageSize,
      }),
    placeholderData: keepPreviousData,
  });

  // Fallback name maps for rows whose embedded names are missing
  // (the list embeds category/product names when the API provides
  // them; the maps only fill gaps, never filter).
  const categories = useAdminList<{ id: string; name: string; color?: string | null }>(
    "expense-categories",
    "/api/v1/admin/expense-categories",
  );
  const products = useAdminList<{ id: string; name: string }>(
    "products",
    "/api/v1/admin/products",
  );
  const categoryById = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.id, c])),
    [categories.data],
  );
  const productById = useMemo(
    () => new Map((products.data ?? []).map((p) => [p.id, p])),
    [products.data],
  );

  const deleteMutation = useAdminMutation<void, Expense>({
    mutationFn: (expense) => deleteExpense(expense.id),
    invalidateKeys: [listKey("expenses"), listKey("expense-categories"), ["admin", "profit-loss"]],
    successTitle: "Expense deleted",
  });

  const onDelete = async (expense: Expense) => {
    const ok = await confirm({
      title: "Delete this expense?",
      body: `This will permanently delete the ${formatMinorMoneyShort(expense.amountMinor)} expense${expense.vendor ? ` from ${expense.vendor}` : ""}. This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
      warning: "This will permanently delete the expense.",
    });
    if (ok) deleteMutation.mutate(expense);
  };

  const filtersActive = Boolean(
    parsed.categoryId || parsed.productId || parsed.from || parsed.to,
  );

  const columns: ColumnDef<Expense, unknown>[] = [
    {
      accessorKey: "expenseDate",
      header: "Date",
      cell: ({ row }) => (
        <span className="sm-tabular">
          {row.original.expenseDate ? isoToDdmmyyyy(row.original.expenseDate) : "—"}
        </span>
      ),
    },
    {
      accessorKey: "vendor",
      header: "Vendor",
      cell: ({ row }) => (
        <span className="sm-cell-text">{row.original.vendor ?? "—"}</span>
      ),
    },
    {
      accessorKey: "categoryId",
      header: "Category",
      cell: ({ row }) => {
        const fallback = categoryById.get(row.original.categoryId);
        const name = row.original.categoryName ?? fallback?.name ?? "—";
        const color = row.original.categoryColor ?? fallback?.color ?? null;
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                backgroundColor: color ?? "#64748B",
                flexShrink: 0,
              }}
            />
            {name}
          </span>
        );
      },
    },
    {
      accessorKey: "productId",
      header: "Product",
      cell: ({ row }) =>
        row.original.productId
          ? (row.original.productName ?? productById.get(row.original.productId)?.name ?? "—")
          : "—",
    },
    {
      accessorKey: "amountMinor",
      header: "Amount",
      cell: ({ row }) => (
        <MoneyCell currency={EXPENSE_CURRENCY} minor={row.original.amountMinor} />
      ),
    },
    {
      accessorKey: "receiptMediaId",
      header: "Receipt",
      cell: ({ row }) =>
        row.original.receiptUrl ? (
          <a className="sm-link-btn" href={row.original.receiptUrl} target="_blank" rel="noreferrer">
            View receipt
          </a>
        ) : row.original.receiptMediaId ? (
          <a
            className="sm-link-btn"
            href={`/api/v1/admin/media/${row.original.receiptMediaId}/content`}
            target="_blank"
            rel="noreferrer"
          >
            View receipt
          </a>
        ) : (
          "—"
        ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          items={[
            { icon: Pencil, label: "Edit", onSelect: () => setEditing(row.original) },
            {
              icon: Trash2,
              label: "Delete",
              danger: true,
              onSelect: () => void onDelete(row.original),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <section aria-labelledby="expenses-heading">
      <PageHeader
        breadcrumb={[{ label: "Finance" }, { label: "Expenses" }]}
        title="Expenses"
        help="Money spent running the business — grouped by category and product, and reported in Profit & Loss."
        action={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Record expense
          </Button>
        }
      />
      <div style={{ marginBottom: 12 }}>
        <DateRangeFilter
          from={parsed.from}
          to={parsed.to}
          onApply={(range) =>
            update(range === null ? { from: undefined, to: undefined, page: 1 } : { ...range, page: 1 })
          }
        />
      </div>
      <ListTable<Expense>
        columns={columns}
        data={query.data?.items}
        serverSearch
        serverPagination
        refreshSection="expenses"
        total={query.data?.total ?? 0}
        search={parsed.q ?? ""}
        onSearchChange={(q) => update({ q: q || undefined, page: 1 })}
        page={parsed.page}
        onPageChange={(page) => update({ page })}
        pageSize={parsed.pageSize}
        onPageSizeChange={(pageSize) => update({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        filtersActive={filtersActive}
        toolbar={
          <>
            <span style={{ display: "inline-block", width: 220 }}>
              <SearchableSelect
                value={parsed.categoryId ?? ""}
                onChange={(v) => update({ categoryId: v || undefined, page: 1 })}
                loadOptions={loadCategoryOptions}
                resolveLabel={resolveCategoryLabel}
                leadingOptions={[{ value: "", label: "All categories" }]}
                placeholder="All categories"
                ariaLabel="Filter by category"
              />
            </span>
            <span style={{ display: "inline-block", width: 220 }}>
              <SearchableSelect
                value={parsed.productId ?? ""}
                onChange={(v) => update({ productId: v || undefined, page: 1 })}
                loadOptions={loadProductOptions}
                resolveLabel={resolveProductLabel}
                leadingOptions={[{ value: "", label: "All products" }]}
                placeholder="All products"
                ariaLabel="Filter by product"
              />
            </span>
            {filtersActive ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  update({ categoryId: undefined, productId: undefined, from: undefined, to: undefined, page: 1 })
                }
              >
                Clear filters
              </Button>
            ) : null}
          </>
        }
        emptyIcon={Receipt}
        emptyTitle="No expenses yet"
        emptyBody="Record the first expense — it will show up in Profit & Loss right away."
        emptyActionLabel="Record expense"
        onEmptyAction={() => setCreateOpen(true)}
        getRowId={(row) => row.id}
      />
      {createOpen ? (
        <Dialog open size="md" onClose={() => setCreateOpen(false)} title="Record expense">
          <ExpenseForm onDone={() => setCreateOpen(false)} onCancel={() => setCreateOpen(false)} />
        </Dialog>
      ) : null}
      {editing ? (
        <Dialog open size="md" onClose={() => setEditing(null)} title="Edit expense">
          <ExpenseForm
            initial={editing}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      ) : null}
    </section>
  );
}

/** Short ৳ amount for the delete confirm (no extra import — the
 *  contract's formatMinorMoney lives in api-client's re-exports). */
function formatMinorMoneyShort(minor: number): string {
  return `৳${(minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/* ------------------------------------------------------------------ */
/* Expense create / edit form                                          */
/* ------------------------------------------------------------------ */
function ExpenseForm({
  initial,
  onDone,
  onCancel,
}: {
  initial?: Expense;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [amountMajor, setAmountMajor] = useState(
    initial ? String(initial.amountMinor / 100) : "",
  );
  const [expenseDate, setExpenseDate] = useState(
    initial?.expenseDate ? isoToDdmmyyyy(initial.expenseDate) : isoToDdmmyyyy(dhakaTodayIso()),
  );
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? "");
  const [productId, setProductId] = useState(initial?.productId ?? "");
  const [paymentMethodId, setPaymentMethodId] = useState(initial?.paymentMethodId ?? "");
  const [vendor, setVendor] = useState(initial?.vendor ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [receipt, setReceipt] = useState<{
    id: string;
    name: string;
    url: string;
  } | null>(
    initial?.receiptMediaId
      ? {
          id: initial.receiptMediaId,
          name: "Receipt",
          url:
            initial.receiptUrl ??
            `/api/v1/admin/media/${initial.receiptMediaId}/content`,
        }
      : null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useAdminMutation<Expense, ExpenseInput>({
    mutationFn: (body) =>
      initial ? updateExpense(initial.id, body) : createExpense(body),
    invalidateKeys: [
      listKey("expenses"),
      listKey("expense-categories"),
      ["admin", "profit-loss"],
    ],
    successTitle: initial ? "Expense updated" : "Expense recorded",
    onSuccess: onDone,
  });

  const submit = () => {
    const next: Record<string, string> = {};
    const amount = Number(amountMajor);
    if (!Number.isFinite(amount) || amount <= 0)
      next.amount = "Enter an amount greater than 0.";
    const dateIso = ddmmyyyyToIso(expenseDate);
    if (!dateIso) next.expenseDate = "Use DD/MM/YYYY.";
    if (!categoryId) next.categoryId = "Choose a category.";
    setErrors(next);
    if (Object.keys(next).length > 0 || !dateIso) return;
    setFormError(null);
    mutation.mutate(
      {
        amountMinor: Math.round(amount * 100),
        expenseDate: dateIso,
        categoryId,
        productId: productId || null,
        paymentMethodId: paymentMethodId || null,
        vendor: vendor.trim() || null,
        notes: notes.trim() || null,
        receiptMediaId: receipt?.id ?? null,
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
      <div className="sm-form-grid">
        <Field label="Amount (৳)" required htmlFor="expense-amount" error={errors.amount ?? ""}>
          <Input
            id="expense-amount"
            name="amount"
            inputMode="decimal"
            value={amountMajor}
            onChange={(e) => setAmountMajor(e.target.value)}
            aria-invalid={Boolean(errors.amount) || undefined}
            placeholder="500.00"
          />
        </Field>
        <Field label="Date" required htmlFor="expense-date" hint="DD/MM/YYYY." error={errors.expenseDate ?? ""}>
          <input
            id="expense-date"
            name="expense_date"
            className="sm-input"
            value={expenseDate}
            onChange={(e) => setExpenseDate(normalizeDateInput(e.target.value))}
            onPaste={(e) => {
              e.preventDefault();
              setExpenseDate(normalizePastedDate(e.clipboardData.getData("text")));
            }}
            placeholder="DD/MM/YYYY"
            inputMode="numeric"
            autoComplete="off"
          />
        </Field>
        <Field label="Category" required htmlFor="expense-category" error={errors.categoryId ?? ""}>
          <SearchableSelect
            id="expense-category"
            value={categoryId}
            onChange={(v) => setCategoryId(v)}
            loadOptions={loadCategoryOptions}
            resolveLabel={resolveCategoryLabel}
            placeholder="Type a category name…"
            ariaLabel="Category"
          />
        </Field>
        <Field label="Product" htmlFor="expense-product" hint="Optional — links the spend to a product.">
          <SearchableSelect
            id="expense-product"
            value={productId}
            onChange={(v) => setProductId(v)}
            loadOptions={loadProductOptions}
            resolveLabel={resolveProductLabel}
            leadingOptions={[{ value: "", label: "No product" }]}
            placeholder="Type a product name…"
            ariaLabel="Product"
          />
        </Field>
        <Field label="Payment method" htmlFor="expense-payment-method" hint="Optional — how it was paid.">
          <SearchableSelect
            id="expense-payment-method"
            value={paymentMethodId}
            onChange={(v) => setPaymentMethodId(v)}
            loadOptions={loadPaymentMethodOptions}
            resolveLabel={resolvePaymentMethodLabel}
            leadingOptions={[{ value: "", label: "No payment method" }]}
            placeholder="Type a payment method…"
            ariaLabel="Payment method"
          />
        </Field>
        <Field label="Vendor" htmlFor="expense-vendor" hint="Optional — who was paid.">
          <Input
            id="expense-vendor"
            name="vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="e.g. Daraz, Hostinger"
          />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Notes" htmlFor="expense-notes" hint="Optional — what this was for.">
          <Textarea
            id="expense-notes"
            name="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Domain renewal, ad spend, office supplies…"
          />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Receipt" htmlFor="expense-receipt" hint="Optional — pick from the media library or upload a new file.">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Button variant="secondary" onClick={() => setPickerOpen(true)}>
              {receipt ? "Change receipt" : "Choose from library"}
            </Button>
            {receipt ? (
              <>
                <a className="sm-link-btn" href={receipt.url} target="_blank" rel="noreferrer">
                  {receipt.name}
                </a>
                <Button variant="ghost" size="sm" onClick={() => setReceipt(null)}>
                  Remove
                </Button>
              </>
            ) : null}
          </span>
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
          {initial ? "Save changes" : "Record expense"}
        </Button>
      </div>
      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(asset: MediaAssetView) => {
          setReceipt({ id: asset.id, name: asset.original_filename, url: asset.content_url });
          setPickerOpen(false);
        }}
        kinds={["image", "document"]}
        title="Choose receipt from media library"
      />
    </form>
  );
}
