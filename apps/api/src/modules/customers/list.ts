/**
 * B-01 targeted admin customer lists.
 *
 * Same contract as `modules/products/list.ts`: targeted Drizzle
 * queries against `store.drizzleDb` (never `store.state`), SQL WHERE /
 * ORDER BY / LIMIT / OFFSET + a separate COUNT, rows mapped to the
 * snake_case record shapes the in-memory lists returned.
 *
 * Ordering mirrors the combined load: created_at ASC, id ASC — except
 * reports (created_at DESC, id ASC) and activity (see below).
 */
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../../db/schema/index.ts";
import {
  customerAddresses,
  customerReports,
  customers,
} from "../../../../../db/schema/customers.ts";
import { auditLogs } from "../../../../../db/schema/audit.ts";
import { supportTickets } from "../../../../../db/schema/tickets.ts";
import type {
  AuditLogRecord,
  CustomerAddressRecord,
  CustomerRecord,
  CustomerReportRecord,
  DatabaseState,
  StackMateDataStore,
  SupportTicketRecord,
} from "../../platform/db/store.ts";
import { toCustomerAddressDto, type CustomerAddressDto } from "./service.ts";

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

function matchesPhoneQuery(
  phone: string | null | undefined,
  normalizedPhone: string | null | undefined,
  q: string,
): boolean {
  if (!q) return true;
  if (includesQuery(phone, q)) return true;
  const digits = q.replace(/\D/g, "");
  if (!digits) return false;
  return (normalizedPhone ?? "").replace(/\D/g, "").includes(digits);
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

export interface CustomerListParams {
  q: string;
  limit: number;
  page: number;
}

export interface CustomerListItem extends CustomerRecord {
  report_count: number;
  has_concern_report: boolean;
}

export interface CustomerListResult {
  items: CustomerListItem[];
  total: number;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

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

export async function listCustomers(
  source: ListSource,
  params: CustomerListParams,
): Promise<CustomerListResult> {
  const db = drizzleDbOf(source);
  if (db) return listCustomersTargeted(db, params);
  return listCustomersInMemory((source as StackMateDataStore).state, params);
}

/**
 * In-memory fallback — the pre-B-01 route logic, reproduced exactly:
 * name/email/customer_number/company_name/phone substring filter,
 * report_count + has_concern_report from state, total = full filtered
 * count, page sliced after filtering. Sorted created_at ASC, id ASC
 * (the targeted order; identical to insertion order for sequentially
 * seeded rows, deterministic otherwise).
 */
function listCustomersInMemory(
  state: DatabaseState,
  params: CustomerListParams,
): CustomerListResult {
  const { q, limit, page } = params;
  const needle = q.toLowerCase();
  const filtered = byCreatedAsc(
    state.customers.filter(
      (c) =>
        includesQuery(c.name, needle) ||
        includesQuery(c.email, needle) ||
        includesQuery(c.customer_number, needle) ||
        includesQuery(c.company_name, needle) ||
        matchesPhoneQuery(c.phone, c.normalized_phone, needle),
    ),
  );
  return {
    items: applyPage(filtered, limit, page).map((c) => ({
      ...c,
      report_count: state.customer_reports.filter((r) => r.customer_id === c.id).length,
      has_concern_report: state.customer_reports.some(
        (r) => r.customer_id === c.id && r.type === "concern",
      ),
    })),
    total: filtered.length,
  };
}

async function listCustomersTargeted(
  db: ListDb,
  params: CustomerListParams,
): Promise<CustomerListResult> {
  const { q, limit, page } = params;
  const conditions: SQL[] = [];
  if (q !== "") {
    const like = `%${escapeLikePattern(q)}%`;
    // matchesPhoneQuery: raw-phone substring, or the query's digits
    // inside the digits of normalized_phone.
    const digits = q.replace(/\D/g, "");
    const phoneMatch =
      digits === ""
        ? ilike(customers.phone, like)
        : or(
            ilike(customers.phone, like),
            sql`regexp_replace("customers"."normalized_phone", '\\D', '', 'g') ILIKE ${`%${digits}%`}`,
          );
    const match = or(
      ilike(customers.name, like),
      ilike(customers.email, like),
      ilike(customers.customerNumber, like),
      ilike(customers.companyName, like),
      phoneMatch,
    );
    if (match) conditions.push(match);
  }
  const where = conditions.length === 0 ? undefined : and(...conditions);

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(customers)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);

  const rows = await db
    .select()
    .from(customers)
    .where(where)
    .orderBy(asc(customers.createdAt), asc(customers.id))
    .limit(limit)
    .offset((page - 1) * limit);

  const ids = rows.map((r) => r.id);
  const reportCount = new Map<string, number>();
  const concernCount = new Map<string, number>();
  if (ids.length > 0) {
    const counts = await db
      .select({
        customerId: customerReports.customerId,
        total: sql<number>`count(*)`,
        concerns: sql<number>`count(*) FILTER (WHERE "customer_reports"."type" = 'concern')`,
      })
      .from(customerReports)
      .where(inArray(customerReports.customerId, ids))
      .groupBy(customerReports.customerId);
    for (const row of counts) {
      reportCount.set(row.customerId, Number(row.total));
      concernCount.set(row.customerId, Number(row.concerns));
    }
  }

  return {
    items: rows.map((row) => ({
      ...customerOf(row),
      report_count: reportCount.get(row.id) ?? 0,
      has_concern_report: (concernCount.get(row.id) ?? 0) > 0,
    })),
    total,
  };
}

export async function customerExists(source: ListSource, id: string): Promise<boolean> {
  const db = drizzleDbOf(source);
  if (!db) return (source as StackMateDataStore).state.customers.some((c) => c.id === id);
  return customerExistsTargeted(db, id);
}

async function customerExistsTargeted(db: ListDb, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, id))
    .limit(1);
  return rows.length > 0;
}

