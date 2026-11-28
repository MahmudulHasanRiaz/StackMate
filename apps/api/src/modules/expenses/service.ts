/**
 * Expense module — categories + expenses (CRUD service).
 *
 * Record shapes mirror db/schema/expenses.ts (migration 0018) exactly:
 * snake_case columns, `currency` fixed to 'BDT', `expense_date` a
 * YYYY-MM-DD date, `recorded_by` the staff user id (uuid string, no FK
 * — same as the schema). Amounts are integer minor units, > 0.
 *
 * Store wiring: `expense_categories` / `expenses` are first-class
 * collections in apps/api/src/platform/db/store.ts (DatabaseState) with
 * a load query + SyncSpec in drizzle-store.ts (payment_refunds
 * precedent) — every withTransaction persists them to Postgres, and
 * the P&L analytics reads the same state. The service no longer
 * lazily initialises them; expenseCollections is a thin typed accessor.
 *
 * RBAC (assertStaffPermission, same as payments): reads need
 * `expenses.read`; expense writes need `expenses.manage`; category
 * writes need `expense_categories.manage`. The keys live in the seed
 * catalogue (db/seeds/seed-reference.ts) and migration 0019 grants
 * them (finance_manager: all three; support_staff + read_only:
 * expenses.read). super_admin bypasses the permission list, so the
 * module worked for super_admin/admin before the seed landed.
 *
 * Delete pattern: payment methods have NO delete endpoint at all
 * (enable/disable only), so there is no hard-delete precedent to copy.
 * Categories hard-delete with a 409 guard when expenses reference
 * them — the DB-level RESTRICT (migration 0018) made explicit at the
 * API layer. Expenses hard-delete (no dependents).
 */
import { randomUUID } from "node:crypto";
import {
  CreateExpenseCategorySchema,
  CreateExpenseSchema,
  EXPENSE_PERMISSIONS,
  UpdateExpenseCategorySchema,
  UpdateExpenseSchema,
} from "../../../../../packages/contracts/src/index.ts";
import type {
  DatabaseState,
  ExpenseCategoryRecord,
  ExpenseRecord,
  StackMateDataStore,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

// Re-exported so callers keep importing the record shapes from here.
export type { ExpenseCategoryRecord, ExpenseRecord };

export interface ExpenseCategoryDto extends ExpenseCategoryRecord {
  /** Number of expenses referencing this category (0 → deletable). */
  expenseCount: number;
  /** Number of direct sub-categories (0 → no children to block delete). */
  childCount: number;
}

/** One node of the nested category tree (see buildCategoryTree). */
export interface ExpenseCategoryTreeNode extends ExpenseCategoryDto {
  /** 0 = top-level; a child's depth is its parent's depth + 1. */
  depth: number;
  /** Breadcrumb, e.g. "Office / Stationery". */
  path: string;
  children: ExpenseCategoryTreeNode[];
}

function expenseCollections(state: DatabaseState): {
  categories: ExpenseCategoryRecord[];
  expenses: ExpenseRecord[];
} {
  return {
    categories: state.expense_categories,
    expenses: state.expenses,
  };
}

export function toExpenseCategoryDto(
  category: ExpenseCategoryRecord,
  expenseCount: number,
  childCount = 0,
): ExpenseCategoryDto {
  return { ...category, expenseCount, childCount };
}

function countExpensesForCategory(
  state: DatabaseState,
  categoryId: string,
): number {
  return expenseCollections(state).expenses.filter((e) => e.category_id === categoryId)
    .length;
}

function countChildrenForCategory(
  state: DatabaseState,
  categoryId: string,
): number {
  return expenseCollections(state).categories.filter(
    (c) => c.parent_id === categoryId,
  ).length;
}

function toDto(
  state: DatabaseState,
  category: ExpenseCategoryRecord,
): ExpenseCategoryDto {
  return toExpenseCategoryDto(
    category,
    countExpensesForCategory(state, category.id),
    countChildrenForCategory(state, category.id),
  );
}

/**
 * Parent validation (hierarchy, migration 0026) — create + update.
 * parent_id given → the parent must exist, must be active, must not
 * be the category itself, and must not be one of its descendants
 * (cycle). All four failures are 400 VALIDATION_ERROR: a bad parent
 * is a bad request body, not a missing resource — the 404 NOT_FOUND
 * pattern (unknown FK on expense create) does NOT apply here, the
 * caller named a parent that cannot be used as a parent.
 *
 * Cycle check: walk UP from the proposed parent following parent_id
 * links — if the chain reaches `selfId`, the proposed parent is a
 * descendant of the category, so accepting it would close a loop.
 * The `seen` set also stops a walk over already-corrupt data (a
 * cycle stored before this guard existed) instead of looping forever.
 */
function assertValidParent(
  state: DatabaseState,
  parentId: string,
  selfId?: string,
): void {
  const parent = expenseCollections(state).categories.find(
    (c) => c.id === parentId,
  );
  if (!parent) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Parent expense category not found.",
      400,
    );
  }
  if (!parent.is_active) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Parent expense category must be active.",
      400,
    );
  }
  if (selfId !== undefined && parentId === selfId) {
    throw new AppError(
      "VALIDATION_ERROR",
      "An expense category cannot be its own parent.",
      400,
    );
  }
  if (selfId !== undefined) {
    const seen = new Set<string>([parentId]);
    let current: ExpenseCategoryRecord | undefined = parent;
    while (current?.parent_id) {
      if (current.parent_id === selfId) {
        throw new AppError(
          "VALIDATION_ERROR",
          "An expense category cannot use one of its own sub-categories as its parent (cycle).",
          400,
        );
      }
      if (seen.has(current.parent_id)) break;
      seen.add(current.parent_id);
      current = expenseCollections(state).categories.find(
        (c) => c.id === current!.parent_id,
      );
    }
  }
}

