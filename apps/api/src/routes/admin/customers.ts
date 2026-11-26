/**
 * StackMate API — Hono route module (Hono migration, Phase 1).
 *
 * Converted mechanically from apps/api/src/app.ts (baseline feat e382d65):
 * same paths, methods, service calls, validation, RBAC and JSON shapes.
 * Only the HTTP plumbing changed: handlers read store/env/principal/
 * requestId from c.var (set by the Hono app middleware) and answer with
 * the same success/error envelopes. Shared HTTP plumbing lives in
 * apps/api/src/shared/http.ts.
 *
 * Middleware the Hono app MUST provide (was app.ts handleRequest/admin
 * preamble, not per-route code): request-id + standard/security headers,
 * CORS, CSRF gate, admin principal resolution, the 2FA-setup gate, the
 * admin 600/min bucket, and the AppError/SchemaValidationError ->
 * envelope mapping.
 */

import { formatDisplayDateDDMMYYYY } from "../../../../../packages/contracts/src/index.ts";
import { AppError } from "../../shared/errors.ts";
import { assertStaffPermissionAudited } from "../../modules/identity/service.ts";
import { listCustomers } from "../../modules/customers/list.ts";
import { computeCustomerFinancials, computeOrderPaid, computeOrderRemaining, createCustomerByAdmin, toCustomerAddressDto, updateCustomerByAdmin } from "../../modules/customers/service.ts";
import { searchGlobal } from "../../modules/search/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { collectionResponse, jsonResponse, parseListQuery, readJsonBody } from "../../shared/http.ts";

export function registerAdminCustomersRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/search", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Authentication required.", 401);
    }
    const q = url.searchParams.get("q") ?? "";
    return jsonResponse(c, {
      query: q.trim(),
      groups: searchGlobal(store.state, principal, q),
    });
  });
  app.get("/api/v1/admin/customers", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
    const { q, limit, page } = parseListQuery(url.searchParams);
    const { items, total } = await listCustomers(store, { q, limit, page });
    return collectionResponse(
      c,
      items.map((c) => ({
        ...c,
        created_date_display: formatDisplayDateDDMMYYYY(
          c.created_at,
          env.DEFAULT_TIMEZONE,
        ),
      })),
      null,
      200,
      total,
    );
  });
  app.post("/api/v1/admin/customers", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "customers.manage", requestId);
    const body = await readJsonBody(c);
    const customer = await createCustomerByAdmin(store, principal, body, requestId);
    return jsonResponse(c, customer, 201);
  });
  app.get("/api/v1/admin/customers/:customerId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    await assertStaffPermissionAudited(store, principal, "customers.read", requestId);
    const customer = store.state.customers.find(
      (cust) => cust.id === c.req.param("customerId")
    );
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
    // Per-order billed/paid/due (owner 2026-11-17): every order row
    // carries its own three amounts, computed from verified payments.
    const customerOrders = store.state.orders
      .filter((o) => o.customer_id === customer.id)
      .map((o) => ({
        ...o,
        paid_amount_minor: computeOrderPaid(store.state, o.id),
        remaining_minor: computeOrderRemaining(store.state, o),
      }));
    const orderIds = new Set(customerOrders.map((o) => o.id));
    const subIds = new Set(
      store.state.subscriptions
        .filter((s) => s.customer_id === customer.id)
        .map((s) => s.id)
    );
    const licenseIds = new Set(
      store.state.licenses
        .filter((l) => l.customer_id === customer.id)
        .map((l) => l.id)
    );
    // Activity history: audit rows touching the customer or any of
    // their orders/subscriptions/licenses, newest first (max 100).
    const activity = store.state.audit_logs
      .filter(
        (a) =>
          a.resource_id === customer.id ||
          (a.resource_type === "order" && orderIds.has(a.resource_id)) ||
          (a.resource_type === "subscription" && subIds.has(a.resource_id)) ||
          (a.resource_type === "license" && licenseIds.has(a.resource_id))
      )
      .slice(-100)
      .reverse();
    // Payments tab shape (live defect 2026-11-17): the detail
    // must return { submissions, transactions } — the same shape
    // as GET /customers/:id/payments — NOT a bare submissions
    // array. The UI reads customer.payments.submissions.length
    // as the tab-count fallback while the sub-query is pending;
    // a bare array made that read throw "Cannot read properties
    // of undefined (reading 'length')" on first load of a fresh
    // customer (warm cache on reload hid it — hence intermittent).
    // Filtered by the customer's orders only, like the
    // sub-endpoint (the old filter also included any submission
    // with ANY transaction, even for another customer's order).
    const paymentSubmissions = store.state.payment_submissions.filter((s) =>
      orderIds.has(s.order_id)
    );
    const paymentSubmissionIds = new Set(paymentSubmissions.map((s) => s.id));
    return jsonResponse(c, {
      ...customer,
      financials: computeCustomerFinancials(store.state, customer.id),
      contacts: store.state.customer_contacts.filter(
        (cc) => cc.customer_id === customer.id
      ),
      addresses: store.state.customer_addresses
        .filter((a) => a.customer_id === customer.id)
        .map(toCustomerAddressDto),
      reports: store.state.customer_reports
        .filter((r) => r.customer_id === customer.id)
        .map((r) => ({
          ...r,
          author_name:
            store.state.users.find((u) => u.id === r.author_user_id)?.name ?? null,
        })),
      orders: customerOrders,
      subscriptions: store.state.subscriptions.filter((s) => s.customer_id === customer.id),
      licenses: store.state.licenses.filter((l) => l.customer_id === customer.id),
      payments: {
        submissions: paymentSubmissions,
        transactions: store.state.payment_transactions.filter(
          (t) =>
            t.payment_submission_id !== null &&
            paymentSubmissionIds.has(t.payment_submission_id)
        ),
      },
      installations: store.state.licenses
        .filter((l) => l.customer_id === customer.id)
        .flatMap((l) =>
          l.activations.map((a) => ({
            ...a,
            license_number: l.license_number,
            product_id: l.product_id,
          }))
        ),
      tickets: store.state.support_tickets.filter(
        (t) => t.customer_id === customer.id
      ),
      activity,
    });
  });
  app.patch("/api/v1/admin/customers/:customerId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const requestId = c.var.requestId;
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = c.req.method;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const principal = c.var.principal;
    if (!principal) {
      throw new AppError("UNAUTHORIZED", "Valid staff authentication session required.", 401);
    }
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "customers.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updateCustomerByAdmin(
      store,
      principal,
      c.req.param("customerId")!,
      body,
      requestId
    );
    return jsonResponse(c, updated);
  });
}
