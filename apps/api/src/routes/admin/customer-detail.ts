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

import { AppError } from "../../shared/errors.ts";
import { assertStaffPermissionAudited } from "../../modules/identity/service.ts";
import { computeOrderPaid, computeOrderRemaining, createCustomerAddressByAdmin, createCustomerReportByAdmin, deleteCustomerAddressByAdmin, listCustomerAddresses, listCustomerReports, splitCustomerContactByAdmin, updateCustomerAddressByAdmin } from "../../modules/customers/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { jsonResponse, pagedCollectionResponse, parseListQuery, readJsonBody } from "../../shared/http.ts";
export function registerCustomerDetailRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/customers/:customerId/orders", async (c) => {
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
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, 
      store.state.orders
        .filter((o) => o.customer_id === customer.id)
        .map((o) => ({
          ...o,
          paid_amount_minor: computeOrderPaid(store.state, o.id),
          remaining_minor: computeOrderRemaining(store.state, o),
        })),
      limit, page
    );
  });
  app.get("/api/v1/admin/customers/:customerId/subscriptions", async (c) => {
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
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, 
      store.state.subscriptions.filter((s) => s.customer_id === customer.id),
      limit, page
    );
  });
  app.get("/api/v1/admin/customers/:customerId/licenses", async (c) => {
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
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, 
      store.state.licenses
        .filter((l) => l.customer_id === customer.id)
        .map(({ license_key_hash: _h, issued_raw_key_once: _r, ...safe }) => safe),
      limit, page
    );
  });
  app.get("/api/v1/admin/customers/:customerId/addresses", async (c) => {
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
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, 
      await listCustomerAddresses(store, principal, c.req.param("customerId")!),
      limit, page
    );
  });
  app.post("/api/v1/admin/customers/:customerId/addresses", async (c) => {
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
    const address = await createCustomerAddressByAdmin(
      store,
      principal,
      c.req.param("customerId")!,
      body,
      requestId
    );
    return jsonResponse(c, address, 201);
  });
  app.patch("/api/v1/admin/customers/:customerId/addresses/:addressId", async (c) => {
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
    const address = await updateCustomerAddressByAdmin(
      store,
      principal,
      c.req.param("customerId")!,
      c.req.param("addressId")!,
      body,
      requestId
    );
    return jsonResponse(c, address);
  });
  app.delete("/api/v1/admin/customers/:customerId/addresses/:addressId", async (c) => {
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
    await deleteCustomerAddressByAdmin(
      store,
      principal,
      c.req.param("customerId")!,
      c.req.param("addressId")!,
      requestId
    );
    return jsonResponse(c, { deleted: true });
  });
  app.get("/api/v1/admin/customers/:customerId/reports", async (c) => {
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
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, 
      await listCustomerReports(store, principal, c.req.param("customerId")!),
      limit, page
    );
  });
  app.post("/api/v1/admin/customers/:customerId/reports", async (c) => {
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
    const report = await createCustomerReportByAdmin(
      store,
      principal,
      c.req.param("customerId")!,
      body,
      requestId
    );
    return jsonResponse(c, report, 201);
  });
  app.post("/api/v1/admin/customers/:customerId/split-contact", async (c) => {
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
    const result = await splitCustomerContactByAdmin(
      store,
      principal,
      c.req.param("customerId")!,
      body,
      requestId
    );
    return jsonResponse(c, result, 201);
  });
  app.get("/api/v1/admin/customers/:customerId/payments", async (c) => {
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
    const orderIds = new Set(
      store.state.orders
        .filter((o) => o.customer_id === customer.id)
        .map((o) => o.id)
    );
    const submissions = store.state.payment_submissions.filter((s) =>
      orderIds.has(s.order_id)
    );
    const submissionIds = new Set(submissions.map((s) => s.id));
    return jsonResponse(c, {
      submissions,
      transactions: store.state.payment_transactions.filter((t) =>
        t.payment_submission_id !== null &&
        submissionIds.has(t.payment_submission_id)
      ),
    });
  });
  app.get("/api/v1/admin/customers/:customerId/installations", async (c) => {
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
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, 
      store.state.licenses
        .filter((l) => l.customer_id === c.req.param("customerId"))
        .flatMap((l) =>
          l.activations.map((a) => ({
            ...a,
            license_number: l.license_number,
            product_id: l.product_id,
          }))
        ),
      limit, page
    );
  });
  app.get("/api/v1/admin/customers/:customerId/activity", async (c) => {
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
    const orderIds = new Set(
      store.state.orders
        .filter((o) => o.customer_id === customer.id)
        .map((o) => o.id)
    );
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
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, 
      store.state.audit_logs
        .filter(
          (a) =>
            a.resource_id === customer.id ||
            (a.resource_type === "order" && orderIds.has(a.resource_id)) ||
            (a.resource_type === "subscription" && subIds.has(a.resource_id)) ||
            (a.resource_type === "license" && licenseIds.has(a.resource_id))
        )
        .slice(-100)
        .reverse(),
      limit, page
    );
  });
  app.get("/api/v1/admin/customers/:customerId/tickets", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "tickets.view", requestId);
    const { limit, page } = parseListQuery(url.searchParams);
    return pagedCollectionResponse(c, 
      store.state.support_tickets.filter(
        (t) => t.customer_id === c.req.param("customerId")
      ),
      limit, page
    );
  });
}