/**
 * Build the nested tree from a flat category list: every node gets
 * `children` (newest-first, same order as listExpenseCategories),
 * `depth` and a `path` breadcrumb. Orphans (parent_id pointing at a
 * category absent from the list — e.g. filtered out) become roots so
 * no category ever disappears from the tree.
 */
export function buildCategoryTree(
  categories: ExpenseCategoryDto[],
): ExpenseCategoryTreeNode[] {
  const byId = new Map<string, ExpenseCategoryTreeNode>();
  for (const c of categories) {
    byId.set(c.id, { ...c, depth: 0, path: c.name, children: [] });
  }
  const roots: ExpenseCategoryTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Depth + path need a top-down walk: the flat list is newest-first,
  // so a child can precede its parent in `categories` — assigning
  // depth while linking would read a parent's depth before it was set.
  const assign = (node: ExpenseCategoryTreeNode, depth: number, path: string): void => {
    node.depth = depth;
    node.path = path;
    for (const child of node.children) {
      assign(child, depth + 1, `${path} / ${child.name}`);
    }
  };
  for (const root of roots) assign(root, 0, root.name);
  return roots;
}

function assertCategoryNameAvailable(
  state: DatabaseState,
  name: string,
  excludeId?: string,
): void {
  const needle = name.trim().toLowerCase();
  const clash = expenseCollections(state).categories.find(
    (c) => c.id !== excludeId && c.name.trim().toLowerCase() === needle,
  );
  if (clash) {
    throw new AppError(
      "CONFLICT",
      `An expense category named '${name.trim()}' already exists.`,
      409,
    );
  }
}

function requireCategory(
  state: DatabaseState,
  categoryId: string,
): ExpenseCategoryRecord {
  const category = expenseCollections(state).categories.find(
    (c) => c.id === categoryId,
  );
  if (!category) {
    throw new AppError("NOT_FOUND", "Expense category not found.", 404);
  }
  return category;
}

function requireExpense(
  state: DatabaseState,
  expenseId: string,
): ExpenseRecord {
  const expense = expenseCollections(state).expenses.find(
    (e) => e.id === expenseId,
  );
  if (!expense) {
    throw new AppError("NOT_FOUND", "Expense not found.", 404);
  }
  return expense;
}

/** Unknown-FK guard: the referenced row must exist (404, payments pattern). */
function requireOptionalRef(
  state: DatabaseState,
  collection: "products" | "payment_methods" | "media_assets",
  id: string | null | undefined,
  label: string,
): void {
  if (!id) return;
  const found = (state[collection] as Array<{ id: string }>).some(
    (row) => row.id === id,
  );
  if (!found) {
    throw new AppError("NOT_FOUND", `${label} not found.`, 404);
  }
}

// -- Categories ---------------------------------------------------------------

export interface ListExpenseCategoriesOptions {
  /** Server-side search over the category name (case-insensitive substring). */
  q?: string;
  /** Exact is_active filter; null/undefined = all. */
  isActive?: boolean | null;
}

/** Filtered + newest-first; the route slices the page (M-1 pattern). */
export async function listExpenseCategories(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  options: ListExpenseCategoriesOptions = {},
): Promise<ExpenseCategoryDto[]> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.read);
  const q = (options.q ?? "").trim().toLowerCase();
  const { categories } = expenseCollections(store.state);
  return categories
    .filter((c) => (q === "" ? true : c.name.toLowerCase().includes(q)))
    .filter((c) =>
      options.isActive === null || options.isActive === undefined
        ? true
        : c.is_active === options.isActive,
    )
    .sort((a, b) =>
      a.created_at === b.created_at
        ? a.id.localeCompare(b.id)
        : a.created_at < b.created_at
          ? 1
          : -1,
    )
    .map((c) => toDto(store.state, c));
}

