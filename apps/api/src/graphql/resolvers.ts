/**
 * GraphQL resolvers — admin complex reads only (Hono migration, Phase 2).
 *
 * Every resolver reads the SAME Drizzle store state and calls the SAME
 * service helpers as the REST handlers in `../app.ts`:
 *   - customer/order financials: `computeOrderPaid`,
 *     `computeOrderRemaining`, `computeCustomerFinancials`,
 *     `toCustomerAddressDto` (modules/customers/service.ts)
 *   - RBAC: `assertStaffPermission` (modules/identity/service.ts)
 *   - dashboard range: `parseOverviewRange`, `isTimestampInOverviewRange`
 *     (modules/analytics/overview-range.ts)
 *   - display dates: `formatDisplayDateDDMMYYYY` (packages/contracts)
 *
 * No new data layer, no service rewrite. The dashboard aggregation below
 * mirrors the inline computation in `app.ts` (`GET
 * /api/v1/admin/analytics/overview`) field for field — including the
 * renewal-bucket helper (E-09/E-11) — because that computation lives in
 * the dispatcher, not in a service. If it is ever extracted to a service,
 * this resolver must call the service instead.
 */
import { GraphQLError, GraphQLScalarType, Kind, valueFromASTUntyped } from "graphql";
import { formatDisplayDateDDMMYYYY } from "../../../../packages/contracts/src/index.ts";
import type { StackMateBindings } from "../env.ts";
import { AppError } from "../shared/errors.ts";
import {
  isTimestampInOverviewRange,
  parseOverviewRange,
} from "../modules/analytics/overview-range.ts";
import {
  computeCustomerFinancials,
  computeOrderPaid,
  computeOrderRemaining,
  toCustomerAddressDto,
} from "../modules/customers/service.ts";
import {
  assertStaffPermission,
  type StaffPrincipal,
} from "../modules/identity/service.ts";
import type { StackMateDataStore } from "../platform/db/store.ts";
import type {
  CustomerRecord,
  LicenseRecord,
  OrderRecord,
} from "../platform/db/store.ts";

/** Per-request GraphQL context — built from the Hono vars in server.ts. */
export interface GraphQLContext {
  store: StackMateDataStore;
  principal: StaffPrincipal | null;
  env: StackMateBindings;
  requestId: string;
}

/** JSON scalar: passes stored JSON (attribution, snapshots, periods) through. */
const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value.",
  serialize: (value: unknown) => value ?? null,
  parseValue: (value: unknown) => value,
  parseLiteral: (ast) => {
    if (ast.kind === Kind.NULL) return null;
    return valueFromASTUntyped(ast);
  },
});

/** Map an AppError (or anything else) to a GraphQLError yoga passes through. */
function toGraphQLError(error: unknown): GraphQLError {
  if (error instanceof GraphQLError) return error;
  if (error instanceof AppError) {
    return new GraphQLError(error.message, {
      extensions: { code: error.code, statusCode: error.statusCode },
    });
  }
  return new GraphQLError("Internal server error.", {
    extensions: { code: "INTERNAL_ERROR", statusCode: 500 },
  });
}

/** Same RBAC as the REST handler for this read (401 unauthenticated, 403 denied). */
function requirePermission(ctx: GraphQLContext, permission: string): void {
  try {
    assertStaffPermission(ctx.principal, permission);
  } catch (error) {
    throw toGraphQLError(error);
  }
}

/** License row WITHOUT any key material (never expose hash / raw key). */
function safeLicense(license: LicenseRecord): Omit<LicenseRecord, "license_key_hash" | "issued_raw_key_once"> {
  const { license_key_hash: _hash, issued_raw_key_once: _raw, ...safe } = license;
  return safe;
}

/** One customer order row with its own billed/paid/due (REST parity). */
function customerOrderRow(
  ctx: GraphQLContext,
  order: OrderRecord,
): OrderRecord & { paid_amount_minor: number; remaining_minor: number } {
  return {
    ...order,
    paid_amount_minor: computeOrderPaid(ctx.store.state, order.id),
    remaining_minor: computeOrderRemaining(ctx.store.state, order),
  };
}

/** Payments shape shared by customerDetail and orderDetail (REST parity). */
function paymentsForOrderIds(ctx: GraphQLContext, orderIds: Set<string>) {
  const submissions = ctx.store.state.payment_submissions.filter((s) => orderIds.has(s.order_id));
  const submissionIds = new Set(submissions.map((s) => s.id));
  return {
    submissions,
    transactions: ctx.store.state.payment_transactions.filter(
      (t) => t.payment_submission_id !== null && submissionIds.has(t.payment_submission_id),
    ),
  };
}

