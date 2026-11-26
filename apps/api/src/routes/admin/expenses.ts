/**
 * Admin expense routes (Hono) — Hono migration Phase 1.
 *
 * Converted verbatim from the hand-rolled dispatcher in
 * apps/api/src/app.ts (baseline feat e382d65, lines ~7300–7470):
 * expense categories (+ detail) and expenses (+ detail). Service
 * layer, validators and envelopes are unchanged — only the HTTP
 * plumbing moved. Auth / CSRF / rate-limit middleware (Worker 3,
 * hono/*) provides c.var.requestId / env / store / principal; the
 * per-route permission checks below are preserved from app.ts.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
} from "../../../../../packages/contracts/src/index.ts";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import {
  createExpense,
  createExpenseCategory,
  deleteExpense,
  deleteExpenseCategory,
  getExpense,
  getExpenseCategory,
  listExpenseCategories,
  listExpenseCategoryTree,
  listExpenses,
  updateExpense,
  updateExpenseCategory,
} from "../../modules/expenses/service.ts";
import { parseOverviewRange } from "../../modules/analytics/overview-range.ts";

// --- HTTP plumbing copied from app.ts handleRequest (closures there) ---

function requirePrincipal(c: Context<AppEnv>): StaffPrincipal {
  const principal = c.var.principal;
  if (!principal) {
    throw new AppError(
      "UNAUTHORIZED",
      "Valid staff authentication session required.",
      401
    );
  }
  return principal;
}

function ok<T>(c: Context<AppEnv>, data: T, status = 200): Response {
  return c.json(createSuccessEnvelope(data, c.var.requestId), status as ContentfulStatusCode);
}

function parseListQuery(query: Record<string, string | undefined>): {
  q: string;
  limit: number;
  page: number;
} {
  const q = query.q?.trim().toLowerCase() ?? "";
  const rawLimit = Number(query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), 100)
      : 25;
  const rawPage = Number(query.page);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  return { q, limit, page };
}

function applyListPage<T>(items: T[], limit: number, page: number): T[] {
  return items.slice((page - 1) * limit, page * limit);
}

function pagedCollection<T>(
  c: Context<AppEnv>,
  filtered: T[],
  limit: number,
  page = 1,
  nextCursor: string | null = null,
  status = 200
): Response {
  return c.json(
    createCollectionEnvelope(
      applyListPage(filtered, limit, page),
      nextCursor,
      c.var.requestId,
      filtered.length
    ),
    status as ContentfulStatusCode
  );
}

const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;

async function readJsonBody(c: Context<AppEnv>): Promise<any> {
  const body = c.req.raw.body;
  if (!body) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is required and must be valid JSON.",
      400
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        "Request payload exceeds limit.",
        413
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  if (text.trim() === "") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is required and must be valid JSON.",
      400
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request body is not valid JSON.",
      400
    );
  }
}

// Expense module — `?pageSize=` is accepted as an alias for the
// standard `?limit=` (M-1: 1..100, default 25); `?page=` as usual.
function parseExpenseListQuery(query: Record<string, string | undefined>): {
  q: string;
  limit: number;
  page: number;
} {
  const { q, limit, page } = parseListQuery(query);
  const rawPageSize = Number(query.pageSize);
  const effectiveLimit =
    Number.isFinite(rawPageSize) && rawPageSize >= 1
      ? Math.min(Math.floor(rawPageSize), 100)
      : limit;
  return { q, limit: effectiveLimit, page };
}

export function registerAdminExpensesRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/expense-categories", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
    const query = c.req.query();
    const { q, limit, page } = parseExpenseListQuery(query);
    const isActiveRaw = query.is_active;
    const isActive =
      isActiveRaw === "true" ? true : isActiveRaw === "false" ? false : null;
    const items = await listExpenseCategories(store, principal, {
      q,
      isActive,
    });
    return pagedCollection(c, items, limit, page);
  });

  app.post("/api/v1/admin/expense-categories", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(
      store,
      principal,
      "expense_categories.manage",
      requestId,
    );
    const body = await readJsonBody(c);
    const created = await createExpenseCategory(store, principal, body, requestId);
    return ok(c, created, 201);
  });

  // Nested category tree (hierarchy, migration 0026). Registered
  // BEFORE /:categoryId so "tree" is never captured as a category id.
  // Success envelope (not a paginated collection — a tree cannot be
  // page-sliced); RBAC expenses.read, same as the flat list.
  app.get("/api/v1/admin/expense-categories/tree", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
    const query = c.req.query();
    const isActiveRaw = query.is_active;
    const isActive =
      isActiveRaw === "true" ? true : isActiveRaw === "false" ? false : null;
    const tree = await listExpenseCategoryTree(store, principal, {
      q: query.q?.trim().toLowerCase() ?? "",
      isActive,
    });
    return ok(c, tree);
  });

  app.get("/api/v1/admin/expense-categories/:categoryId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
    const category = await getExpenseCategory(
      store,
      principal,
      c.req.param("categoryId"),
    );
    return ok(c, category);
  });

  app.patch("/api/v1/admin/expense-categories/:categoryId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(
      store,
      principal,
      "expense_categories.manage",
      requestId,
    );
    const body = await readJsonBody(c);
    const updated = await updateExpenseCategory(
      store,
      principal,
      c.req.param("categoryId"),
      body,
      requestId,
    );
    return ok(c, updated);
  });

  app.delete("/api/v1/admin/expense-categories/:categoryId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(
      store,
      principal,
      "expense_categories.manage",
      requestId,
    );
    const deleted = await deleteExpenseCategory(
      store,
      principal,
      c.req.param("categoryId"),
      requestId,
    );
    return ok(c, deleted);
  });

  app.get("/api/v1/admin/expenses", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
    const query = c.req.query();
    const { q, limit, page } = parseExpenseListQuery(query);
    const range = parseOverviewRange(new URL(c.req.url).searchParams);
    const items = await listExpenses(store, principal, {
      q,
      categoryId: query.categoryId ?? null,
      productId: query.productId ?? null,
      from: range?.from ?? null,
      to: range?.to ?? null,
    });
    return pagedCollection(c, items, limit, page);
  });

  app.post("/api/v1/admin/expenses", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(
      store,
      principal,
      "expenses.manage",
      requestId,
    );
    const body = await readJsonBody(c);
    const created = await createExpense(store, principal, body, requestId);
    return ok(c, created, 201);
  });

  app.get("/api/v1/admin/expenses/:expenseId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "expenses.read", requestId);
    const expense = await getExpense(
      store,
      principal,
      c.req.param("expenseId"),
    );
    return ok(c, expense);
  });

  app.patch("/api/v1/admin/expenses/:expenseId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(
      store,
      principal,
      "expenses.manage",
      requestId,
    );
    const body = await readJsonBody(c);
    const updated = await updateExpense(
      store,
      principal,
      c.req.param("expenseId"),
      body,
      requestId,
    );
    return ok(c, updated);
  });

  app.delete("/api/v1/admin/expenses/:expenseId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(
      store,
      principal,
      "expenses.manage",
      requestId,
    );
    const deleted = await deleteExpense(
      store,
      principal,
      c.req.param("expenseId"),
      requestId,
    );
    return ok(c, deleted);
  });
}
