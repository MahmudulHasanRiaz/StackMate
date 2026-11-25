/**
 * Expense Categories — Settings config page (Expense Module, 2026-11-25).
 *
 * Route (registered in router.tsx, under the Settings shell):
 * /settings/expense-categories
 *
 * Structure follows sections/payment-methods.tsx (Settings config
 * page): URL-backed list search + server pagination via ListTable,
 * create/edit dialog, row-action menu. Categories are configuration,
 * so they live in Settings, never in the main menu (owner decision
 * 2026-11-16). Deleting a category that still has expenses is a 409
 * from the API — the error is shown verbatim, never swallowed.
 *
 * Endpoints used (contract; API worker builds them in parallel):
 *  - GET    /api/v1/admin/expense-categories[?q=&is_active=&page=&pageSize=]
 *  - POST   /api/v1/admin/expense-categories
 *  - PATCH  /api/v1/admin/expense-categories/:id
 *  - DELETE /api/v1/admin/expense-categories/:id   (409 when expenses exist)
 * See lib/api-client.ts for the camelCase/snake_case casing shim.
 */
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Briefcase,
  Car,
  FileText,
  Gift,
  GraduationCap,
  HeartPulse,
  Home,
  Megaphone,
  Pencil,
  Plane,
  Plus,
  ShoppingCart,
  Tag,
  Trash2,
  Users,
  UtensilsCrossed,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  createExpenseCategory,
  deleteExpenseCategory,
  fetchExpenseCategories,
  updateExpenseCategory,
  type ExpenseCategory,
  type ExpenseCategoryInput,
} from "../lib/api-client";
import { listKey } from "../lib/query";
import {
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminMutation,
  type ListSearch,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  Dialog,
  Field,
  Input,
  RowMenu,
  Select,
  StatusBadge,
  Switch,
  Textarea,
  useConfirm,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* Category icon — stored as a lucide key, never hand-drawn (design    */
/* rule 2026-10-29). The select in the form offers this curated set;   */
/* unknown keys from the API fall back to Tag.                         */
/* ------------------------------------------------------------------ */
export const EXPENSE_ICON_OPTIONS: Array<{ key: string; label: string; icon: LucideIcon }> = [
  { key: "tag", label: "Tag", icon: Tag },
  { key: "shopping-cart", label: "Shopping", icon: ShoppingCart },
  { key: "utensils", label: "Food", icon: UtensilsCrossed },
  { key: "car", label: "Transport", icon: Car },
  { key: "home", label: "Office / Rent", icon: Home },
  { key: "zap", label: "Utilities", icon: Zap },
  { key: "wifi", label: "Internet", icon: Wifi },
  { key: "megaphone", label: "Marketing", icon: Megaphone },
  { key: "wrench", label: "Maintenance", icon: Wrench },
  { key: "briefcase", label: "Professional", icon: Briefcase },
  { key: "users", label: "Team", icon: Users },
  { key: "graduation-cap", label: "Learning", icon: GraduationCap },
  { key: "heart-pulse", label: "Health", icon: HeartPulse },
  { key: "plane", label: "Travel", icon: Plane },
  { key: "gift", label: "Gifts", icon: Gift },
  { key: "file-text", label: "Documents", icon: FileText },
];

export function expenseIconFor(key: string | null): LucideIcon {
  return EXPENSE_ICON_OPTIONS.find((o) => o.key === key)?.icon ?? Tag;
}

export function expenseIconLabel(key: string | null): string {
  return EXPENSE_ICON_OPTIONS.find((o) => o.key === key)?.label ?? "Tag";
}

const COLOR_PRESETS = [
  "#00E599",
  "#38BDF8",
  "#F59E0B",
  "#F43F5E",
  "#A78BFA",
  "#34D399",
  "#F97316",
  "#64748B",
];

function ColorDot({ color }: { color: string | null }) {
  return (
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
  );
}

/* ------------------------------------------------------------------ */
/* URL-backed list search (refunds.tsx shape + is_active filter)       */
/* ------------------------------------------------------------------ */
function useListSearch() {
  const search = useRouterState({ select: (s) => s.location.search }) as Record<
    string,
    unknown
  >;
  const navigate = useNavigate();
  const parsed = parseListSearch(search);
  const isActive =
    search.is_active === "true" ? true : search.is_active === "false" ? false : undefined;
  const setSearch = (next: {
    q?: string | null;
    page?: number;
    pageSize?: number;
    isActive?: boolean | null;
  }) => {
    const merged: ListSearch = { ...parsed };
    if (next.q === null) delete merged.q;
    else if (next.q !== undefined) merged.q = next.q;
    if (next.page !== undefined) merged.page = next.page;
    if (next.pageSize !== undefined) merged.pageSize = next.pageSize;
    (navigate as unknown as (opts: { search: Record<string, unknown> }) => void)({
      search: {
        ...(merged.q ? { q: merged.q } : {}),
        ...(next.isActive === null
          ? {}
          : next.isActive !== undefined
            ? { is_active: String(next.isActive) }
            : isActive !== undefined
              ? { is_active: String(isActive) }
              : {}),
        page: merged.page ?? 1,
        pageSize: merged.pageSize ?? 25,
      },
    });
  };
  return { parsed, isActive, setSearch };
}

/* ------------------------------------------------------------------ */
/* Expense Categories — list                                           */
/* ------------------------------------------------------------------ */
export function ExpenseCategoriesSection() {
  const { parsed, isActive, setSearch } = useListSearch();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);

  const query = useQuery({
    queryKey: [
      ...listKey("expense-categories"),
      { q: parsed.q ?? "", isActive: isActive ?? null, page: parsed.page ?? 1, pageSize: parsed.pageSize ?? 25 },
    ],
    queryFn: () =>
      fetchExpenseCategories({
        q: parsed.q,
        isActive,
        page: parsed.page,
        pageSize: parsed.pageSize,
      }),
    placeholderData: keepPreviousData,
  });

  const toggleMutation = useAdminMutation<ExpenseCategory, { id: string; isActive: boolean }>({
    mutationFn: ({ id, isActive: next }) => updateExpenseCategory(id, { isActive: next }),
    invalidateKeys: [listKey("expense-categories")],
    successTitle: "Category updated",
  });

  const deleteMutation = useAdminMutation<void, ExpenseCategory>({
    mutationFn: (category) => deleteExpenseCategory(category.id),
    invalidateKeys: [listKey("expense-categories")],
    successTitle: "Category deleted",
  });

  const onToggle = (category: ExpenseCategory) => {
    toggleMutation.mutate({ id: category.id, isActive: !category.isActive });
  };

  const onDelete = async (category: ExpenseCategory) => {
    const ok = await confirm({
      title: `Delete ${category.name}?`,
      body:
        category.expenseCount > 0
          ? `This category has ${category.expenseCount} expense${category.expenseCount === 1 ? "" : "s"}. The server will refuse the delete until those expenses are moved to another category.`
          : "This will permanently delete the category. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      warning:
        category.expenseCount > 0
          ? `This category still has ${category.expenseCount} expense${category.expenseCount === 1 ? "" : "s"} — the delete will be refused.`
          : "This will permanently delete the category.",
    });
    if (ok) deleteMutation.mutate(category);
  };

  const columns: ColumnDef<ExpenseCategory, unknown>[] = [
    {
      accessorKey: "name",
      header: "Category",
      cell: ({ row }) => {
        const Icon = expenseIconFor(row.original.icon);
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <ColorDot color={row.original.color} />
            <Icon size={16} strokeWidth={2} aria-hidden="true" />
            <strong>{row.original.name}</strong>
          </span>
        );
      },
    },
    {
      accessorKey: "icon",
      header: "Icon",
      cell: ({ row }) => expenseIconLabel(row.original.icon),
    },
    {
      accessorKey: "expenseCount",
      header: "Expenses",
      cell: ({ row }) => <span className="sm-tabular">{row.original.expenseCount}</span>,
    },
    {
      accessorKey: "isActive",
      header: "Status",
      cell: ({ row }) => (
        <StatusBadge status={row.original.isActive ? "active" : "inactive"} />
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          items={[
            {
              icon: Pencil,
              label: "Edit",
              onSelect: () => setEditing(row.original),
            },
            {
              label: row.original.isActive ? "Deactivate" : "Activate",
              onSelect: () => onToggle(row.original),
            },
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
    <section aria-labelledby="expense-categories-heading">
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "Expense Categories" }]}
        title="Expense Categories"
        help="Categories group expenses for the Profit & Loss report. A category with expenses cannot be deleted until its expenses move elsewhere."
        action={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Create category
          </Button>
        }
      />
      <ListTable<ExpenseCategory>
        columns={columns}
        data={query.data?.items}
        serverSearch
        serverPagination
        refreshSection="expense-categories"
        total={query.data?.total ?? 0}
        search={parsed.q ?? ""}
        onSearchChange={(q) => setSearch({ q: q || null, page: 1 })}
        page={parsed.page ?? 1}
        onPageChange={(page) => setSearch({ page })}
        pageSize={parsed.pageSize ?? 25}
        onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        filtersActive={isActive !== undefined}
        toolbar={
          <Select
            id="expense-categories-status-filter"
            name="is_active"
            value={isActive === undefined ? "" : String(isActive)}
            onChange={(e) =>
              setSearch({
                isActive: e.target.value === "" ? null : e.target.value === "true",
                page: 1,
              })
            }
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
        }
        emptyIcon={Tag}
        emptyTitle="No expense categories yet"
        emptyBody="Create the first category so expenses can be grouped for reporting."
        emptyActionLabel="Create category"
        onEmptyAction={() => setCreateOpen(true)}
        getRowId={(row) => row.id}
      />
      {createOpen ? (
        <Dialog open size="md" onClose={() => setCreateOpen(false)} title="Create category">
          <CategoryForm onDone={() => setCreateOpen(false)} onCancel={() => setCreateOpen(false)} />
        </Dialog>
      ) : null}
      {editing ? (
        <Dialog open size="md" onClose={() => setEditing(null)} title={`Edit ${editing.name}`}>
          <CategoryForm
            initial={editing}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Category create / edit form                                         */
/* ------------------------------------------------------------------ */
function CategoryForm({
  initial,
  onDone,
  onCancel,
}: {
  initial?: ExpenseCategory;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState(initial?.color ?? "#00E599");
  const [icon, setIcon] = useState(initial?.icon ?? "tag");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useAdminMutation<ExpenseCategory, ExpenseCategoryInput>({
    mutationFn: (body) =>
      initial ? updateExpenseCategory(initial.id, body) : createExpenseCategory(body),
    invalidateKeys: [listKey("expense-categories")],
    successTitle: initial ? "Category updated" : "Category created",
    onSuccess: onDone,
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next.name = "Name needs at least 2 characters.";
    if (!/^#[0-9a-fA-F]{6}$/.test(color.trim()))
      next.color = "Use a hex colour, e.g. #00E599.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    mutation.mutate(
      { name: name.trim(), description: description.trim() || null, color: color.trim(), icon, isActive },
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
        <Field label="Name" required htmlFor="expense-category-name" error={errors.name ?? ""}>
          <Input
            id="expense-category-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={Boolean(errors.name) || undefined}
            placeholder="Office supplies"
          />
        </Field>
        <Field label="Icon" required htmlFor="expense-category-icon">
          <Select
            id="expense-category-icon"
            name="icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
          >
            {EXPENSE_ICON_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Description" htmlFor="expense-category-description" hint="Optional — max 2000 characters.">
          <Textarea
            id="expense-category-description"
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What belongs in this category?"
          />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <Field label="Colour" required htmlFor="expense-category-color" error={errors.color ?? ""}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {COLOR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-label={`Use colour ${preset}`}
                aria-pressed={color.toLowerCase() === preset.toLowerCase()}
                onClick={() => setColor(preset)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  border:
                    color.toLowerCase() === preset.toLowerCase()
                      ? "2px solid var(--hatch-widget-text, #fff)"
                      : "1px solid var(--hatch-widget-border, #444)",
                  backgroundColor: preset,
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            ))}
            <input
              id="expense-category-color"
              name="color"
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#00E599"}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Custom colour"
              style={{ width: 32, height: 24, padding: 0, border: "none", background: "none", cursor: "pointer" }}
            />
            <span className="sm-mono">{color}</span>
          </span>
        </Field>
      </div>
      {initial ? (
        <div style={{ marginTop: 16 }}>
          <Switch
            id="expense-category-active"
            name="is_active"
            label={isActive ? "Active" : "Inactive"}
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
        </div>
      ) : null}
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
          {initial ? "Save changes" : "Create category"}
        </Button>
      </div>
    </form>
  );
}