// -- Dashboard helpers (mirror of app.ts E-09/E-11) ---------------------------
const RENEWAL_UPCOMING_DAYS = 30;
const RENEWAL_DUE_DAYS = 7;

function renewalDayOf(iso: string | null | undefined): string | null {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null;
}

function addDaysIso(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function renewalBucketOf(
  sub: { status: string; next_renewal_at: string | null },
  todayDay: string,
): "upcoming" | "due" | "overdue" | "failed" | "cancelled" | null {
  if (sub.status === "cancelled") return "cancelled";
  if (sub.status === "past_due") return "failed";
  const day = renewalDayOf(sub.next_renewal_at);
  if (day === null) return null;
  if (day < todayDay) return "overdue";
  if (day <= addDaysIso(todayDay, RENEWAL_DUE_DAYS)) return "due";
  if (day <= addDaysIso(todayDay, RENEWAL_UPCOMING_DAYS)) return "upcoming";
  return null;
}

function sortByTimestampDesc<T extends { id: string; created_at: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

export const resolvers = {
  JSON: JSONScalar,

  Query: {
    customerDetail(
      _parent: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) {
      requirePermission(ctx, "customers.read");
      const customer: CustomerRecord | undefined = ctx.store.state.customers.find(
        (c) => c.id === args.id,
      );
      if (!customer) {
        throw toGraphQLError(new AppError("NOT_FOUND", "Customer not found.", 404));
      }
      const state = ctx.store.state;
      const orders = state.orders.filter((o) => o.customer_id === customer.id);
      const orderIds = new Set(orders.map((o) => o.id));
      const customerLicenses = state.licenses.filter((l) => l.customer_id === customer.id);
      return {
        ...customer,
        financials: computeCustomerFinancials(state, customer.id),
        contacts: state.customer_contacts.filter((cc) => cc.customer_id === customer.id),
        addresses: state.customer_addresses
          .filter((a) => a.customer_id === customer.id)
          .map(toCustomerAddressDto),
        reports: state.customer_reports
          .filter((r) => r.customer_id === customer.id)
          .map((r) => ({
            ...r,
            author_name: state.users.find((u) => u.id === r.author_user_id)?.name ?? null,
          })),
        orders: orders.map((o) => customerOrderRow(ctx, o)),
        subscriptions: state.subscriptions.filter((s) => s.customer_id === customer.id),
        licenses: customerLicenses.map(safeLicense),
        payments: paymentsForOrderIds(ctx, orderIds),
        installations: customerLicenses.flatMap((l) =>
          l.activations.map((a) => ({
            ...a,
            license_number: l.license_number,
            product_id: l.product_id,
          })),
        ),
        tickets: state.support_tickets.filter((t) => t.customer_id === customer.id),
      };
    },

    orderDetail(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
      requirePermission(ctx, "orders.read");
      const state = ctx.store.state;
      const order: OrderRecord | undefined = state.orders.find((o) => o.id === args.id);
      if (!order) {
        throw toGraphQLError(new AppError("NOT_FOUND", "Order not found.", 404));
      }
      const payments = paymentsForOrderIds(ctx, new Set([order.id]));
      const itemIds = new Set(order.items.map((i) => i.id));
      return {
        ...order,
        entitlement_snapshot: order.items.map((i) => i.entitlement_snapshot),
        site_name:
          order.integrated_site_id === null
            ? null
            : (state.integrated_sites.find((s) => s.id === order.integrated_site_id)?.name ??
              null),
        customer: state.customers.find((c) => c.id === order.customer_id) ?? null,
        paid_amount_minor: computeOrderPaid(state, order.id),
        remaining_minor: computeOrderRemaining(state, order),
        installments: state.order_installments
          .filter((i) => i.order_id === order.id)
          .sort((a, b) => a.installment_number - b.installment_number)
          .map((i) => ({
            ...i,
            due_date_display: formatDisplayDateDDMMYYYY(
              `${i.due_date}T00:00:00.000Z`,
              ctx.env.DEFAULT_TIMEZONE,
            ),
          })),
        invoices: state.invoices.filter((i) => i.order_id === order.id),
        licenses: state.licenses
          .filter((l) => l.source_order_item_id !== null && itemIds.has(l.source_order_item_id))
          .map(safeLicense),
        payments,
        payment_submissions: payments.submissions,
      };
    },

    dashboardKpis(
      _parent: unknown,
      args: { from?: string | null; to?: string | null },
      ctx: GraphQLContext,
    ) {
      requirePermission(ctx, "products.read");
      const state = ctx.store.state;
      // M-8 / F-02: revenue + order counts are finance data — null (not 0)
      // when the caller lacks payments.read, exactly like the REST overview.
      const canSeeRevenue =
        ctx.principal?.roles.includes("super_admin") ||
        ctx.principal?.permissions.includes("payments.read") ||
        false;
      let range: { from: string; to: string } | null;
      try {
        const params = new URLSearchParams();
        if (args.from != null) params.set("from", args.from);
        if (args.to != null) params.set("to", args.to);
        range = parseOverviewRange(params);
      } catch (error) {
        throw toGraphQLError(error);
      }
      const timeZone = ctx.env.DEFAULT_TIMEZONE;
      const inRange = (iso: string | null | undefined) =>
        isTimestampInOverviewRange(iso, range, timeZone);
      const paidOrders = state.orders.filter(
        (o) => o.payment_status === "paid" && (range === null ? true : inRange(o.completed_at)),
      );
      const verifiedRevenueMinor = paidOrders.reduce((acc, o) => acc + o.total_minor, 0);
      const ordersInRange = state.orders.filter((o) => inRange(o.created_at));
      const paidOrdersInRange = ordersInRange.filter((o) => o.payment_status === "paid");
      const pendingSubmissions = state.payment_submissions.filter(
        (s) => s.status === "submitted" || s.status === "under_review",
      );
      const todayDay = new Date().toISOString().slice(0, 10);
      const upcomingRenewals = state.subscriptions.filter((s) => {
        const bucket = renewalBucketOf(s, todayDay);
        return bucket === "upcoming" || bucket === "due";
      });
      const customerById = new Map(state.customers.map((c) => [c.id, c]));
      const panels = {
        recent_orders: sortByTimestampDesc(state.orders)
          .slice(0, 5)
          .map((o) => ({
            ...o,
            customer: customerById.get(o.customer_id) ?? null,
            paid_amount_minor: computeOrderPaid(state, o.id),
            remaining_minor: computeOrderRemaining(state, o),
            created_date_display: formatDisplayDateDDMMYYYY(o.created_at, timeZone),
          })),
        pending_submissions: [...pendingSubmissions]
          .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
          .slice(0, 5)
          .map((s) => ({
            ...s,
            customer: customerById.get(s.customer_id) ?? null,
            order_number:
              state.orders.find((o) => o.id === s.order_id)?.order_number ?? null,
          })),
        expiring_licenses: [...state.licenses]
          .filter((l) => {
            if (l.status !== "active") return false;
            const day = renewalDayOf(l.expires_at);
            return (
              day !== null && day >= todayDay && day <= addDaysIso(todayDay, RENEWAL_UPCOMING_DAYS)
            );
          })
          .sort((a, b) => (a.expires_at ?? "") < (b.expires_at ?? "") ? -1 : 1)
          .slice(0, 5)
          .map((l) => {
            const safe = safeLicense(l);
            const customer = customerById.get(l.customer_id);
            const product = state.products.find((p) => p.id === l.product_id);
            return {
              ...safe,
              customer_name: customer?.name ?? null,
              product_code: product?.code ?? null,
              product_name: product?.name ?? null,
              active_activations_count: l.activations.filter((a) => a.status === "active").length,
              expires_date_display: l.expires_at
                ? formatDisplayDateDDMMYYYY(l.expires_at, timeZone)
                : "Lifetime",
            };
          }),
      };
      return {
        currency_code: ctx.env.DEFAULT_CURRENCY,
        total_products: state.products.length,
        active_products: state.products.filter((p) => p.status === "active").length,
        total_customers: state.customers.length,
        total_orders: canSeeRevenue ? ordersInRange.length : null,
        paid_orders: canSeeRevenue ? paidOrdersInRange.length : null,
        pending_payment_submissions: canSeeRevenue ? pendingSubmissions.length : null,
        upcoming_renewals: upcomingRenewals.length,
        panels,
        active_subscriptions: state.subscriptions.filter((s) => s.status === "active").length,
        active_licenses: state.licenses.filter((l) => l.status === "active").length,
        expired_or_revoked_licenses: state.licenses.filter(
          (l) => l.status === "expired" || l.status === "revoked",
        ).length,
        verified_revenue_minor: canSeeRevenue ? verifiedRevenueMinor : null,
        pending_outbox_events: state.outbox_events.filter((e) => e.status === "pending").length,
        range,
      };
    },
  },
};
