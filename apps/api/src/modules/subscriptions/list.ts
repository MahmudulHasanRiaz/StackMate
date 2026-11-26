/**
 * B-01 targeted admin subscription lists.
 *
 * Same contract as `modules/products/list.ts`: targeted Drizzle
 * queries against `store.drizzleDb` (never `store.state`), SQL WHERE /
 * ORDER BY / LIMIT / OFFSET + a separate COUNT, rows mapped to the
 * snake_case record shapes the in-memory lists returned.
 *
 * Renewals (`listRenewals`) computes the E-09/E-11 buckets in SQL
 * with the same definitions as `renewalBucketOf` (cancelled →
 * cancelled; past_due → failed; renewal date past → overdue; within
 * 7 days → due; within 30 days → upcoming; no renewal date or >30
 * days out → no bucket), over UTC calendar days.
 */
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../../db/schema/index.ts";
import { customers } from "../../../../../db/schema/customers.ts";
import { products } from "../../../../../db/schema/catalog.ts";
import { subscriptionPeriods, subscriptions } from "../../../../../db/schema/subscriptions.ts";
import type {
  CustomerRecord,
  DatabaseState,
  ProductRecord,
  StackMateDataStore,
  SubscriptionPeriodRecord,
  SubscriptionRecord,
} from "../../platform/db/store.ts";

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

/** created_at ASC, id ASC — the targeted SQL order. */
function byCreatedAsc<T extends { created_at: string; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.created_at === b.created_at
      ? a.id.localeCompare(b.id)
      : a.created_at < b.created_at
        ? -1
        : 1,
  );
}

function applyPage<T>(items: T[], limit: number, page: number): T[] {
  return items.slice((page - 1) * limit, page * limit);
}

// E-09/E-11 renewal buckets (pre-B-01 route logic, verbatim).
// Windows are UTC calendar days off the YYYY-MM-DD part of
// next_renewal_at. Buckets are disjoint: cancelled → cancelled;
// past_due → failed; renewal date past → overdue; within 7 days →
// due; within 30 days → upcoming. Rows with no next_renewal_at, or a
// renewal more than 30 days out, belong to no bucket.
const RENEWAL_UPCOMING_DAYS = 30;
const RENEWAL_DUE_DAYS = 7;
const renewalDayOf = (iso: string | null | undefined): string | null =>
  typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null;
