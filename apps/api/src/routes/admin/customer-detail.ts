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
import { createCustomerAddressByAdmin, createCustomerReportByAdmin, deleteCustomerAddressByAdmin, splitCustomerContactByAdmin, updateCustomerAddressByAdmin } from "../../modules/customers/service.ts";
import {
  customerExists,
  listCustomerActivity,
  listCustomerAddressesTargeted,
  listCustomerReportsTargeted,
  listCustomerTickets,
} from "../../modules/customers/list.ts";
import { listOrders } from "../../modules/orders/list.ts";
import { listSubscriptions } from "../../modules/subscriptions/list.ts";
import { listCustomerInstallations, listLicenses } from "./licenses.ts";
import { listCustomerPayments } from "../../modules/payments/list.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { collectionResponse, jsonResponse, parseListQuery, readJsonBody } from "../../shared/http.ts";

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
    const customerId = c.req.param("customerId");
    if (!(await customerExists(store, customerId))) {
      throw new AppError("NOT_FOUND", "Customer not found.", 404);
    }
    const { limit, page } = parseListQuery(url.searchParams);
    const { items, total } = await listOrders(store, {
      q: "",
      limit,
      page,
      customerId,
      sort: "asc",
    });
    return collectionResponse(
      c,
      items.map(({ order: o, paid_amount_minor, remaining_minor }) => ({
        ...o,
        paid_amount_minor,
        remaining_minor,
      })),
      null,
      200,
      total,
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
    const customerId = c.req.param("customerId");
    if (!(await customerExists(store, customerId))) {
      throw new AppError("NOT_FOUND", "Customer not found.", 404);
    }
    const { limit, page } = parseListQuery(url.searchParams);
    const { items, total } = await listSubscriptions(store, {
      q: "",
      limit,
      page,
      customerId,
    });
    return collectionResponse(
      c,
      items.map(({ subscription }) => subscription),
      null,
      200,
      total,
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
    const customerId = c.req.param("customerId");
    if (!(await customerExists(store, customerId))) {
      throw new AppError("NOT_FOUND", "Customer not found.", 404);
    }
    const { limit, page } = parseListQuery(url.searchParams);
    const { items, total } = await listLicenses(store, {
      q: "",
      limit,
      page,
      sort: "asc",
      customerId,
    });
    return collectionResponse(c, items, null, 200, total);
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
    const customerId = c.req.param("customerId")!;
    if (!(await customerExists(store, customerId))) {
      throw new AppError("NOT_FOUND", "Customer not found.", 404);
    }
    const { limit, page } = parseListQuery(url.searchParams);
    const addresses = await listCustomerAddressesTargeted(store, customerId);
    return collectionResponse(
      c,
      addresses.slice((page - 1) * limit, page * limit),
      null,
      200,
      addresses.length,
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
    const customerId = c.req.param("customerId")!;
    if (!(await customerExists(store, customerId))) {
      throw new AppError("NOT_FOUND", "Customer not found.", 404);
    }
    const { limit, page } = parseListQuery(url.searchParams);
    const reports = await listCustomerReportsTargeted(store, customerId);
    return collectionResponse(
      c,
      reports.slice((page - 1) * limit, page * limit),
      null,
      200,
      reports.length,
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
    const customerId = c.req.param("customerId");
    if (!(await customerExists(store, customerId))) {
      throw new AppError("NOT_FOUND", "Customer not found.", 404);
    }
    return jsonResponse(c, await listCustomerPayments(store, customerId));
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
    const { items, total } = await listCustomerInstallations(
      store,
      c.req.param("customerId"),
      { limit, page },
    );
    return collectionResponse(c, items, null, 200, total);
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
    const customerId = c.req.param("customerId");
    if (!(await customerExists(store, customerId))) {
      throw new AppError("NOT_FOUND", "Customer not found.", 404);
    }
    const { limit, page } = parseListQuery(url.searchParams);
    const { items, total } = await listCustomerActivity(store, customerId, { limit, page });
    return collectionResponse(c, items, null, 200, total);
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
    const { items, total } = await listCustomerTickets(store, c.req.param("customerId"), {
      limit,
      page,
    });
    return collectionResponse(c, items, null, 200, total);
  });
}
