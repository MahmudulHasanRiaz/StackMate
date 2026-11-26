/**
 * Admin subscription routes (Hono) — Hono migration Phase 1.
 *
 * Converted verbatim from the hand-rolled dispatcher in
 * apps/api/src/app.ts (baseline feat e382d65, lines ~5996–6160).
 * Service layer, validators and envelopes are unchanged — only the
 * HTTP plumbing moved. Auth / CSRF / rate-limit middleware (Worker 3,
 * hono/*) provides c.var.requestId / env / store / principal; the
 * per-route permission checks below are preserved from app.ts.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createCollectionEnvelope,
  createSuccessEnvelope,
  formatDisplayDateDDMMYYYY,
} from "../../../../../packages/contracts/src/index.ts";
import type { AppEnv } from "../../types/context.ts";
import { AppError } from "../../shared/errors.ts";
import {
  assertStaffPermissionAudited,
  type StaffPrincipal,
} from "../../modules/identity/service.ts";
import {
  listRenewals,
  listSubscriptions,
  type RenewalBucket,
} from "../../modules/subscriptions/list.ts";
import {
  generateSubscriptionRenewalInvoice,
  transitionSubscriptionStatus,
} from "../../modules/subscriptions/service.ts";

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

// E-09/E-11: renewal buckets over subscriptions — B-01: the bucket
// CASE now lives in `modules/subscriptions/list.ts` (`listRenewals`),
// same definitions as below used to be (disjoint; cancelled →
// cancelled; past_due → failed; renewal date past → overdue; within
// 7 days → due; within 30 days → upcoming; no next_renewal_at or a
// renewal more than 30 days out → no bucket). Windows are UTC
// calendar days off the YYYY-MM-DD part of next_renewal_at.

export function registerAdminSubscriptionsRoutes(app: Hono<AppEnv>): void {
  // Subscriptions & Licenses
  app.get("/api/v1/admin/subscriptions", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "subscriptions.read", requestId);
    const { q, limit, page } = parseListQuery(c.req.query());
    const { items, total } = await listSubscriptions(store, {
      q,
      limit,
      page,
    });
    return pagedCollectionTotal(
      c,
      items.map(({ subscription: s, customer, product }) => ({
        ...s,
        customer,
        product,
        next_renewal_display: s.next_renewal_at
          ? formatDisplayDateDDMMYYYY(s.next_renewal_at, env.DEFAULT_TIMEZONE)
          : null,
      })),
      total,
    );
  });

  // E-09: renewals view (PRD §12.5) — the work queue the
  // subscriptions list cannot show: ?bucket=upcoming|due|overdue|
  // failed|cancelled (no bucket = all bucketed rows). Buckets are
  // the bucket CASE in `modules/subscriptions/list.ts` (disjoint; rows with
  // no next_renewal_at or a renewal >30 days out belong to no
  // bucket). Sorted nearest-renewal-first so the most urgent row
  // is on top; each row carries customer + product like the
  // subscriptions list.
  app.get("/api/v1/admin/renewals", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "subscriptions.read", requestId);
    const query = c.req.query();
    const bucketParam = query.bucket ?? null;
    const validBuckets = ["upcoming", "due", "overdue", "failed", "cancelled"] as const;
    const bucketFilter =
      bucketParam !== null &&
      (validBuckets as readonly string[]).includes(bucketParam)
        ? (bucketParam as (typeof validBuckets)[number])
        : bucketParam === null
          ? null
          : undefined;
    if (bucketFilter === undefined) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Unknown renewals bucket. Use upcoming, due, overdue, failed, or cancelled.",
        400
      );
    }
    const { q, limit, page } = parseListQuery(query);
    const { items, total } = await listRenewals(store, {
      q,
      limit,
      page,
      bucket: bucketFilter,
    });
    return pagedCollectionTotal(
      c,
      items.map(({ subscription, bucket: rowBucket, customer, product }) => ({
        ...subscription,
        bucket: rowBucket,
        customer,
        product,
        next_renewal_display: subscription.next_renewal_at
          ? formatDisplayDateDDMMYYYY(
              subscription.next_renewal_at,
              env.DEFAULT_TIMEZONE
            )
          : null,
      })),
      total,
    );
  });

  // Batch 1: subscription detail.
  app.get("/api/v1/admin/subscriptions/:subscriptionId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "subscriptions.read", requestId);
    const sub = store.state.subscriptions.find(
      (s) => s.id === c.req.param("subscriptionId")
    );
    if (!sub) throw new AppError("NOT_FOUND", "Subscription not found.", 404);
    return ok(c, {
      ...sub,
      customer: store.state.customers.find((cu) => cu.id === sub.customer_id) ?? null,
      product: store.state.products.find((p) => p.id === sub.product_id) ?? null,
      renewal_invoices: store.state.invoices.filter(
        (i) => i.subscription_id === sub.id
      ),
      next_renewal_display: sub.next_renewal_at
        ? formatDisplayDateDDMMYYYY(sub.next_renewal_at, env.DEFAULT_TIMEZONE)
        : null,
    });
  });

  app.post("/api/v1/admin/subscriptions/:subscriptionId/renewal-invoices", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "subscriptions.manage", requestId);
    // A-02: NO default key — without a header the service
    // derives ren_<id>_period_<n> from the next period.
    const res = await generateSubscriptionRenewalInvoice(
      store,
      principal,
      c.req.param("subscriptionId"),
      c.req.header("Idempotency-Key"),
      requestId
    );
    return ok(c, res, res.replayed ? 200 : 201);
  });

  app.post("/api/v1/admin/subscriptions/:subscriptionId/:action", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    const action = c.req.param("action");
    if (action !== "pause" && action !== "resume" && action !== "cancel") {
      // app.ts falls through to 404 for any other :action value.
      throw new AppError(
        "NOT_FOUND",
        `Route 'POST /api/v1/admin/subscriptions/${c.req.param("subscriptionId")}/${action}' not found.`,
        404
      );
    }
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "subscriptions.manage", requestId);
    const updated = await transitionSubscriptionStatus(
      store,
      principal,
      c.req.param("subscriptionId"),
      action,
      requestId
    );
    return ok(c, updated);
  });
}
