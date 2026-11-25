/**
 * Typed Admin SPA API Client.
 * Uses credentials: 'include' for Better Auth HttpOnly session cookies and parses
 * standard StackMate snake_case success/error envelopes. Never stores secrets in localStorage.
 */
import {
  formatDisplayDateDDMMYYYY,
  formatDisplayDateTimeDDMMYYYY,
  formatMinorMoney,
} from "../../../../packages/contracts/src/index.ts";

export { formatDisplayDateDDMMYYYY, formatDisplayDateTimeDDMMYYYY, formatMinorMoney };

export class ApiClientError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown> | null;

  constructor(
    code: string,
    message: string,
    requestId: string,
    statusCode: number,
    details: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.requestId = requestId;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Global 401 handler (live bug 2026-11-22): when a signed-in tab's
 * session dies mid-session (12h expiry, suspension), every section
 * query 401s and each section shows "Something went wrong" instead
 * of the sign-in screen — the user only discovers they are signed
 * out after a reload. A registered handler is called for 401s from
 * /api/v1/admin/* while a principal is held (RootComponent registers
 * it only then), so the app drops to the sign-in screen at once.
 * Auth endpoints are excluded by the path check: a wrong-password
 * 401 from sign-in must never clear a principal.
 */
type UnauthorizedHandler = (error: ApiClientError) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;
export function onApiUnauthorized(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(error: ApiClientError, path: string): void {
  if (
    error.statusCode === 401 &&
    path.startsWith("/api/v1/admin/") &&
    unauthorizedHandler
  ) {
    unauthorizedHandler(error);
  }
}

/**
 * Client-side request bound (SMTP timeout fix, 2026-11-16): no admin
 * request may hang forever. Live 2026-11-16 21:23 +06: "Send test
 * email" stayed on "Sending…" for 90+s while the Worker recorded no
 * invocation anywhere near 90s — the fetch never settled and the
 * button had no timeout to settle it. Every request now aborts at
 * 30s (generous: live p99 is ~2–3s) and the abort surfaces as an
 * ApiClientError with the real cause, so the caller shows the honest
 * error instead of spinning forever. No caller passes its own signal
 * (verified 2026-11-16), so the timeout signal is applied
 * unconditionally. Applied to BOTH helpers — rawApiRequest serves the
 * 2FA flows and would hang identically.
 */
const API_REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a DOMException named
    // "TimeoutError" — surface it as the real cause instead of the
    // generic "Request failed" text, so e.g. the test-email button
    // shows why it stopped.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiClientError(
        "REQUEST_TIMEOUT",
        "Request timed out — the server did not respond in time. Please retry.",
        "unknown",
        0
      );
    }
    throw err;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  // FormData bodies must NOT get a JSON content-type — the browser sets
  // multipart/form-data with its own boundary. (Media library uploads,
  // PLAN §31; previously every body was JSON, so this was unreachable.)
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  const res = await fetchWithTimeout(path, {
    ...options,
    credentials: "include",
    headers,
  });

  // D-12: a 204 No Content (or empty-200) success has no JSON body —
  // return early instead of throwing "Request failed with status 204".
  // No current admin endpoint returns 204 (the only 204 in the API is
  // the CORS preflight, which never goes through apiRequest), so this
  // is latent robustness, not a live bug.
  if (res.status === 204 || res.headers.get("Content-Length") === "0") {
    return undefined as unknown as T;
  }

  const json = (await res.json().catch(() => null)) as
    | { data?: T; error?: { code: string; message: string; details: Record<string, unknown> | null; request_id: string } }
    | null;

  if (!res.ok || !json || json.error) {
    const err = json?.error;
    const apiError = new ApiClientError(
      err?.code ?? "HTTP_ERROR",
      err?.message ?? `Request failed with status ${res.status}`,
      err?.request_id ?? "unknown",
      res.status,
      err?.details ?? null
    );
    notifyUnauthorized(apiError, path);
    throw apiError;
  }

  return json.data as T;
}

