/**
 * B-01 targeted admin order list.
 *
 * Same contract as `modules/products/list.ts`: targeted Drizzle
 * queries against `store.drizzleDb` (never `store.state`), SQL WHERE /
 * ORDER BY / LIMIT / OFFSET + a separate COUNT, rows mapped to the
 * snake_case `OrderRecord` shape the in-memory list returned.
 *
 * Paid/remaining (ADR-0009, `computeOrderPaid`): the sum of
 * installment `paid_amount_minor` when the order has installments,
 * else the sum of succeeded payment transactions. It is a SQL CASE
 * expression here, so `?open_only=true` (remaining > 0) and the
 * per-row paid/remaining values are all computed by the database.
 *
 * The list sorts newest-first (created_at DESC, id ASC — the
 * `sortByTimestamp` tiebreak); the customer-detail order list passes
 * `sort: "asc"` for the load order (created_at ASC, id ASC).
 */
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../../db/schema/index.ts";
import { customers } from "../../../../../db/schema/customers.ts";
import {
  orderItemEntitlementSnapshotItems,
  orderItemEntitlementSnapshots,
  orderItems,
  orders,
} from "../../../../../db/schema/orders.ts";
import { orderAttributions } from "../../../../../db/schema/tracking.ts";
import type {
  CustomerRecord,
  DatabaseState,
  OrderItemRecord,
  OrderItemSnapshotRecord,
  OrderRecord,
  StackMateDataStore,
} from "../../platform/db/store.ts";
import { computeOrderPaid, computeOrderRemaining } from "../customers/service.ts";

export type ListDb = NodePgDatabase<typeof schema>;

/**
 * First argument accepted by the list functions in this module.
 *
 * Routes pass the request store; `b01-lists.test.ts` passes a raw
 * Drizzle db. A store WITH `drizzleDb` (targeted / full DrizzleStore)
 * takes the targeted SQL path; a plain in-memory store (state only)
 * takes the in-memory fallback; a raw db is used directly.
 */
export type ListSource = StackMateDataStore | ListDb;

function drizzleDbOf(source: ListSource): ListDb | null {
  const maybe = source as { drizzleDb?: ListDb; state?: DatabaseState };
  if (maybe.drizzleDb) return maybe.drizzleDb;
  if (maybe.state) return null;
  return source as ListDb;
}

/** Substring match; `q` arrives lowercased from parseListQuery. */
function includesQuery(haystack: string | null | undefined, q: string): boolean {
  return !q ? true : (haystack ?? "").toLowerCase().includes(q);
}

/** Timestamp sort with an id ASC tiebreak (shared/http.ts, verbatim). */
function sortByTimestamp<T extends { id: string }>(
  items: T[],
  field: string,
  direction: "desc" | "asc",
): T[] {
  const timeOf = (row: T): number => {
    const n = new Date(String((row as Record<string, unknown>)[field] ?? "")).getTime();
    return Number.isFinite(n) ? n : 0;
  };
  return [...items].sort((a, b) => {
    const byTime = timeOf(a) - timeOf(b);
    if (byTime !== 0) return direction === "desc" ? -byTime : byTime;
    return a.id.localeCompare(b.id);
  });
}

function applyPage<T>(items: T[], limit: number, page: number): T[] {
  return items.slice((page - 1) * limit, page * limit);
}

export interface OrderListParams {
  q: string;
  limit: number;
  page: number;
  /** Exact payment_status filter (?payment_status=). */
  paymentStatus?: string | null;
  /** ?open_only=true — only orders with a balance due. */
  openOnly?: boolean;
  /** Customer-detail scope. */
  customerId?: string | null;
  sort?: "asc" | "desc";
}

export interface OrderListItem {
  order: OrderRecord;
  customer: CustomerRecord | null;
  paid_amount_minor: number;
  remaining_minor: number;
}

