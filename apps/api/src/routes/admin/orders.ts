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
import { listOrders } from "../../modules/orders/list.ts";
import { saveOrderAsPackage } from "../../modules/catalog/service.ts";
import { computeOrderPaid, computeOrderRemaining } from "../../modules/customers/service.ts";
import { cancelOrderByAdmin, completeOrderByAdmin, createOrderByAdmin } from "../../modules/commerce/service.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../types/context.ts";
import { collectionResponse, jsonResponse, parseListQuery, parseTimestampSort, readJsonBody, readJsonBodyLenient } from "../../shared/http.ts";
import { runIdempotentCommand } from "../../shared/idempotency.ts";

export function registerAdminOrdersRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/orders", async (c) => {
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
    const statusFilter = url.searchParams.get("payment_status");
    // H-03: ?open_only=true narrows to orders with a balance due
    // (remaining > 0 from verified payments) — the payment-review
    // order picker. Unknown params are ignored.
    const openOnly = url.searchParams.get("open_only") === "true";
    const { q, limit, page } = parseListQuery(url.searchParams);
    const { items, total } = await listOrders(store, {
      q,
      limit,
      page,
      paymentStatus: statusFilter,
      openOnly,
      sort: parseTimestampSort(url.searchParams, "created_at"),
    });
    return collectionResponse(
      c,
      items.map(({ order: o, customer, paid_amount_minor, remaining_minor }) => ({
        ...o,
        customer,
        // Paid/remaining are computed from verified payments
        // (ADR-0009) — never denormalized, so they cannot drift.
        paid_amount_minor,
        remaining_minor,
        created_date_display: formatDisplayDateDDMMYYYY(
          o.created_at,
          env.DEFAULT_TIMEZONE,
        ),
      })),
      null,
      200,
      total,
    );
  });
  app.post("/api/v1/admin/orders", async (c) => {
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
    await assertStaffPermissionAudited(store, principal, "orders.create", requestId);
    const body = await readJsonBody(c);
    // F-12: the order's on_date boundary is a business date in the
    // configured timezone (defaults to Asia/Dhaka inside the
    // service when omitted).
    // A-04: admin order creation is idempotent per
    // Idempotency-Key (a retried create after a network timeout
    // replays the first order instead of minting a second).
    const created = await runIdempotentCommand(c, {
      scope: "admin_order_create",
      key: request.headers.get("Idempotency-Key"),
      payload: body,
      statusCode: 201,
      fn: () =>
        createOrderByAdmin(store, principal, body, requestId, {
          timeZone: env.DEFAULT_TIMEZONE,
        }),
    });
    return jsonResponse(c, created.body, created.replayed ? 200 : 201);
  });
  app.get("/api/v1/admin/orders/:orderId", async (c) => {
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
    const order = store.state.orders.find((o) => o.id === c.req.param("orderId"));
    if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
    return jsonResponse(c, {
      ...order,
      // E-19: attribution is stored per order (UTM + fbp/fbc —
      // order_attributions has no referrer column, so there is
      // none to show) — surfaced explicitly instead of relying
      // on the spread above, so the SPA can render it on order
      // detail (PRD §15.5).
      attribution: order.attribution ?? null,
      // E-08: per-item entitlement snapshots, aggregated at
      // order level for the snapshot card (each item already
      // carries its own entitlement_snapshot; this is the same
      // data, one level up, so detail never has to dig into
      // items to show what was actually sold).
      entitlement_snapshot: order.items.map((i) => i.entitlement_snapshot),
      // Site name for the detail page: the order shows source
      // "website" but never named the site (live gap on ORD-10005,
      // a Test-site order). Null for admin orders (no site).
      site_name:
        order.integrated_site_id === null
          ? null
          : store.state.integrated_sites.find(
              (s) => s.id === order.integrated_site_id
            )?.name ?? null,
      customer: store.state.customers.find((c) => c.id === order.customer_id) ?? null,
      paid_amount_minor: computeOrderPaid(store.state, order.id),
      remaining_minor: computeOrderRemaining(store.state, order),
      installments: store.state.order_installments
        .filter((i) => i.order_id === order.id)
        .sort((a, b) => a.installment_number - b.installment_number)
        .map((i) => ({
          ...i,
          due_date_display: formatDisplayDateDDMMYYYY(
            `${i.due_date}T00:00:00.000Z`,
            env.DEFAULT_TIMEZONE
          ),
        })),
      invoices: store.state.invoices.filter((i) => i.order_id === order.id),
      payment_submissions: store.state.payment_submissions.filter(
        (s) => s.order_id === order.id
      ),
    });
  });
  app.post("/api/v1/admin/orders/:orderId/save-as-package", async (c) => {
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
    // M-9: saving as a package creates a package — packages.manage.
    await assertStaffPermissionAudited(store, principal, "packages.manage", requestId);
    const body = await readJsonBody(c);
    const created = await saveOrderAsPackage(
      store,
      principal,
      c.req.param("orderId")!,
      body,
      requestId
    );
    return jsonResponse(c, created, 201);
  });
  app.post("/api/v1/admin/orders/:orderId/cancel", async (c) => {
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
    const cancelled = await cancelOrderByAdmin(
      store,
      principal,
      c.req.param("orderId")!,
      body.reason,
      requestId
    );
    return jsonResponse(c, cancelled);
  });
  app.post("/api/v1/admin/orders/:orderId/complete", async (c) => {
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
    const completed = await completeOrderByAdmin(
      store,
      principal,
      c.req.param("orderId")!,
      requestId
    );
    return jsonResponse(c, completed);
  });
}