/**
 * Raw variant of apiRequest: returns the parsed JSON body as-is, without
 * unwrapping the app's `{ data }` envelope. Use it ONLY for Better Auth's
 * own endpoints (the twoFactor plugin's /two-factor/* calls), which
 * return raw plugin responses — e.g. enable returns `{ totpURI,
 * backupCodes }` with no `data` key, so the enveloped helper returns
 * `undefined` and setup breaks (caught by the headless auth-email audit,
 * 2026-11-16). Error handling is identical to apiRequest.
 */
export async function rawApiRequest<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  // Same FormData rule as apiRequest (PLAN §31) — the browser sets the
  // multipart boundary; a JSON content-type here would break the body.
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  const res = await fetchWithTimeout(path, {
    ...options,
    credentials: "include",
    headers,
  });

  // D-12 (same as apiRequest): a 204 / empty success has no JSON body.
  if (res.status === 204 || res.headers.get("Content-Length") === "0") {
    return undefined as unknown as T;
  }

  const json = (await res.json().catch(() => null)) as
    | { error?: { code: string; message: string; details: Record<string, unknown> | null; request_id: string }; code?: string; message?: string }
    | null;

  if (!res.ok || !json || json.error) {
    const err = json?.error;
    // Better Auth's own endpoints return the error FLAT ({ code,
    // message }) instead of the app envelope — surface that message
    // instead of the generic "Request failed with status …" (the live
    // 2FA 403 hid the real "Invalid origin" message behind the
    // generic text, which is why the failure looked password-related).
    const code =
      err?.code ??
      (typeof json?.code === "string" ? json.code : undefined) ??
      "HTTP_ERROR";
    const message =
      err?.message ??
      (typeof json?.message === "string" ? json.message : undefined) ??
      `Request failed with status ${res.status}`;
    const apiError = new ApiClientError(
      code,
      message,
      err?.request_id ?? "unknown",
      res.status,
      err?.details ?? null
    );
    notifyUnauthorized(apiError, path);
    throw apiError;
  }

  return json as T;
}

/* ------------------------------------------------------------------ */
/* Expense module (admin UI, 2026-11-25).                              */
/*                                                                     */
/* Contract (API worker builds the endpoints in parallel):             */
/*  - GET/POST /api/v1/admin/expense-categories[?q=&is_active=&page=   */
/*    &pageSize=], PATCH/DELETE /expense-categories/:id (409 when      */
/*    expenses exist); rows carry an expense count.                    */
/*  - GET/POST /api/v1/admin/expenses[?q=&categoryId=&productId=       */
/*    &from=&to=&page=&pageSize=], PATCH/DELETE /expenses/:id.         */
/*  - GET /api/v1/admin/analytics/profit-loss[?from=&to=&productId=].  */
/*                                                                     */
/* CASING SHIM — verified 2026-11-25 against the API worker's code
 * (packages/contracts/src/domains/expenses.ts,
 * apps/api/src/modules/expenses/service.ts,
 * apps/api/src/modules/analytics/pnl.ts, app.ts routes): the expense
 * write schemas are camelCase (amountMinor, expenseDate, categoryId),
 * categories use snake_case is_active, category rows carry a camelCase
 * expenseCount, expense rows are snake_case records with NO embedded
 * names (the UI resolves names via the category/product lists), and
 * the P&L result is camelCase throughout. List params accept both
 * `pageSize` and `limit`; from/to are both-or-neither (400 otherwise).
 * The normalizers below accept either casing on read and the writes
 * send both casings where they differ — the API's validator strips
 * unknown keys, so the extra keys are harmless. Once the module is
 * live-verified, the losing casing can be deleted here — the sections
 * only ever see the camelCase types below. */

export interface ExpenseCategory {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  isActive: boolean;
  expenseCount: number;
  createdAt: string | null;
}