/**
 * Nested category tree (GET .../expense-categories/tree): same
 * filters as listExpenseCategories, returned as roots with nested
 * `children` (depth + path on every node). No pagination — a tree
 * cannot be meaningfully page-sliced; the category count is small
 * and admin-managed.
 */
export async function listExpenseCategoryTree(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  options: ListExpenseCategoriesOptions = {},
): Promise<ExpenseCategoryTreeNode[]> {
  const flat = await listExpenseCategories(store, actor, options);
  return buildCategoryTree(flat);
}

export async function getExpenseCategory(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  categoryId: string,
): Promise<ExpenseCategoryDto> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.read);
  const category = requireCategory(store.state, categoryId);
  return toDto(store.state, category);
}

export async function createExpenseCategory(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string,
): Promise<ExpenseCategoryRecord> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.categoriesManage);
  const input = CreateExpenseCategorySchema.parse(rawInput);
  return store.withTransaction((state) => {
    assertCategoryNameAvailable(state, input.name);
    if (input.parent_id !== undefined && input.parent_id !== null) {
      assertValidParent(state, input.parent_id);
    }
    const nowIso = new Date().toISOString();
    const category: ExpenseCategoryRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description ?? null,
      color: input.color ?? "#00E599",
      icon: input.icon ?? null,
      parent_id: input.parent_id ?? null,
      is_active: input.is_active ?? true,
      created_at: nowIso,
      updated_at: nowIso,
    };
    expenseCollections(state).categories.push(category);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "expenses.category.created",
      resource_type: "expense_category",
      resource_id: category.id,
      outcome: "success",
      request_id: requestId,
      changes: { name: category.name },
    });
    return category;
  });
}

export async function updateExpenseCategory(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  categoryId: string,
  rawInput: unknown,
  requestId: string,
): Promise<ExpenseCategoryRecord> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.categoriesManage);
  const input = UpdateExpenseCategorySchema.parse(rawInput);
  return store.withTransaction((state) => {
    const category = requireCategory(state, categoryId);
    if (input.name !== undefined) {
      assertCategoryNameAvailable(state, input.name, category.id);
      category.name = input.name.trim();
    }
    if (input.description !== undefined) category.description = input.description;
    if (input.color !== undefined) category.color = input.color;
    if (input.icon !== undefined) category.icon = input.icon;
    if (input.parent_id !== undefined) {
      // null detaches (back to top-level); a value is validated
      // against this category itself (self-parent + cycle).
      if (input.parent_id !== null) {
        assertValidParent(state, input.parent_id, category.id);
      }
      category.parent_id = input.parent_id;
    }
    if (input.is_active !== undefined) category.is_active = input.is_active;
    category.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "expenses.category.updated",
      resource_type: "expense_category",
      resource_id: category.id,
      outcome: "success",
      request_id: requestId,
      changes: { name: category.name },
    });
    return category;
  });
}

export async function deleteExpenseCategory(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  categoryId: string,
  requestId: string,
): Promise<{ deleted: true; id: string }> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.categoriesManage);
  return store.withTransaction((state) => {
    const category = requireCategory(state, categoryId);
    const inUse = countExpensesForCategory(state, category.id);
    if (inUse > 0) {
      throw new AppError(
        "CONFLICT",
        `Expense category '${category.name}' cannot be deleted: ${inUse} expense(s) still reference it.`,
        409,
      );
    }
    const childCount = countChildrenForCategory(state, category.id);
    if (childCount > 0) {
      throw new AppError(
        "CONFLICT",
        `Expense category '${category.name}' cannot be deleted: ${childCount} sub-categor(ies) still reference it.`,
        409,
      );
    }
    const { categories } = expenseCollections(state);
    const idx = categories.findIndex((c) => c.id === category.id);
    categories.splice(idx, 1);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "expenses.category.deleted",
      resource_type: "expense_category",
      resource_id: category.id,
      outcome: "success",
      request_id: requestId,
      changes: { name: category.name },
    });
    return { deleted: true as const, id: category.id };
  });
}

// -- Expenses -----------------------------------------------------------------

export interface ListExpensesOptions {
  /** Server-side search over vendor + notes (case-insensitive substring). */
  q?: string;
  categoryId?: string | null;
  productId?: string | null;
  /** Inclusive YYYY-MM-DD bounds on expense_date (parseOverviewRange semantics). */
  from?: string | null;
  to?: string | null;
}

