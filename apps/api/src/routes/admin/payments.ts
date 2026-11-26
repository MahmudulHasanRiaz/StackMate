/**
 * Admin payment routes (Hono) — Hono migration Phase 1.
 *
 * Order-scoped payment claims/evidence, payment providers, payment
 * methods, refund reads. Submission reads live in
 * payments-submissions.ts, approvals + refund creation in
 * payments-approvals.ts. Converted verbatim from app.ts (baseline
 * feat e382d65) — only the HTTP plumbing moved; service layer
 * unchanged.
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
} from "../../../../../packages/contracts/src/index.ts";
import type { StackMateBindings } from "../../env.ts";
import type { StackMateDataStore } from "../../platform/db/store.ts";
import {
  resolveStorageDriver,
  type DriverDeps,
} from "../../platform/storage/driver.ts";
import {
  listPaymentMethods,
  listPaymentProviders,
  listPaymentRefunds,
} from "../../modules/payments/list.ts";
import {
  createPaymentMethodByAdmin,
  createPaymentProviderByAdmin,
  deletePaymentMethodByAdmin,
  deletePaymentProviderByAdmin,
  recordManualPaymentClaimByAdmin,
  setPaymentMethodEnabledByAdmin,
  updatePaymentMethodByAdmin,
  updatePaymentProviderByAdmin,
  uploadPrivatePaymentEvidence,
} from "../../modules/payments/service.ts";
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

function pagedCollectionTotal<T>(
  c: Context<AppEnv>,
  pageItems: T[],
  total: number,
  status = 200
): Response {
  return c.json(
    createCollectionEnvelope(
      pageItems,
      null,
      c.var.requestId,
      total
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

// A-04: dispatcher-level idempotency (see app.ts runIdempotentCommand
// header for the reserve → execute → complete protocol). Copied
// verbatim, store passed explicitly instead of closed over.

function driverDepsForRequest(
  store: StackMateDataStore,
  env: StackMateBindings
): DriverDeps {
  const maybeDrizzle = store as unknown as { drizzleDb?: unknown };
  const maybeBucket = store as unknown as {
    r2Bucket?: unknown;
    usesInMemoryBucket?: boolean;
  };
  return {
    db: (maybeDrizzle.drizzleDb ?? null) as DriverDeps["db"],
    appEnv: env.APP_ENV,
    r2Bucket: maybeBucket.r2Bucket as DriverDeps["r2Bucket"],
    usesInMemoryBucket: maybeBucket.usesInMemoryBucket,
  };
}

export function registerAdminPaymentsRoutes(app: Hono<AppEnv>): void {
  app.post("/api/v1/admin/orders/:orderId/payment-submissions", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "payments.approve", requestId);
    const body = await readJsonBody(c);
    const created = await recordManualPaymentClaimByAdmin(
      store,
      principal,
      c.req.param("orderId"),
      body,
      requestId
    );
    return ok(c, created, 201);
  });


  app.post("/api/v1/admin/orders/:orderId/payment-evidence", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // H-1: the admin evidence upload is a privileged write —
    // require payments.approve at the route (the service asserts
    // it again when the principal is passed as actor below).
    await assertStaffPermissionAudited(store, principal, "payments.approve", requestId);
    const body = (await readJsonBody(c)) as {
      filename: string;
      content_type: string;
      file_base64: string;
    };
    const order = store.state.orders.find(
      (o) => o.id === c.req.param("orderId")
    );
    if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
    if (!body.filename || !body.content_type || !body.file_base64) {
      throw new AppError(
        "VALIDATION_ERROR",
        "filename, content_type, and file_base64 are required.",
        422
      );
    }
    const bytes = Uint8Array.from(Buffer.from(body.file_base64, "base64"));
    // Storage driver (PLAN §31): evidence lands on the selected
    // driver (R2 or Local); resolveStorageDriver fails closed in
    // staging/production when no real R2 bucket is configured.
    const adminEvidenceDriver = await resolveStorageDriver(
      driverDepsForRequest(store, env)
    );
    const asset = await uploadPrivatePaymentEvidence(store, {
      orderId: order.id,
      customerId: order.customer_id,
      filename: body.filename,
      contentType: body.content_type,
      bytes,
      bucketName: adminEvidenceDriver.name === "r2" ? env.R2_BUCKET_NAME : "local",
      driver: adminEvidenceDriver,
      // H-1: pass the staff principal so the service-level
      // payments.approve check and the staff audit row fire.
      actor: principal,
      requestId,
    });
    return ok(c, asset, 201);
  });

  // Payment Providers, Methods, Submissions & Verification


  app.get("/api/v1/admin/payment-providers", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
    const { q, limit, page } = parseListQuery(c.req.query());
    const { items, total } = await listPaymentProviders(store, {
      q,
      limit,
      page,
    });
    return pagedCollectionTotal(c, items, total);
  });


  app.get("/api/v1/admin/payment-methods", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
    // H-03: ?is_enabled=true/false narrows the combobox/server
    // list to enabled/disabled methods. Unknown params ignored.
    const query = c.req.query();
    const isEnabledParam = query.is_enabled;
    const enabledFilter =
      isEnabledParam === "true" ? true : isEnabledParam === "false" ? false : null;
    const { q, limit, page } = parseListQuery(query);
    const { items, total } = await listPaymentMethods(store, {
      q,
      limit,
      page,
      isEnabled: enabledFilter,
    });
    return pagedCollectionTotal(c, items, total);
  });


  app.post("/api/v1/admin/payment-methods", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
    const body = await readJsonBody(c);
    const created = await createPaymentMethodByAdmin(store, principal, body, requestId);
    return ok(c, created, 201);
  });

  // Batch 1: payment provider + method lifecycle writes.


  app.post("/api/v1/admin/payment-providers", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
    const body = await readJsonBody(c);
    const created = await createPaymentProviderByAdmin(store, principal, body, requestId);
    return ok(c, created, 201);
  });


  app.patch("/api/v1/admin/payment-providers/:providerId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updatePaymentProviderByAdmin(
      store,
      principal,
      c.req.param("providerId"),
      body,
      requestId
    );
    return ok(c, updated);
  });

  // E-16: delete a payment provider (PRD §11.2 lifecycle).
  // Same guard pattern as webhook-endpoint delete: history is
  // preserved, the provider row goes.


  app.delete("/api/v1/admin/payment-providers/:providerId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
    const deleted = await deletePaymentProviderByAdmin(
      store,
      principal,
      c.req.param("providerId"),
      requestId
    );
    return ok(c, deleted);
  });


  app.get("/api/v1/admin/payment-methods/:methodId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
    const methodRec = store.state.payment_methods.find(
      (m) => m.id === c.req.param("methodId")
    );
    if (!methodRec) throw new AppError("NOT_FOUND", "Payment method not found.", 404);
    return ok(c, methodRec);
  });


  app.patch("/api/v1/admin/payment-methods/:methodId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
    const body = await readJsonBody(c);
    const updated = await updatePaymentMethodByAdmin(
      store,
      principal,
      c.req.param("methodId"),
      body,
      requestId
    );
    return ok(c, updated);
  });

  // E-16: delete a payment method (PRD §11.2 lifecycle).
  // Same guard pattern as webhook-endpoint delete.


  app.delete("/api/v1/admin/payment-methods/:methodId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
    const deleted = await deletePaymentMethodByAdmin(
      store,
      principal,
      c.req.param("methodId"),
      requestId
    );
    return ok(c, deleted);
  });


  app.post("/api/v1/admin/payment-methods/:methodId/enable", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
    const updated = await setPaymentMethodEnabledByAdmin(
      store,
      principal,
      c.req.param("methodId"),
      true,
      requestId
    );
    return ok(c, updated);
  });


  app.post("/api/v1/admin/payment-methods/:methodId/disable", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "payments.methods.manage", requestId);
    const updated = await setPaymentMethodEnabledByAdmin(
      store,
      principal,
      c.req.param("methodId"),
      false,
      requestId
    );
    return ok(c, updated);
  });

  // Batch 1: single submission detail + verification history.


  app.get("/api/v1/admin/refunds", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
    const { q, limit, page } = parseListQuery(c.req.query());
    const { items, total } = await listPaymentRefunds(store, {
      q,
      limit,
      page,
    });
    return pagedCollectionTotal(c, items, total);
  });


  app.get("/api/v1/admin/refunds/:refundId", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "payments.read", requestId);
    const refund = store.state.payment_refunds.find(
      (r) => r.id === c.req.param("refundId")
    );
    if (!refund) throw new AppError("NOT_FOUND", "Refund not found.", 404);
    return ok(c, refund);
  });

}