export interface Expense {
  id: string;
  amountMinor: number;
  expenseDate: string;
  categoryId: string;
  categoryName: string | null;
  categoryColor: string | null;
  productId: string | null;
  productName: string | null;
  paymentMethodId: string | null;
  vendor: string | null;
  notes: string | null;
  receiptMediaId: string | null;
  receiptUrl: string | null;
  createdAt: string | null;
}

export interface ProfitLossByCategory {
  categoryId: string;
  categoryName: string;
  color: string | null;
  totalMinor: number;
  count: number;
}

export interface ProfitLossByProduct {
  productId: string;
  productName: string;
  salesMinor: number;
  expensesMinor: number;
  netMinor: number;
  orderCount: number;
  expenseCount: number;
}

export interface ProfitLossTrendPoint {
  date: string;
  salesMinor: number;
  expensesMinor: number;
  netMinor: number;
}

export interface ProfitLossReport {
  from: string | null;
  to: string | null;
  productId: string | null;
  sales: { totalMinor: number; orderCount: number };
  expenses: { totalMinor: number; count: number };
  netMinor: number;
  byCategory: ProfitLossByCategory[];
  byProduct: ProfitLossByProduct[];
  trend: ProfitLossTrendPoint[];
}

export interface ExpenseCategoryInput {
  name: string;
  description?: string | null | undefined;
  color?: string | null | undefined;
  icon?: string | null | undefined;
  isActive?: boolean | undefined;
}

