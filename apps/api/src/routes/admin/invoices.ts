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
import { listInvoices, listOrderInstallments } from "../../modules/invoices/list.ts";
import { orderExists } from "../../modules/orders/list.ts";
import { createInvoiceForOrderByAdmin, voidInvoiceByAdmin } from "../../modules/commerce/service.ts";
import { updateInstallmentByAdmin } from "../../modules/payments/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { collectionResponse, jsonResponse, parseListQuery, readJsonBody, readJsonBodyLenient } from "../../shared/http.ts";

export function registerAdminInvoicesRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/invoices", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
    const { q, limit, page } = parseListQuery(url.searchParams);
    const { items, total } = await listInvoices(store, { q, limit, page });
    return collectionResponse(c, items, null, 200, total);
  });
  app.get("/api/v1/admin/orders/:orderId/invoices", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
    const orderId = c.req.param("orderId");
    if (!(await orderExists(store, orderId))) {
      throw new AppError("NOT_FOUND", "Order not found.", 404);
    }
    const { q, limit, page } = parseListQuery(url.searchParams);
    const { items, total } = await listInvoices(store, { q, limit, page, orderId });
    return collectionResponse(c, items, null, 200, total);
  });
  app.post("/api/v1/admin/orders/:orderId/invoices", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "orders.manage", requestId);
    const invoice = await createInvoiceForOrderByAdmin(
      store,
      principal,
      c.req.param("orderId")!,
      requestId
    );
    return jsonResponse(c, invoice, 201);
  });
  app.get("/api/v1/admin/orders/:orderId/installments", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
    const orderId = c.req.param("orderId");
    if (!(await orderExists(store, orderId))) {
      throw new AppError("NOT_FOUND", "Order not found.", 404);
    }
    const { limit, page } = parseListQuery(url.searchParams);
    const { items, total } = await listOrderInstallments(store, orderId, { limit, page });
    return collectionResponse(
      c,
      items.map((i) => ({
        ...i,
        due_date_display: formatDisplayDateDDMMYYYY(
          `${i.due_date}T00:00:00.000Z`,
          env.DEFAULT_TIMEZONE
        ),
      })),
      null,
      200,
      total,
    );
  });
  app.patch("/api/v1/admin/orders/:orderId/installments/:installmentId", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "orders.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updateInstallmentByAdmin(
      store,
      principal,
      c.req.param("installmentId")!,
      body,
      requestId
    );
    return jsonResponse(c, updated);
  });
  app.get("/api/v1/admin/invoices/:invoiceId", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "orders.read", requestId);
    const invoice = store.state.invoices.find(
      (i) => i.id === c.req.param("invoiceId")
    );
    if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found.", 404);
    const order = store.state.orders.find((o) => o.id === invoice.order_id) ?? null;
    return jsonResponse(c, {
      ...invoice,
      order,
      customer: order
        ? (store.state.customers.find((c) => c.id === order.customer_id) ?? null)
        : null,
    });
  });
  app.post("/api/v1/admin/invoices/:invoiceId/void", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "orders.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as { reason?: string };
    const voided = await voidInvoiceByAdmin(
      store,
      principal,
      c.req.param("invoiceId")!,
      body.reason,
      requestId
    );
    return jsonResponse(c, voided);
  });
}