function addressOf(row: typeof customerAddresses.$inferSelect): CustomerAddressRecord {
  return {
    id: row.id,
    customer_id: row.customerId,
    address_type: row.addressType as CustomerAddressRecord["address_type"],
    contact_name: row.contactName,
    phone: row.phone,
    address_line_1: row.addressLine1,
    address_line_2: row.addressLine2,
    city: row.city,
    state_or_region: row.stateOrRegion,
    postal_code: row.postalCode,
    country_code: row.countryCode ?? "BD",
    is_default: row.isDefault,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Customer addresses, default first (the in-memory list sorted
 * is_default first, stable otherwise). Returns the same DTOs
 * `listCustomerAddresses` returned.
 */
export async function listCustomerAddressesTargeted(
  source: ListSource,
  customerId: string,
): Promise<CustomerAddressDto[]> {
  const db = drizzleDbOf(source);
  if (!db) {
    // Pre-B-01 `listCustomerAddresses` service logic, verbatim:
    // filter + stable is_default-first sort, then DTOs.
    const state = (source as StackMateDataStore).state;
    return state.customer_addresses
      .filter((a) => a.customer_id === customerId)
      .sort((a, b) => (a.is_default === b.is_default ? 0 : a.is_default ? -1 : 1))
      .map(toCustomerAddressDto);
  }
  return listCustomerAddressesSql(db, customerId);
}

async function listCustomerAddressesSql(
  db: ListDb,
  customerId: string,
): Promise<CustomerAddressDto[]> {
  const rows = await db
    .select()
    .from(customerAddresses)
    .where(eq(customerAddresses.customerId, customerId))
    .orderBy(
      desc(customerAddresses.isDefault),
      asc(customerAddresses.createdAt),
      asc(customerAddresses.id),
    );
  return rows.map((row) => toCustomerAddressDto(addressOf(row)));
}

/** Customer reports, newest first (the in-memory list's sort). */
export async function listCustomerReportsTargeted(
  source: ListSource,
  customerId: string,
): Promise<CustomerReportRecord[]> {
  const db = drizzleDbOf(source);
  if (!db) {
    // Pre-B-01 `listCustomerReports` service logic, verbatim:
    // filter + created_at DESC sort (same comparator, incl. its
    // equal-timestamp behaviour).
    const state = (source as StackMateDataStore).state;
    return state.customer_reports
      .filter((r) => r.customer_id === customerId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  return listCustomerReportsSql(db, customerId);
}

async function listCustomerReportsSql(
  db: ListDb,
  customerId: string,
): Promise<CustomerReportRecord[]> {
  const rows = await db
    .select()
    .from(customerReports)
    .where(eq(customerReports.customerId, customerId))
    .orderBy(desc(customerReports.createdAt), asc(customerReports.id));
  return rows.map((row) => ({
    id: row.id,
    customer_id: row.customerId,
    author_user_id: row.authorUserId,
    type: row.type as CustomerReportRecord["type"],
    detail: row.detail,
    created_at: row.createdAt.toISOString(),
  }));
}

export interface CustomerActivityResult {
  items: AuditLogRecord[];
  total: number;
}

export async function listCustomerActivity(
  source: ListSource,
  customerId: string,
  params: { limit: number; page: number },
): Promise<CustomerActivityResult> {
  const db = drizzleDbOf(source);
  if (!db) {
    // Pre-B-01 route logic, verbatim: filter the audit list for rows
    // touching the customer or their orders/subscriptions/licenses,
    // take `.slice(-100)` (the last 100 in list order) and reverse it
    // (newest first), then page-slice; total is the windowed length.
    const { limit, page } = params;
    const state = (source as StackMateDataStore).state;
    const orderIds = new Set(
      state.orders.filter((o) => o.customer_id === customerId).map((o) => o.id),
    );
    const subIds = new Set(
      state.subscriptions.filter((s) => s.customer_id === customerId).map((s) => s.id),
    );
    const licenseIds = new Set(
      state.licenses.filter((l) => l.customer_id === customerId).map((l) => l.id),
    );
    const filtered = state.audit_logs
      .filter(
        (a) =>
          a.resource_id === customerId ||
          (a.resource_type === "order" && orderIds.has(a.resource_id)) ||
          (a.resource_type === "subscription" && subIds.has(a.resource_id)) ||
          (a.resource_type === "license" && licenseIds.has(a.resource_id)),
      )
      .slice(-100)
      .reverse();
    return {
      items: filtered.slice((page - 1) * limit, page * limit),
      total: filtered.length,
    };
  }
  return listCustomerActivitySql(db, customerId, params);
}

/**
 * Customer activity (audit rows touching the customer or their
 * orders/subscriptions/licenses).
 *
 * Faithful to the pre-wiring behaviour, quirk included: the old code
 * filtered the DESC-loaded audit list, took `.slice(-100)` (the
 * OLDEST 100 matches) and reversed it — so the list is the oldest
 * 100 matches, oldest first. The SQL below is exactly that window.
 */
async function listCustomerActivitySql(
  db: ListDb,
  customerId: string,
  params: { limit: number; page: number },
): Promise<CustomerActivityResult> {
  const { limit, page } = params;
  const idSets = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.customerId, customerId));
  const orderIds = idSets.map((r) => r.id);
  const subSets = await db
    .select({ id: schema.subscriptions.id })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.customerId, customerId));
  const subIds = subSets.map((r) => r.id);
  const licSets = await db
    .select({ id: schema.licenses.id })
    .from(schema.licenses)
    .where(eq(schema.licenses.customerId, customerId));
  const licenseIds = licSets.map((r) => r.id);

  const match = or(
    eq(auditLogs.resourceId, customerId),
    orderIds.length > 0
      ? and(
          eq(auditLogs.resourceType, "order"),
          inArray(auditLogs.resourceId, orderIds),
        )
      : undefined,
    subIds.length > 0
      ? and(
          eq(auditLogs.resourceType, "subscription"),
          inArray(auditLogs.resourceId, subIds),
        )
      : undefined,
    licenseIds.length > 0
      ? and(
          eq(auditLogs.resourceType, "license"),
          inArray(auditLogs.resourceId, licenseIds),
        )
      : undefined,
  );
  const where = match ? and(match) : undefined;

  // Oldest 100 matches, oldest first (see doc comment above).
  const rows = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
    .limit(100);
  const total = rows.length;
  const pageItems = rows.slice((page - 1) * limit, page * limit);
  return {
    items: pageItems.map((row) => ({
      id: row.id,
      actor_type: row.actorType as AuditLogRecord["actor_type"],
      actor_user_id: row.actorUserId,
      integrated_site_id: row.integratedSiteId,
      action: row.action,
      resource_type: row.resourceType,
      resource_id: row.resourceId,
      outcome: row.outcome as AuditLogRecord["outcome"],
      request_id: row.requestId ?? "",
      changes:
        row.changes !== null && typeof row.changes === "object" && !Array.isArray(row.changes)
          ? (row.changes as Record<string, unknown>)
          : {},
      created_at: row.createdAt.toISOString(),
    })),
    total,
  };
}

