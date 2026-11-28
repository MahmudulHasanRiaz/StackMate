/**
 * Expense Categories — Finance tree list (Expense Module, 2026-11-25;
 * moved out of Settings 2026-11-26).
 *
 * Route (registered in router.tsx, under the _main shell):
 * /expenses/categories — Finance → Expenses → Categories (sub-menu).
 *
 * The list is a tree, not a flat table: rows indent by depth, every
 * parent has an expand/collapse chevron (top level expanded, deeper
 * levels collapsed by default), and each row shows its colour dot,
 * icon, name, depth, expense count, child count, and status.
 *
 * Data: GET /api/v1/admin/expense-categories/tree (nested children,
 * depth, path) when the backend serves it; until then the flat list
 * (page 1, 100 rows) is turned into a client-side tree as a fallback.
 * Search + status filter are URL-backed (q, is_active) and, while
 * filtering, the tree flattens to the matching rows (collapse ignored).
 *
 * Writes send schema keys only (parent_id, snake_case — the 2026-11-25
 * strict-validator bug). Deleting a category that still has expenses
 * OR children is a 409 from the API — the server message is shown
 * verbatim, never swallowed. Editing never offers the category itself
 * or any of its descendants as a parent (cycle prevention in the UI;
 * the backend checks it too).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Briefcase,
  Car,
  ChevronDown,
  ChevronRight,
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
  fetchExpenseCategoryTree,
  flattenExpenseCategoryTree,
  indentedCategoryName,
  updateExpenseCategory,
  type ExpenseCategory,
  type ExpenseCategoryInput,
  type ExpenseCategoryTreeNode,
} from "../lib/api-client";
import { listKey, queryClient } from "../lib/query";
import {
  PageHeader,
  parseListSearch,
  useAdminMutation,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  RowMenu,
  SearchableSelect,
  Select,
  StatusBadge,
  Switch,
  TableSkeleton,
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
/* URL-backed search (q + is_active only — the tree has no pages).     */
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
  const setSearch = (next: { q?: string | null; isActive?: boolean | null }) => {
    const q = next.q !== undefined ? next.q : (parsed.q ?? null);
    const active = next.isActive !== undefined ? next.isActive : isActive;
    (navigate as unknown as (opts: { search: Record<string, unknown> }) => void)({
      search: {
        ...(q ? { q } : {}),
        ...(active === null || active === undefined ? {} : { is_active: String(active) }),
      },
    });
  };
  return { q: parsed.q ?? "", isActive, setSearch };
}

/* ------------------------------------------------------------------ */
/* Client-side tree fallback: flat rows → nested tree (depth / path /  */
/* childCount recomputed from the links). Used only while the tree     */
/* endpoint is unavailable — the tree endpoint is the real source.     */
/* ------------------------------------------------------------------ */
function buildTreeFromFlat(items: ExpenseCategory[]): ExpenseCategoryTreeNode[] {
  const nodes = new Map<string, ExpenseCategoryTreeNode>();
  for (const item of items) nodes.set(item.id, { ...item, children: [] });
  const roots: ExpenseCategoryTreeNode[] = [];
  for (const item of items) {
    const node = nodes.get(item.id);
    if (!node) continue;
    if (item.parentId && nodes.has(item.parentId)) {
      nodes.get(item.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const fix = (list: ExpenseCategoryTreeNode[], depth: number, parentPath: string) => {
    for (const node of list) {
      node.depth = depth;
      node.path = parentPath ? `${parentPath} / ${node.name}` : node.name;
      node.childCount = node.children.length;
      fix(node.children, depth + 1, node.path);
    }
  };
  fix(roots, 0, "");
  return roots;
}

function findTreeNode(
  nodes: ExpenseCategoryTreeNode[],
  id: string,
): ExpenseCategoryTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findTreeNode(node.children, id);
    if (found) return found;
  }
  return null;
}

interface TreeRow {
  node: ExpenseCategoryTreeNode;
  depth: number;
  path: string;
}

/** Visible rows honouring collapse (used when not filtering). */
function visibleTreeRows(
  nodes: ExpenseCategoryTreeNode[],
  collapsedIds: ReadonlySet<string>,
): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (list: ExpenseCategoryTreeNode[], depth: number, parentPath: string) => {
    for (const node of list) {
      const path = parentPath ? `${parentPath} / ${node.name}` : node.name;
      out.push({ node, depth, path });
      if (node.children.length > 0 && !collapsedIds.has(node.id)) {
        walk(node.children, depth + 1, path);
      }
    }
  };
  walk(nodes, 0, "");
  return out;
}