export interface ExpenseInput {
  amountMinor: number;
  expenseDate: string;
  categoryId: string;
  productId?: string | null | undefined;
  paymentMethodId?: string | null | undefined;
  vendor?: string | null | undefined;
  notes?: string | null | undefined;
  receiptMediaId?: string | null | undefined;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

/** First defined value under the camelCase key, else the snake_case key. */
function pick(record: UnknownRecord, camel: string, snake: string): unknown {
  const camelValue = record[camel];
  if (camelValue !== undefined && camelValue !== null) return camelValue;
  return record[snake];
}

function pickString(record: UnknownRecord, camel: string, snake: string): string | null {
  const value = pick(record, camel, snake);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pickNumber(record: UnknownRecord, camel: string, snake: string): number {
  const value = pick(record, camel, snake);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pickBoolean(record: UnknownRecord, camel: string, snake: string, fallback: boolean): boolean {
  const value = pick(record, camel, snake);
  return typeof value === "boolean" ? value : fallback;
}

function normalizeExpenseCategory(raw: unknown): ExpenseCategory {
  const r = asRecord(raw);
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    description: pickString(r, "description", "description"),
    color: pickString(r, "color", "color"),
    icon: pickString(r, "icon", "icon"),
    isActive: pickBoolean(r, "isActive", "is_active", true),
    expenseCount: pickNumber(r, "expenseCount", "expense_count"),
    createdAt: pickString(r, "createdAt", "created_at"),
  };
}

function normalizeExpense(raw: unknown): Expense {
  const r = asRecord(raw);
  const category = asRecord(r.category);
  const product = asRecord(r.product);
  return {
    id: String(r.id ?? ""),
    amountMinor: pickNumber(r, "amountMinor", "amount_minor"),
    expenseDate: pickString(r, "expenseDate", "expense_date") ?? "",
    categoryId: pickString(r, "categoryId", "category_id") ?? "",
    categoryName:
      pickString(r, "categoryName", "category_name") ??
      (typeof category.name === "string" ? category.name : null),
    categoryColor:
      pickString(r, "categoryColor", "category_color") ??
      (typeof category.color === "string" ? category.color : null),
    productId: pickString(r, "productId", "product_id"),
    productName:
      pickString(r, "productName", "product_name") ??
      (typeof product.name === "string" ? product.name : null),
    paymentMethodId: pickString(r, "paymentMethodId", "payment_method_id"),
    vendor: pickString(r, "vendor", "vendor"),
    notes: pickString(r, "notes", "notes"),
    receiptMediaId: pickString(r, "receiptMediaId", "receipt_media_id"),
    receiptUrl: pickString(r, "receiptUrl", "receipt_url"),
    createdAt: pickString(r, "createdAt", "created_at"),
  };
}

function normalizeProfitLoss(raw: unknown): ProfitLossReport {
  const r = asRecord(raw);
  const range = asRecord(r.range);
  const sales = asRecord(r.sales);
  const expenses = asRecord(r.expenses);
  const byCategory = Array.isArray(r.byCategory)
    ? r.byCategory
    : Array.isArray(r.by_category)
      ? r.by_category
      : [];
  const byProduct = Array.isArray(r.byProduct)
    ? r.byProduct
    : Array.isArray(r.by_product)
      ? r.by_product
      : [];
  const trend = Array.isArray(r.trend) ? r.trend : [];
  return {
    from: pickString(range, "from", "from") ?? pickString(r, "from", "from"),
    to: pickString(range, "to", "to") ?? pickString(r, "to", "to"),
    productId: pickString(r, "productId", "product_id"),
    sales: {
      totalMinor: pickNumber(sales, "totalMinor", "total_minor"),
      orderCount: pickNumber(sales, "orderCount", "order_count"),
    },
    expenses: {
      totalMinor: pickNumber(expenses, "totalMinor", "total_minor"),
      count: pickNumber(expenses, "count", "count"),
    },
    netMinor: pickNumber(r, "netMinor", "net_minor"),
    byCategory: (byCategory as unknown[]).map((item) => {
      const row = asRecord(item);
      return {
        categoryId: pickString(row, "categoryId", "category_id") ?? "",
        categoryName: pickString(row, "categoryName", "category_name") ?? "—",
        color: pickString(row, "color", "color"),
        totalMinor: pickNumber(row, "totalMinor", "total_minor"),
        count: pickNumber(row, "count", "count"),
      };
    }),
    byProduct: (byProduct as unknown[]).map((item) => {
      const row = asRecord(item);
      return {
        productId: pickString(row, "productId", "product_id") ?? "",
        productName: pickString(row, "productName", "product_name") ?? "—",
        salesMinor: pickNumber(row, "salesMinor", "sales_minor"),
        expensesMinor: pickNumber(row, "expensesMinor", "expenses_minor"),
        netMinor: pickNumber(row, "netMinor", "net_minor"),
        orderCount: pickNumber(row, "orderCount", "order_count"),
        expenseCount: pickNumber(row, "expenseCount", "expense_count"),
      };
    }),
    trend: (trend as unknown[]).map((item) => {
      const row = asRecord(item);
      return {
        date: String(row.date ?? ""),
        salesMinor: pickNumber(row, "salesMinor", "sales_minor"),
        expensesMinor: pickNumber(row, "expensesMinor", "expenses_minor"),
        netMinor: pickNumber(row, "netMinor", "net_minor"),
      };
    }),
  };
}

export interface ExpenseCategoryListParams {
  q?: string | undefined;
  isActive?: boolean | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export async function fetchExpenseCategories(
  params: ExpenseCategoryListParams,
): Promise<{ items: ExpenseCategory[]; total: number }> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.isActive !== undefined) query.set("is_active", String(params.isActive));
  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.pageSize !== undefined) {
    query.set("pageSize", String(params.pageSize));
    query.set("limit", String(params.pageSize));
  }
  const res = await apiRequest<{ items: unknown[]; total?: number }>(
    `/api/v1/admin/expense-categories?${query}`,
  );
  return {
    items: res.items.map(normalizeExpenseCategory),
    total: res.total ?? res.items.length,
  };
}