/** Customer support tickets, load order (created_at ASC, id ASC). */
export async function listCustomerTickets(
  source: ListSource,
  customerId: string,
  params: { limit: number; page: number },
): Promise<{ items: SupportTicketRecord[]; total: number }> {
  const db = drizzleDbOf(source);
  if (!db) {
    // Pre-B-01 route logic, verbatim: filter by customer, state
    // (load) order, page-slice after filtering.
    const { limit, page } = params;
    const state = (source as StackMateDataStore).state;
    const filtered = state.support_tickets.filter((t) => t.customer_id === customerId);
    return {
      items: filtered.slice((page - 1) * limit, page * limit),
      total: filtered.length,
    };
  }
  return listCustomerTicketsSql(db, customerId, params);
}

async function listCustomerTicketsSql(
  db: ListDb,
  customerId: string,
  params: { limit: number; page: number },
): Promise<{ items: SupportTicketRecord[]; total: number }> {
  const { limit, page } = params;
  const where = eq(supportTickets.customerId, customerId);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(supportTickets)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const rows = await db
    .select()
    .from(supportTickets)
    .where(where)
    .orderBy(asc(supportTickets.createdAt), asc(supportTickets.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return {
    items: rows.map((row) => ({
      id: row.id,
      ticket_number: row.ticketNumber,
      customer_id: row.customerId,
      order_id: row.orderId,
      subscription_id: row.subscriptionId,
      license_id: row.licenseId,
      product_id: row.productId,
      title: row.title,
      description: row.description ?? "",
      status: row.status as SupportTicketRecord["status"],
      priority: row.priority as SupportTicketRecord["priority"],
      category: row.category as SupportTicketRecord["category"],
      reporter_user_id: row.reporterUserId,
      source_note: row.sourceNote,
      assignee_user_id: row.assigneeUserId,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      closed_at: row.closedAt ? row.closedAt.toISOString() : null,
    })),
    total,
  };
}