const addDaysIso = (day: string, days: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const renewalBucketOf = (
  sub: { status: string; next_renewal_at: string | null },
  todayDay: string,
): RenewalBucket | null => {
  if (sub.status === "cancelled") return "cancelled";
  if (sub.status === "past_due") return "failed";
  const day = renewalDayOf(sub.next_renewal_at);
  if (day === null) return null;
  if (day < todayDay) return "overdue";
  if (day <= addDaysIso(todayDay, RENEWAL_DUE_DAYS)) return "due";
  if (day <= addDaysIso(todayDay, RENEWAL_UPCOMING_DAYS)) return "upcoming";
  return null;
};

export interface SubscriptionListParams {
  q: string;
  limit: number;
  page: number;
  /** Customer-detail scope. */
  customerId?: string | null;
}

export interface SubscriptionListItem {
  subscription: SubscriptionRecord;
  customer: CustomerRecord | null;
  product: ProductRecord | null;
}

export interface SubscriptionListResult {
  items: SubscriptionListItem[];
  total: number;
}

export type RenewalBucket = "upcoming" | "due" | "overdue" | "failed" | "cancelled";

export interface RenewalListParams {
  q: string;
  limit: number;
  page: number;
  bucket?: RenewalBucket | null;
}

export interface RenewalListItem extends SubscriptionListItem {
  bucket: RenewalBucket;
}

export interface RenewalListResult {
  items: RenewalListItem[];
  total: number;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function customerOf(row: typeof customers.$inferSelect): CustomerRecord {
  return {
    id: row.id,
    customer_number: row.customerNumber,
    customer_type: row.customerType as CustomerRecord["customer_type"],
    name: row.name,
    email: row.email,
    normalized_email: row.normalizedEmail,
    phone: row.phone,
    normalized_phone: row.normalizedPhone,
    whatsapp: row.whatsapp,
    credit_balance_minor: row.creditBalanceMinor,
    company_name: row.companyName,
    website: row.website,
    country_code: row.countryCode ?? "BD",
    status: row.status as CustomerRecord["status"],
    registration_source: row.registrationSource ?? "admin",
    notes: row.notes,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function productOf(row: typeof products.$inferSelect): ProductRecord {
  return {
    id: row.id,
    code: row.code,
    slug: row.slug,
    name: row.name,
    description: row.description,
    product_type: row.productType,
    fulfillment_type: row.fulfillmentType,
    distribution_channels: [],
    default_activation_limit: row.defaultActivationLimit,
    offline_grace_hours: row.offlineGraceHours,
    status: row.status as ProductRecord["status"],
    website_url: row.websiteUrl,
    documentation_url: row.documentationUrl,
    logo_asset_id: row.logoAssetId ?? null,
    created_by_user_id: row.createdByUserId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function attachRefs(
  db: ListDb,
  rows: (typeof subscriptions.$inferSelect)[],
): Promise<{
  periodsBySubscription: Map<string, SubscriptionPeriodRecord[]>;
  customersById: Map<string, CustomerRecord>;
  productsById: Map<string, ProductRecord>;
}> {
  const ids = rows.map((r) => r.id);
  const periodsBySubscription = new Map<string, SubscriptionPeriodRecord[]>();
  const customersById = new Map<string, CustomerRecord>();
  const productsById = new Map<string, ProductRecord>();
  if (ids.length > 0) {
    const periodRows = await db
      .select()
      .from(subscriptionPeriods)
      .where(inArray(subscriptionPeriods.subscriptionId, ids))
      .orderBy(
        asc(subscriptionPeriods.subscriptionId),
        asc(subscriptionPeriods.periodNumber),
      );
    for (const p of periodRows) {
      const list = periodsBySubscription.get(p.subscriptionId) ?? [];
      list.push({
        id: p.id,
        subscription_id: p.subscriptionId,
        period_number: p.periodNumber,
        period_start: p.periodStart.toISOString(),
        period_end: p.periodEnd.toISOString(),
        status: p.status as SubscriptionPeriodRecord["status"],
        renewal_order_id: p.renewalOrderId,
        invoice_id: p.invoiceId,
        payment_transaction_id: p.paymentTransactionId,
        activated_at: iso(p.activatedAt),
        created_at: p.createdAt.toISOString(),
      });
      periodsBySubscription.set(p.subscriptionId, list);
    }
  }
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  if (customerIds.length > 0) {
    const customerRows = await db
      .select()
      .from(customers)
      .where(inArray(customers.id, customerIds));
    for (const cu of customerRows) customersById.set(cu.id, customerOf(cu));
  }
  const productIds = [...new Set(rows.map((r) => r.productId))];
  if (productIds.length > 0) {
    const productRows = await db
      .select()
      .from(products)
      .where(inArray(products.id, productIds));
    for (const p of productRows) productsById.set(p.id, productOf(p));
  }
  return { periodsBySubscription, customersById, productsById };
}

function subscriptionOf(
  row: typeof subscriptions.$inferSelect,
  periods: SubscriptionPeriodRecord[],
): SubscriptionRecord {
  return {
    id: row.id,
    subscription_number: row.subscriptionNumber,
    customer_id: row.customerId,
    product_id: row.productId,
    source_order_item_id: row.sourceOrderItemId,
    source_package_version_id: row.sourcePackageVersionId,
    status: row.status as SubscriptionRecord["status"],
    billing_kind: row.billingKind as SubscriptionRecord["billing_kind"],
    interval_unit: row.intervalUnit as SubscriptionRecord["interval_unit"],
    interval_count: row.intervalCount,
    currency_code: row.currencyCode,
    unit_amount_minor: row.unitAmountMinor,
    grace_days: row.graceDays,
    current_period_start: iso(row.currentPeriodStart),
    current_period_end: iso(row.currentPeriodEnd),
    next_renewal_at: iso(row.nextRenewalAt),
    cancel_at_period_end: row.cancelAtPeriodEnd,
    cancelled_at: iso(row.cancelledAt),
    periods,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function listSubscriptions(
  source: ListSource,
  params: SubscriptionListParams,
): Promise<SubscriptionListResult> {
  const db = drizzleDbOf(source);
  if (db) return listSubscriptionsTargeted(db, params);
  return listSubscriptionsInMemory((source as StackMateDataStore).state, params);
}

/**
 * In-memory fallback — the pre-B-01 route logic, reproduced exactly:
 * subscription_number / customer-name substring filter, embedded
 * customer + product, total = full filtered count, page sliced after
 * filtering. Sorted created_at ASC, id ASC (the targeted order).
 */
function listSubscriptionsInMemory(
  state: DatabaseState,
  params: SubscriptionListParams,
): SubscriptionListResult {
  const { q, limit, page, customerId } = params;
  const needle = q.toLowerCase();
  const filtered = byCreatedAsc(
    state.subscriptions
      .filter((s) => (customerId ? s.customer_id === customerId : true))
      .filter(
        (s) =>
          includesQuery(s.subscription_number, needle) ||
          includesQuery(
            state.customers.find((cu) => cu.id === s.customer_id)?.name,
            needle,
          ),
      ),
  );
  return {
    items: applyPage(filtered, limit, page).map((s) => ({
      subscription: s,
      customer: state.customers.find((cu) => cu.id === s.customer_id) ?? null,
      product: state.products.find((p) => p.id === s.product_id) ?? null,
    })),
    total: filtered.length,
  };
}

async function listSubscriptionsTargeted(
  db: ListDb,
  params: SubscriptionListParams,
): Promise<SubscriptionListResult> {
  const { q, limit, page, customerId } = params;
  const conditions: SQL[] = [];
  if (customerId) conditions.push(eq(subscriptions.customerId, customerId));
  if (q !== "") {
    const like = `%${escapeLikePattern(q)}%`;
    const match = or(
      ilike(subscriptions.subscriptionNumber, like),
      sql`EXISTS (SELECT 1 FROM "customers" WHERE "customers"."id" = "subscriptions"."customer_id" AND "customers"."name" ILIKE ${like})`,
    );
    if (match) conditions.push(match);
  }
  const where = conditions.length === 0 ? undefined : and(...conditions);

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(subscriptions)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);

  const rows = await db
    .select()
    .from(subscriptions)
    .where(where)
    .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id))
    .limit(limit)
    .offset((page - 1) * limit);

  const refs = await attachRefs(db, rows);
  return {
    items: rows.map((row) => ({
      subscription: subscriptionOf(row, refs.periodsBySubscription.get(row.id) ?? []),
      customer: refs.customersById.get(row.customerId) ?? null,
      product: refs.productsById.get(row.productId) ?? null,
    })),
    total,
  };
}

/** Renewal bucket as a SQL CASE (same definitions as `renewalBucketOf`). */
const bucketExpr = sql<string | null>`CASE WHEN "subscriptions"."status" = 'cancelled' THEN 'cancelled' WHEN "subscriptions"."status" = 'past_due' THEN 'failed' WHEN ("subscriptions"."next_renewal_at" AT TIME ZONE 'UTC')::date < (NOW() AT TIME ZONE 'UTC')::date THEN 'overdue' WHEN ("subscriptions"."next_renewal_at" AT TIME ZONE 'UTC')::date <= (NOW() AT TIME ZONE 'UTC')::date + 7 THEN 'due' WHEN ("subscriptions"."next_renewal_at" AT TIME ZONE 'UTC')::date <= (NOW() AT TIME ZONE 'UTC')::date + 30 THEN 'upcoming' ELSE NULL END`;

export async function listRenewals(
  source: ListSource,
  params: RenewalListParams,
): Promise<RenewalListResult> {
  const db = drizzleDbOf(source);
  if (db) return listRenewalsTargeted(db, params);
  return listRenewalsInMemory((source as StackMateDataStore).state, params);
}

/**
 * In-memory fallback — the pre-B-01 route logic, reproduced exactly:
 * bucket each subscription, drop unbucketed rows, apply the bucket
 * filter, q over subscription_number / customer name, sort nearest
 * renewal first (no renewal date → "9999-12-31", last), id ASC on
 * ties, total = full filtered count, page sliced after sorting.
 */
function listRenewalsInMemory(
  state: DatabaseState,
  params: RenewalListParams,
): RenewalListResult {
  const { q, limit, page, bucket } = params;
  const needle = q.toLowerCase();
  const todayDay = new Date().toISOString().slice(0, 10);
  const filtered = state.subscriptions
    .map((s) => ({ subscription: s, bucket: renewalBucketOf(s, todayDay) }))
    .filter((row) => row.bucket !== null)
    .filter((row) => (bucket ? row.bucket === bucket : true))
    .filter(
      (row) =>
        includesQuery(row.subscription.subscription_number, needle) ||
        includesQuery(
          state.customers.find((cu) => cu.id === row.subscription.customer_id)?.name,
          needle,
        ),
    )
    .sort((a, b) => {
      const aDay = renewalDayOf(a.subscription.next_renewal_at) ?? "9999-12-31";
      const bDay = renewalDayOf(b.subscription.next_renewal_at) ?? "9999-12-31";
      if (aDay !== bDay) return aDay < bDay ? -1 : 1;
      return a.subscription.id.localeCompare(b.subscription.id);
    });
  return {
    items: applyPage(filtered, limit, page).map((row) => ({
      subscription: row.subscription,
      customer:
        state.customers.find((cu) => cu.id === row.subscription.customer_id) ?? null,
      product:
        state.products.find((p) => p.id === row.subscription.product_id) ?? null,
      bucket: row.bucket as RenewalBucket,
    })),
    total: filtered.length,
  };
}

async function listRenewalsTargeted(
  db: ListDb,
  params: RenewalListParams,
): Promise<RenewalListResult> {
  const { q, limit, page, bucket } = params;
  const conditions: SQL[] = [sql`${bucketExpr} IS NOT NULL`];
  if (bucket) conditions.push(sql`${bucketExpr} = ${bucket}`);
  if (q !== "") {
    const like = `%${escapeLikePattern(q)}%`;
    const match = or(
      ilike(subscriptions.subscriptionNumber, like),
      sql`EXISTS (SELECT 1 FROM "customers" WHERE "customers"."id" = "subscriptions"."customer_id" AND "customers"."name" ILIKE ${like})`,
    );
    if (match) conditions.push(match);
  }
  const where = and(...conditions);

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(subscriptions)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);

  // Nearest renewal first; rows with no renewal date sort last
  // (the in-memory sort used "9999-12-31" for them), id ASC on ties.
  const rows = await db
    .select({ subscription: subscriptions, bucket: bucketExpr })
    .from(subscriptions)
    .where(where)
    .orderBy(
      sql`("subscriptions"."next_renewal_at" AT TIME ZONE 'UTC')::date ASC NULLS LAST`,
      asc(subscriptions.id),
    )
    .limit(limit)
    .offset((page - 1) * limit);

  const refs = await attachRefs(
    db,
    rows.map((r) => r.subscription),
  );
  return {
    items: rows.map(({ subscription, bucket: bucketValue }) => ({
      subscription: subscriptionOf(
        subscription,
        refs.periodsBySubscription.get(subscription.id) ?? [],
      ),
      customer: refs.customersById.get(subscription.customerId) ?? null,
      product: refs.productsById.get(subscription.productId) ?? null,
      bucket: bucketValue as RenewalBucket,
    })),
    total,
  };
}