/** Filtered + newest-first by expense_date, then created_at; route paginates. */
export async function listExpenses(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  options: ListExpensesOptions = {},
): Promise<ExpenseRecord[]> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.read);
  const q = (options.q ?? "").trim().toLowerCase();
  return expenseCollections(store.state)
    .expenses.filter((e) =>
      q === ""
        ? true
        : (e.vendor ?? "").toLowerCase().includes(q) ||
          (e.notes ?? "").toLowerCase().includes(q),
    )
    .filter((e) => (!options.categoryId ? true : e.category_id === options.categoryId))
    .filter((e) => (!options.productId ? true : e.product_id === options.productId))
    .filter((e) => (!options.from ? true : e.expense_date >= options.from))
    .filter((e) => (!options.to ? true : e.expense_date <= options.to))
    .sort((a, b) =>
      a.expense_date === b.expense_date
        ? a.created_at === b.created_at
          ? a.id.localeCompare(b.id)
          : a.created_at < b.created_at
            ? 1
            : -1
        : a.expense_date < b.expense_date
          ? 1
          : -1,
    );
}

export async function getExpense(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  expenseId: string,
): Promise<ExpenseRecord> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.read);
  return requireExpense(store.state, expenseId);
}

export async function createExpense(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string,
): Promise<ExpenseRecord> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.manage);
  const input = CreateExpenseSchema.parse(rawInput);
  return store.withTransaction((state) => {
    requireCategory(state, input.categoryId);
    requireOptionalRef(state, "products", input.productId ?? null, "Product");
    requireOptionalRef(
      state,
      "payment_methods",
      input.paymentMethodId ?? null,
      "Payment method",
    );
    requireOptionalRef(
      state,
      "media_assets",
      input.receiptMediaId ?? null,
      "Receipt media asset",
    );
    const nowIso = new Date().toISOString();
    const expense: ExpenseRecord = {
      id: randomUUID(),
      amount_minor: input.amountMinor,
      currency: "BDT",
      expense_date: input.expenseDate,
      category_id: input.categoryId,
      product_id: input.productId ?? null,
      payment_method_id: input.paymentMethodId ?? null,
      vendor: input.vendor ?? null,
      notes: input.notes ?? null,
      receipt_media_id: input.receiptMediaId ?? null,
      recorded_by: actor.user.id,
      created_at: nowIso,
      updated_at: nowIso,
    };
    expenseCollections(state).expenses.push(expense);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "expenses.expense.created",
      resource_type: "expense",
      resource_id: expense.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        amount_minor: expense.amount_minor,
        expense_date: expense.expense_date,
        category_id: expense.category_id,
      },
    });
    return expense;
  });
}

export async function updateExpense(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  expenseId: string,
  rawInput: unknown,
  requestId: string,
): Promise<ExpenseRecord> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.manage);
  const input = UpdateExpenseSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const expense = requireExpense(state, expenseId);
    if (input.categoryId !== undefined) {
      requireCategory(state, input.categoryId);
      expense.category_id = input.categoryId;
    }
    requireOptionalRef(state, "products", input.productId ?? null, "Product");
    requireOptionalRef(
      state,
      "payment_methods",
      input.paymentMethodId ?? null,
      "Payment method",
    );
    requireOptionalRef(
      state,
      "media_assets",
      input.receiptMediaId ?? null,
      "Receipt media asset",
    );
    if (input.amountMinor !== undefined) expense.amount_minor = input.amountMinor;
    if (input.expenseDate !== undefined) expense.expense_date = input.expenseDate;
    if (input.productId !== undefined) expense.product_id = input.productId;
    if (input.paymentMethodId !== undefined) {
      expense.payment_method_id = input.paymentMethodId;
    }
    if (input.vendor !== undefined) expense.vendor = input.vendor;
    if (input.notes !== undefined) expense.notes = input.notes;
    if (input.receiptMediaId !== undefined) {
      expense.receipt_media_id = input.receiptMediaId;
    }
    expense.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "expenses.expense.updated",
      resource_type: "expense",
      resource_id: expense.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        amount_minor: expense.amount_minor,
        expense_date: expense.expense_date,
        category_id: expense.category_id,
      },
    });
    return expense;
  });
}

export async function deleteExpense(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  expenseId: string,
  requestId: string,
): Promise<{ deleted: true; id: string }> {
  assertStaffPermission(actor, EXPENSE_PERMISSIONS.manage);
  return store.withTransaction((state) => {
    const expense = requireExpense(state, expenseId);
    const { expenses } = expenseCollections(state);
    const idx = expenses.findIndex((e) => e.id === expense.id);
    expenses.splice(idx, 1);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "expenses.expense.deleted",
      resource_type: "expense",
      resource_id: expense.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        amount_minor: expense.amount_minor,
        expense_date: expense.expense_date,
        category_id: expense.category_id,
      },
    });
    return { deleted: true as const, id: expense.id };
  });
}