export interface OrderListResult {
  items: OrderListItem[];
  total: number;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Paid for one order, as SQL (see module doc): installments win
 * when any exist, else succeeded transactions.
 */
const paidExpr = sql<number>`CASE WHEN EXISTS (SELECT 1 FROM "order_installments" WHERE "order_installments"."order_id" = "orders"."id") THEN COALESCE((SELECT SUM("order_installments"."paid_amount_minor") FROM "order_installments" WHERE "order_installments"."order_id" = "orders"."id"), 0) ELSE COALESCE((SELECT SUM("payment_transactions"."amount_minor") FROM "payment_transactions" WHERE "payment_transactions"."order_id" = "orders"."id" AND "payment_transactions"."status" = 'succeeded'), 0) END`;

function buildWhere(params: OrderListParams): SQL | undefined {
  const { q, paymentStatus, openOnly, customerId } = params;
  const conditions: SQL[] = [];
  if (customerId) conditions.push(eq(orders.customerId, customerId));
  if (paymentStatus) conditions.push(eq(orders.paymentStatus, paymentStatus));
  if (q !== "") {
    const like = `%${escapeLikePattern(q)}%`;
    const match = or(
      ilike(orders.orderNumber, like),
      ilike(orders.publicReference, like),
      sql`EXISTS (SELECT 1 FROM "customers" WHERE "customers"."id" = "orders"."customer_id" AND "customers"."name" ILIKE ${like})`,
    );
    if (match) conditions.push(match);
  }
  if (openOnly) {
    // remaining = max(0, total - paid) > 0  ⟺  paid < total.
    conditions.push(sql`"orders"."total_minor" > ${paidExpr}`);
  }
  return conditions.length === 0 ? undefined : and(...conditions);
}

function orderOf(
  row: typeof orders.$inferSelect,
  items: OrderItemRecord[],
  attribution: Record<string, string | null | undefined> | null,
): OrderRecord {
  return {
    id: row.id,
    order_number: row.orderNumber,
    public_reference: row.publicReference,
    customer_id: row.customerId,
    source: row.source as OrderRecord["source"],
    integrated_site_id: row.integratedSiteId,
    status: row.status as OrderRecord["status"],
    payment_status: row.paymentStatus as OrderRecord["payment_status"],
    currency_code: row.currencyCode,
    subtotal_minor: row.subtotalMinor,
    discount_minor: row.discountMinor,
    tax_minor: row.taxMinor,
    total_minor: row.totalMinor,
    customer_note: row.customerNote,
    internal_note: row.internalNote,
    items,
    attribution,
    created_by_user_id: row.createdByUserId,
    activation_mode: row.activationMode as OrderRecord["activation_mode"],
    activation_percent: row.activationPercent,
    activation_date: row.activationDate,
    suspend_on_missed_schedule: row.suspendOnMissedSchedule,
    grace_days: row.graceDays,
    payment_method_id: row.paymentMethodId,
    lead_id: row.leadId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    completed_at: iso(row.completedAt),
    cancelled_at: iso(row.cancelledAt),
  };
}

export async function listOrders(source: ListSource, params: OrderListParams): Promise<OrderListResult> {
  const db = drizzleDbOf(source);
  if (db) return listOrdersTargeted(db, params);
  return listOrdersInMemory((source as StackMateDataStore).state, params);
}

/**
 * In-memory fallback — the pre-B-01 route logic, reproduced exactly:
 * payment_status filter, open_only via computeOrderRemaining > 0,
 * q over order_number / public_reference / customer name, sort by
 * created_at (default desc, `sort` param honoured) with id ASC
 * tiebreak, total = full filtered count, page sliced after sorting.
 */
function listOrdersInMemory(
  state: DatabaseState,
  params: OrderListParams,
): OrderListResult {
  const { q, limit, page, paymentStatus, openOnly, customerId, sort = "desc" } = params;
  const needle = q.toLowerCase();
  const filtered = state.orders
    .filter((o) => (customerId ? o.customer_id === customerId : true))
    .filter((o) => (!paymentStatus ? true : o.payment_status === paymentStatus))
    .filter((o) => (!openOnly ? true : computeOrderRemaining(state, o) > 0))
    .filter(
      (o) =>
        includesQuery(o.order_number, needle) ||
        includesQuery(o.public_reference, needle) ||
        includesQuery(
          state.customers.find((c) => c.id === o.customer_id)?.name,
          needle,
        ),
    );
  const sorted = sortByTimestamp(filtered, "created_at", sort);
  return {
    items: applyPage(sorted, limit, page).map((o) => ({
      order: o,
      customer: state.customers.find((c) => c.id === o.customer_id) ?? null,
      paid_amount_minor: computeOrderPaid(state, o.id),
      remaining_minor: computeOrderRemaining(state, o),
    })),
    total: filtered.length,
  };
}

async function listOrdersTargeted(db: ListDb, params: OrderListParams): Promise<OrderListResult> {
  const { limit, page, sort = "desc" } = params;
  const where = buildWhere(params);

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(orders)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);

