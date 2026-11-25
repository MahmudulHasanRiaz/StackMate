/**
 * Admin payment-submission read routes (Hono) — Hono migration Phase 1.
 *
 * Split out of payments.ts (500-line cap). Submission list/detail/
 * history. Converted verbatim from app.ts (baseline feat e382d65).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
  formatDisplayDateTimeDDMMYYYY,
} from "../../../../../packages/contracts/src/index.ts";
import { computeOrderRemaining } from "../../modules/customers/service.ts";

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

function parseTimestampSort(
  query: Record<string, string | undefined>,
  field: string
): "desc" | "asc" {
  return query.sort === `${field}:asc` ? "asc" : "desc";
}

function sortByTimestamp<T extends { id: string }>(
  items: T[],
  field: string,
  direction: "desc" | "asc"
): T[] {
  const timeOf = (row: T): number => {
    const n = new Date(
      String((row as Record<string, unknown>)[field] ?? "")
    ).getTime();
    return Number.isFinite(n) ? n : 0;
  };
  return [...items].sort((a, b) => {
    const byTime = timeOf(a) - timeOf(b);
    if (byTime !== 0) return direction === "desc" ? -byTime : byTime;
    return a.id.localeCompare(b.id);
  });
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

// A-04: dispatcher-level idempotency (see app.ts runIdempotentCommand
// header for the reserve → execute → complete protocol). Copied
// verbatim, store passed explicitly instead of closed over.

export function registerAdminPaymentSubmissionsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/payment-submissions/:submissionId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
    const sub = store.state.payment_submissions.find(
      (s) => s.id === c.req.param("submissionId")
    );
    if (!sub) throw new AppError("NOT_FOUND", "Payment submission not found.", 404);
    const order = store.state.orders.find((o) => o.id === sub.order_id);
    const customer = store.state.customers.find((cu) => cu.id === sub.customer_id);
    const methodRec = store.state.payment_methods.find(
      (m) => m.id === sub.payment_method_id
    );
    return ok(c, {
      ...sub,
      order_number: order?.order_number ?? null,
      order_total_minor: order?.total_minor ?? null,
      // ADR-0009: the approve form needs the order's remaining
      // amount and the customer's credit balance to offer
      // apply-credit explicitly (never silent).
      order_remaining_minor: order ? computeOrderRemaining(store.state, order) : null,
      customer_credit_balance_minor: customer?.credit_balance_minor ?? 0,
      customer_name: customer?.name ?? null,
      payment_method_name: methodRec?.display_name ?? null,
      submitted_date_display: formatDisplayDateTimeDDMMYYYY(
        sub.submitted_at,
        env.DEFAULT_TIMEZONE
      ),
      verification_logs: store.state.payment_verification_logs.filter(
        (l) => l.payment_submission_id === sub.id
      ),
    });
  });


  app.get("/api/v1/admin/payment-submissions/:submissionId/history", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
    const sub = store.state.payment_submissions.find(
      (s) => s.id === c.req.param("submissionId")
    );
    if (!sub) throw new AppError("NOT_FOUND", "Payment submission not found.", 404);
    const { limit, page } = parseListQuery(c.req.query());
    return pagedCollection(
      c,
      store.state.payment_verification_logs.filter(
        (l) => l.payment_submission_id === sub.id
      ),
      limit,
      page
    );
  });


  app.get("/api/v1/admin/payment-submissions", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
    const query = c.req.query();
    const statusFilter = query.status;
    const filteredSubmissions = store.state.payment_submissions.filter(
      (s) => (!statusFilter ? true : s.status === statusFilter),
    );
    // M-22: deterministic newest-first order (submitted_at DESC,
    // id ASC) — the SPA's "transient inconsistency" was partly
    // this list arriving unsorted while the client paginated.
    // ?sort=submitted_at:asc flips the time direction; anything
    // else keeps the M-22 default. Sorted BEFORE the window
    // slices, so the ?limit=100 window holds the newest rows.
    const items = sortByTimestamp(
      filteredSubmissions,
      "submitted_at",
      parseTimestampSort(query, "submitted_at"),
    ).map((s) => {
        const order = store.state.orders.find((o) => o.id === s.order_id);
        const customer = store.state.customers.find((cu) => cu.id === s.customer_id);
        const method = store.state.payment_methods.find((m) => m.id === s.payment_method_id);
        return {
          ...s,
          order_number: order?.order_number ?? null,
          order_total_minor: order?.total_minor ?? null,
          customer_name: customer?.name ?? null,
          payment_method_name: method?.display_name ?? null,
          submitted_date_display: formatDisplayDateTimeDDMMYYYY(
            s.submitted_at,
            env.DEFAULT_TIMEZONE
          ),
          verification_logs: store.state.payment_verification_logs.filter(
            (l) => l.payment_submission_id === s.id
          ),
        };
      });
    const { limit, page } = parseListQuery(query);
    return pagedCollection(c, items, limit, page);
  });

}