export async function createExpenseCategory(
  body: ExpenseCategoryInput,
): Promise<ExpenseCategory> {
  const res = await apiRequest<unknown>("/api/v1/admin/expense-categories", {
    method: "POST",
    body: JSON.stringify({
      name: body.name,
      description: body.description ?? null,
      color: body.color ?? null,
      icon: body.icon ?? null,
      is_active: body.isActive ?? true,
    }),
  });
  return normalizeExpenseCategory(res);
}

export async function updateExpenseCategory(
  id: string,
  body: Partial<ExpenseCategoryInput>,
): Promise<ExpenseCategory> {
  const payload: Record<string, unknown> = {};
  if (body.name !== undefined) payload.name = body.name;
  if (body.description !== undefined) payload.description = body.description;
  if (body.color !== undefined) payload.color = body.color;
  if (body.icon !== undefined) payload.icon = body.icon;
  if (body.isActive !== undefined) {
    payload.is_active = body.isActive;
  }
  const res = await apiRequest<unknown>(`/api/v1/admin/expense-categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return normalizeExpenseCategory(res);
}

export async function deleteExpenseCategory(id: string): Promise<void> {
  await apiRequest<void>(`/api/v1/admin/expense-categories/${id}`, { method: "DELETE" });
}

export interface ExpenseListParams {
  q?: string | undefined;
  categoryId?: string | undefined;
  productId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export async function fetchExpenses(
  params: ExpenseListParams,
): Promise<{ items: Expense[]; total: number }> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.categoryId) {
    query.set("categoryId", params.categoryId);
    query.set("category_id", params.categoryId);
  }
  if (params.productId) {
    query.set("productId", params.productId);
    query.set("product_id", params.productId);
  }
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.pageSize !== undefined) {
    query.set("pageSize", String(params.pageSize));
    query.set("limit", String(params.pageSize));
  }
  const res = await apiRequest<{ items: unknown[]; total?: number }>(
    `/api/v1/admin/expenses?${query}`,
  );
  return { items: res.items.map(normalizeExpense), total: res.total ?? res.items.length };
}

function expenseWriteBody(body: ExpenseInput): Record<string, unknown> {
  return {
    amountMinor: body.amountMinor,
    expenseDate: body.expenseDate,
    categoryId: body.categoryId,
    ...(body.productId ? { productId: body.productId } : { productId: null }),
    ...(body.paymentMethodId
      ? { paymentMethodId: body.paymentMethodId }
      : { paymentMethodId: null }),
    ...(body.vendor !== undefined ? { vendor: body.vendor } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.receiptMediaId
      ? { receiptMediaId: body.receiptMediaId }
      : { receiptMediaId: null }),
  };
}

export async function createExpense(body: ExpenseInput): Promise<Expense> {
  const res = await apiRequest<unknown>("/api/v1/admin/expenses", {
    method: "POST",
    body: JSON.stringify(expenseWriteBody(body)),
  });
  return normalizeExpense(res);
}

export async function updateExpense(id: string, body: ExpenseInput): Promise<Expense> {
  const res = await apiRequest<unknown>(`/api/v1/admin/expenses/${id}`, {
    method: "PATCH",
    body: JSON.stringify(expenseWriteBody(body)),
  });
  return normalizeExpense(res);
}

export async function deleteExpense(id: string): Promise<void> {
  await apiRequest<void>(`/api/v1/admin/expenses/${id}`, { method: "DELETE" });
}

export interface ProfitLossParams {
  from?: string | undefined;
  to?: string | undefined;
  productId?: string | undefined;
}

export async function fetchProfitLoss(params: ProfitLossParams): Promise<ProfitLossReport> {
  const query = new URLSearchParams();
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.productId) {
    query.set("productId", params.productId);
    query.set("product_id", params.productId);
  }
  const res = await apiRequest<unknown>(
    `/api/v1/admin/analytics/profit-loss?${query}`,
  );
  return normalizeProfitLoss(res);
}