const ROW_GRID = "minmax(220px, 1fr) 52px 76px 108px 96px 36px";

/* ------------------------------------------------------------------ */
/* Expense Categories — tree list                                      */
/* ------------------------------------------------------------------ */
export function ExpenseCategoriesSection() {
  const { q, isActive, setSearch } = useListSearch();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const defaultsApplied = useRef(false);

  const treeQuery = useQuery({
    queryKey: [...listKey("expense-categories"), "tree"],
    queryFn: fetchExpenseCategoryTree,
    // The tree endpoint lands with the backend worker; a 404 before
    // then must fall through to the flat fallback, not retry.
    retry: false,
    placeholderData: keepPreviousData,
  });
  const flatQuery = useQuery({
    queryKey: [...listKey("expense-categories"), "flat-fallback"],
    queryFn: () => fetchExpenseCategories({ page: 1, pageSize: 100 }),
    enabled: treeQuery.isError,
    placeholderData: keepPreviousData,
  });

  const tree = useMemo<ExpenseCategoryTreeNode[] | undefined>(() => {
    if (treeQuery.data) return treeQuery.data;
    if (flatQuery.data) return buildTreeFromFlat(flatQuery.data.items);
    return undefined;
  }, [treeQuery.data, flatQuery.data]);

  const isLoading = treeQuery.isPending || (treeQuery.isError && flatQuery.isPending);
  const isError = treeQuery.isError && flatQuery.isError;
  const error = flatQuery.error ?? treeQuery.error;

  // Default collapse (expert call): top level expanded, deeper levels
  // collapsed — applied once, when the tree first arrives; the user's
  // own toggles after that are never overwritten by a refetch.
  useEffect(() => {
    if (defaultsApplied.current || !tree) return;
    defaultsApplied.current = true;
    const next = new Set<string>();
    for (const { node, depth } of flattenExpenseCategoryTree(tree)) {
      if (depth >= 1 && node.children.length > 0) next.add(node.id);
    }
    setCollapsedIds(next);
  }, [tree]);

  const allRows = useMemo(
    () => (tree ? flattenExpenseCategoryTree(tree) : []),
    [tree],
  );
  const filtering = Boolean(q) || isActive !== undefined;
  const visibleRows = useMemo<TreeRow[]>(() => {
    if (!tree) return [];
    if (filtering) {
      const needle = q.trim().toLowerCase();
      return allRows.filter(({ node }) => {
        if (isActive !== undefined && node.isActive !== isActive) return false;
        if (needle && !node.name.toLowerCase().includes(needle)) return false;
        return true;
      });
    }
    return visibleTreeRows(tree, collapsedIds);
  }, [tree, allRows, filtering, q, isActive, collapsedIds]);

  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** After a create/edit, make sure its parent is expanded so the
   *  saved row is visible in the tree. */
  const expandParentOf = (saved: ExpenseCategory) => {
    if (!saved.parentId) return;
    setCollapsedIds((prev) => {
      if (!prev.has(saved.parentId as string)) return prev;
      const next = new Set(prev);
      next.delete(saved.parentId as string);
      return next;
    });
  };

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

  const onDelete = async (category: ExpenseCategoryTreeNode) => {
    const blockers: string[] = [];
    if (category.expenseCount > 0) {
      blockers.push(
        `${category.expenseCount} expense${category.expenseCount === 1 ? "" : "s"}`,
      );
    }
    if (category.childCount > 0) {
      blockers.push(
        `${category.childCount} sub-categor${category.childCount === 1 ? "y" : "ies"}`,
      );
    }
    const ok = await confirm({
      title: `Delete ${category.name}?`,
      body:
        blockers.length > 0
          ? `This category still has ${blockers.join(" and ")}. The server will refuse the delete until those expenses are moved to another category and its sub-categories are moved or deleted.`
          : "This will permanently delete the category. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      warning:
        blockers.length > 0
          ? `This category still has ${blockers.join(" and ")} — the delete will be refused.`
          : "This will permanently delete the category.",
    });
    if (ok) deleteMutation.mutate(category);
  };

  const openCreate = (parentId: string | null) => {
    setCreateParentId(parentId);
    setCreateOpen(true);
  };

  return (
    <section aria-labelledby="expense-categories-heading">
      <PageHeader
        breadcrumb={[{ label: "Finance" }, { label: "Expenses", href: "/expenses" }, { label: "Categories" }]}
        title="Expense Categories"
        help="Categories group expenses for the Profit & Loss report. Nest a category under a parent to organise the tree — a category with expenses or sub-categories cannot be deleted until they move elsewhere."
        action={
          <Button variant="primary" icon={Plus} onClick={() => openCreate(null)}>
            Create category
          </Button>
        }
      />
      <div
        className="sm-stack-sm"
        style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}
      >
        <span style={{ display: "inline-block", flex: "1 1 220px", maxWidth: 320 }}>
          <Input
            type="search"
            value={q}
            onChange={(e) => setSearch({ q: e.target.value || null })}
            placeholder="Search categories…"
            aria-label="Search categories"
          />
        </span>
        <Select
          id="expense-categories-status-filter"
          name="is_active"
          value={isActive === undefined ? "" : String(isActive)}
          onChange={(e) =>
            setSearch({
              isActive: e.target.value === "" ? null : e.target.value === "true",
            })
          }
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </Select>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void queryClient.invalidateQueries({ queryKey: listKey("expense-categories") })
          }
        >
          Refresh
        </Button>
        {filtering ? (
          <Button variant="ghost" size="sm" onClick={() => setSearch({ q: null, isActive: null })}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <TableSkeleton rows={5} />
      ) : isError ? (
        <ErrorState
          message={error instanceof Error ? error.message : "Could not load categories."}
          onRetry={() =>
            void queryClient.invalidateQueries({ queryKey: listKey("expense-categories") })
          }
        />
      ) : allRows.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No expense categories yet"
          body="Create the first category so expenses can be grouped for reporting."
          actionLabel="Create category"
          onAction={() => openCreate(null)}
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No categories match"
          body="Try a different search or clear the status filter."
          actionLabel="Clear filters"
          onAction={() => setSearch({ q: null, isActive: null })}
        />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 640 }} role="tree" aria-label="Expense categories">
            <div
              role="presentation"
              style={{
                display: "grid",
                gridTemplateColumns: ROW_GRID,
                gap: 12,
                alignItems: "center",
                height: 32,
                padding: "0 12px",
                borderBottom: "1px solid var(--sm-border)",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--sm-text)",
              }}
            >
              <span>Category</span>
              <span>Depth</span>
              <span>Expenses</span>
              <span>Sub-categories</span>
              <span>Status</span>
              <span />
            </div>
            {visibleRows.map(({ node, depth, path }) => {
              const hasChildren = node.children.length > 0;
              const collapsed = collapsedIds.has(node.id);
              const expanded = hasChildren && !collapsed;
              const Icon = expenseIconFor(node.icon);
              const parentPath = path.split(" / ").slice(0, -1).join(" / ");
              return (
                <div
                  key={node.id}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={hasChildren ? expanded : undefined}
                  style={{
                    display: "grid",
                    gridTemplateColumns: ROW_GRID,
                    gap: 12,
                    alignItems: "center",
                    minHeight: 37,
                    padding: "4px 12px",
                    borderBottom: "1px solid var(--sm-border)",
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 0,
                      paddingLeft: depth * 20,
                    }}
                    title={path}
                  >
                    {hasChildren ? (
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(node.id)}
                        aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                        aria-expanded={expanded}
                        style={{
                          width: 24,
                          height: 24,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                          padding: 0,
                          background: "transparent",
                          border: "none",
                          borderRadius: 4,
                          color: "var(--sm-text-muted)",
                          cursor: "pointer",
                        }}
                      >
                        {expanded ? (
                          <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
                        ) : (
                          <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      <span aria-hidden="true" style={{ width: 24, flexShrink: 0 }} />
                    )}
                    <ColorDot color={node.color} />
                    <Icon size={16} strokeWidth={2} aria-hidden="true" />
                    <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {node.name}
                    </strong>
                    {filtering && parentPath ? (
                      <span
                        style={{
                          color: "var(--sm-text-muted)",
                          fontSize: 12,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        in {parentPath}
                      </span>
                    ) : null}
                  </span>
                  <span className="sm-tabular">{depth}</span>
                  <span className="sm-tabular">{node.expenseCount}</span>
                  <span className="sm-tabular">{node.childCount}</span>
                  <span>
                    <StatusBadge status={node.isActive ? "active" : "inactive"} />
                  </span>
                  <span style={{ display: "inline-flex", justifyContent: "flex-end" }}>
                    <RowMenu
                      items={[
                        {
                          icon: Pencil,
                          label: "Edit",
                          onSelect: () => setEditing(node),
                        },
                        {
                          icon: Plus,
                          label: "Add sub-category",
                          onSelect: () => openCreate(node.id),
                        },
                        {
                          label: node.isActive ? "Deactivate" : "Activate",
                          onSelect: () => onToggle(node),
                        },
                        {
                          icon: Trash2,
                          label: "Delete",
                          danger: true,
                          onSelect: () => void onDelete(node),
                        },
                      ]}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {createOpen ? (
        <Dialog open size="md" onClose={() => { setCreateOpen(false); setCreateParentId(null); }} title="Create category">
          <CategoryForm
            tree={tree}
            initialParentId={createParentId}
            onSaved={expandParentOf}
            onDone={() => { setCreateOpen(false); setCreateParentId(null); }}
            onCancel={() => { setCreateOpen(false); setCreateParentId(null); }}
          />
        </Dialog>
      ) : null}
      {editing ? (
        <Dialog open size="md" onClose={() => setEditing(null)} title={`Edit ${editing.name}`}>
          <CategoryForm
            tree={tree}
            initial={editing}
            onSaved={expandParentOf}
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
  tree,
  initialParentId,
  onSaved,
  onDone,
  onCancel,
}: {
  initial?: ExpenseCategory | undefined;
  tree?: ExpenseCategoryTreeNode[] | undefined;
  /** Pre-selected parent when creating from a row's "Add sub-category". */
  initialParentId?: string | null | undefined;
  onSaved?: (saved: ExpenseCategory) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState(initial?.color ?? "#00E599");
  const [icon, setIcon] = useState(initial?.icon ?? "tag");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  // "" = top-level; anything else is the parent category id.
  const [parentId, setParentId] = useState(initial?.parentId ?? initialParentId ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Parent picker options: the whole tree, indented by depth. When
  // editing, the category itself and its descendants are excluded —
  // picking one of them would create a cycle (the backend refuses it
  // too, but the UI never offers it in the first place).
  const parentOptions = useMemo(() => {
    const excluded = new Set<string>();
    if (initial) {
      excluded.add(initial.id);
      const self = findTreeNode(tree ?? [], initial.id);
      if (self) {
        for (const { node } of flattenExpenseCategoryTree(self.children)) {
          excluded.add(node.id);
        }
      }
    }
    // The backend requires the parent to exist and be ACTIVE — so
    // inactive categories are not offered, except the category's own
    // current parent while editing (it must stay selectable, or the
    // saved value would vanish from the picker).
    return flattenExpenseCategoryTree(tree ?? [])
      .filter(
        ({ node }) =>
          !excluded.has(node.id) &&
          (node.isActive || (initial?.parentId !== null && node.id === initial?.parentId)),
      )
      .map(({ node, depth }) => ({
        value: node.id,
        label: indentedCategoryName(depth, node.name),
      }));
  }, [initial, tree]);

  const mutation = useAdminMutation<ExpenseCategory, ExpenseCategoryInput>({
    mutationFn: (body) =>
      initial ? updateExpenseCategory(initial.id, body) : createExpenseCategory(body),
    invalidateKeys: [listKey("expense-categories")],
    successTitle: initial ? "Category updated" : "Category created",
    // Success toast carries the category name as its message.
    successMessage: name.trim(),
    onSuccess: (saved) => {
      onSaved?.(saved);
      onDone();
    },
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
      {
        name: name.trim(),
        description: description.trim() || null,
        color: color.trim(),
        icon,
        isActive,
        parentId: parentId === "" ? null : parentId,
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
        <Field
          label="Parent category"
          htmlFor="expense-category-parent"
          hint="Top-level categories sit at the root; a sub-category nests under its parent."
        >
          <SearchableSelect
            id="expense-category-parent"
            value={parentId}
            onChange={(v) => setParentId(v)}
            options={parentOptions}
            leadingOptions={[{ value: "", label: "Top-level" }]}
            placeholder="Search a parent category…"
            ariaLabel="Parent category"
          />
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
      <div className="sm-dialog-footer sm-dialog-footer-flush">
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