  const orderBy =
    sort === "asc"
      ? [asc(orders.createdAt), asc(orders.id)]
      : [desc(orders.createdAt), asc(orders.id)];
  const pageRows = await db
    .select({ order: orders, paid: paidExpr })
    .from(orders)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset((page - 1) * limit);

  const ids = pageRows.map((r) => r.order.id);
  const itemsByOrder = new Map<string, OrderItemRecord[]>();
  const attributionByOrder = new Map<string, Record<string, string | null | undefined>>();
  const customersById = new Map<string, CustomerRecord>();
  if (ids.length > 0) {
    // Order items (+ entitlement snapshots + snapshot items).
    const itemRows = await db
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, ids))
      .orderBy(asc(orderItems.orderId), asc(orderItems.createdAt), asc(orderItems.id));
    const itemIds = itemRows.map((r) => r.id);
    const snapshotByItem = new Map<string, OrderItemSnapshotRecord>();
    if (itemIds.length > 0) {
      const snapshotRows = await db
        .select()
        .from(orderItemEntitlementSnapshots)
        .where(inArray(orderItemEntitlementSnapshots.orderItemId, itemIds));
      const snapshotIds = snapshotRows.map((r) => r.id);
      const snapshotItemsBySnapshot = new Map<
        string,
        OrderItemSnapshotRecord["items"]
      >();
      if (snapshotIds.length > 0) {
        const snapshotItemRows = await db
          .select()
          .from(orderItemEntitlementSnapshotItems)
          .where(inArray(orderItemEntitlementSnapshotItems.snapshotId, snapshotIds))
          .orderBy(
            asc(orderItemEntitlementSnapshotItems.snapshotId),
            asc(orderItemEntitlementSnapshotItems.featureKeySnapshot),
          );
        for (const it of snapshotItemRows) {
          const list = snapshotItemsBySnapshot.get(it.snapshotId) ?? [];
          list.push({
            feature_key_snapshot: it.featureKeySnapshot,
            value_type_snapshot:
              it.valueTypeSnapshot as OrderItemSnapshotRecord["items"][number]["value_type_snapshot"],
            entitlement_value: it.entitlementValue ?? null,
            unit_snapshot: it.unitSnapshot,
          });
          snapshotItemsBySnapshot.set(it.snapshotId, list);
        }
      }
      for (const s of snapshotRows) {
        snapshotByItem.set(s.orderItemId, {
          id: s.id,
          order_item_id: s.orderItemId,
          source_type: s.sourceType as OrderItemSnapshotRecord["source_type"],
          source_package_version_id: s.sourcePackageVersionId,
          schema_version: s.schemaVersion,
          snapshot_hash: s.snapshotHash,
          items: snapshotItemsBySnapshot.get(s.id) ?? [],
          created_at: s.createdAt.toISOString(),
        });
      }
    }
    for (const it of itemRows) {
      const snapshot = snapshotByItem.get(it.id);
      if (!snapshot) {
        // Same fail-closed rule as the combined load: an order item
        // without its entitlement snapshot is corrupt data.
        throw new Error(
          `listOrders: order_items row ${it.id} has no order_item_entitlement_snapshots row.`,
        );
      }
      const record: OrderItemRecord = {
        id: it.id,
        order_id: it.orderId,
        product_id: it.productId,
        package_id: it.packageId,
        package_version_id: it.packageVersionId,
        package_price_id: it.packagePriceId,
        item_kind: it.itemKind as OrderItemRecord["item_kind"],
        fulfillment_type_snapshot: it.fulfillmentTypeSnapshot,
        product_name_snapshot: it.productNameSnapshot,
        package_name_snapshot: it.packageNameSnapshot,
        package_version_snapshot: it.packageVersionSnapshot,
        price_kind_snapshot: it.priceKindSnapshot as OrderItemRecord["price_kind_snapshot"],
        interval_unit_snapshot:
          it.intervalUnitSnapshot as OrderItemRecord["interval_unit_snapshot"],
        interval_count_snapshot: it.intervalCountSnapshot,
        activation_limit_snapshot: it.activationLimitSnapshot,
        quantity: it.quantity,
        unit_amount_minor: it.unitAmountMinor,
        line_subtotal_minor: it.lineSubtotalMinor,
        line_discount_minor: it.lineDiscountMinor,
        line_tax_minor: it.lineTaxMinor,
        line_total_minor: it.lineTotalMinor,
        currency_code: it.currencyCode,
        entitlement_snapshot: snapshot,
        created_at: it.createdAt.toISOString(),
      };
      const list = itemsByOrder.get(it.orderId) ?? [];
      list.push(record);
      itemsByOrder.set(it.orderId, list);
    }

    // Attributions (1:1 by order_id; only non-null keys, like the load).
    const attributionRows = await db
      .select()
      .from(orderAttributions)
      .where(inArray(orderAttributions.orderId, ids));
    for (const row of attributionRows) {
      const rec: Record<string, string | null | undefined> = {};
      for (const key of [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "fbp",
        "fbc",
      ] as const) {
        const camel = {
          utm_source: row.utmSource,
          utm_medium: row.utmMedium,
          utm_campaign: row.utmCampaign,
          utm_content: row.utmContent,
          utm_term: row.utmTerm,
          fbp: row.fbp,
          fbc: row.fbc,
        }[key];
        if (camel !== null) rec[key] = camel;
      }
      if (Object.keys(rec).length > 0) attributionByOrder.set(row.orderId, rec);
    }

    // Customers for the page (admin list embeds the full customer row).
    const customerIds = [...new Set(pageRows.map((r) => r.order.customerId))];
    const customerRows = await db
      .select()
      .from(customers)
      .where(inArray(customers.id, customerIds));
    for (const cu of customerRows) {
      customersById.set(cu.id, {
        id: cu.id,
        customer_number: cu.customerNumber,
        customer_type: cu.customerType as CustomerRecord["customer_type"],
        name: cu.name,
        email: cu.email,
        normalized_email: cu.normalizedEmail,
        phone: cu.phone,
        normalized_phone: cu.normalizedPhone,
        whatsapp: cu.whatsapp,
        credit_balance_minor: cu.creditBalanceMinor,
        company_name: cu.companyName,
        website: cu.website,
        country_code: cu.countryCode ?? "BD",
        status: cu.status as CustomerRecord["status"],
        registration_source: cu.registrationSource ?? "admin",
        notes: cu.notes,
        created_at: cu.createdAt.toISOString(),
        updated_at: cu.updatedAt.toISOString(),
      });
    }
  }

  return {
    items: pageRows.map(({ order, paid }) => {
      const paidAmount = Number(paid);
      return {
        order: orderOf(order, itemsByOrder.get(order.id) ?? [], attributionByOrder.get(order.id) ?? null),
        customer: customersById.get(order.customerId) ?? null,
        paid_amount_minor: paidAmount,
        remaining_minor: Math.max(0, order.totalMinor - paidAmount),
      };
    }),
    total,
  };
}

/** Targeted existence check (for list routes that 404 on a missing parent). */
export async function orderExists(source: ListSource, id: string): Promise<boolean> {
  const db = drizzleDbOf(source);
  if (!db) return (source as StackMateDataStore).state.orders.some((o) => o.id === id);
  return orderExistsTargeted(db, id);
}

async function orderExistsTargeted(db: ListDb, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  return rows.length > 0;
}
