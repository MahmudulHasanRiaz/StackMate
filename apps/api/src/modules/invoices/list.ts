/**
 * B-01 targeted admin invoice + installment lists.
 *
 * Same contract as `modules/products/list.ts`: targeted Drizzle
 * queries against `store.drizzleDb` (never `store.state`), SQL WHERE /
 * ORDER BY / LIMIT / OFFSET + a separate COUNT, rows mapped to the
 * snake_case record shapes the in-memory lists returned.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../../db/schema/index.ts";
import { invoiceItems, invoices } from "../../../../../db/schema/invoices.ts";
import { orderInstallments } from "../../../../../db/schema/orders.ts";
import type {
  DatabaseState,
  InvoiceRecord,
  OrderInstallmentRecord,
  StackMateDataStore,
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

export interface InvoiceListParams {
  q: string;
  limit: number;
  page: number;
  /** Order scope (GET /admin/orders/:orderId/invoices). */
  orderId?: string | null;
}

export interface InvoiceListResult {
  items: InvoiceRecord[];
  total: number;
}

export interface InstallmentListResult {
  items: OrderInstallmentRecord[];
  total: number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function listInvoices(
  source: ListSource,
  params: InvoiceListParams,
): Promise<InvoiceListResult> {
  const db = drizzleDbOf(source);
  if (db) return listInvoicesTargeted(db, params);
  // Pre-B-01 route logic, verbatim: all invoices (or the order's),
  // total = full filtered count, page sliced after filtering. Rows
  // are returned as stored (items embedded).
  const { limit, page, orderId } = params;
  const filtered = byCreatedAsc(
    (source as StackMateDataStore).state.invoices.filter((i) =>
      orderId ? i.order_id === orderId : true,
    ),
  );
  return { items: applyPage(filtered, limit, page), total: filtered.length };
}

async function listInvoicesTargeted(
  db: ListDb,
  params: InvoiceListParams,
): Promise<InvoiceListResult> {
  const { limit, page, orderId } = params;
  const where = orderId ? eq(invoices.orderId, orderId) : undefined;

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(invoices)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);

  const rows = await db
    .select()
    .from(invoices)
    .where(where)
    .orderBy(asc(invoices.createdAt), asc(invoices.id))
    .limit(limit)
    .offset((page - 1) * limit);

  const ids = rows.map((r) => r.id);
  const itemsByInvoice = new Map<string, InvoiceRecord["items"]>();
  if (ids.length > 0) {
    const itemRows = await db
      .select()
      .from(invoiceItems)
      .where(inArray(invoiceItems.invoiceId, ids))
      .orderBy(
        asc(invoiceItems.invoiceId),
        asc(invoiceItems.createdAt),
        asc(invoiceItems.id),
      );
    for (const it of itemRows) {
      const list = itemsByInvoice.get(it.invoiceId) ?? [];
      list.push({
        id: it.id,
        description_snapshot: it.descriptionSnapshot,
        quantity: it.quantity,
        unit_amount_minor: it.unitAmountMinor,
        line_amount_minor: it.lineAmountMinor,
        currency_code: it.currencyCode,
      });
      itemsByInvoice.set(it.invoiceId, list);
    }
  }

  return {
    items: rows.map((row) => ({
      id: row.id,
      invoice_number: row.invoiceNumber,
      customer_id: row.customerId,
      order_id: row.orderId,
      subscription_id: row.subscriptionId,
      invoice_type: row.invoiceType as InvoiceRecord["invoice_type"],
      status: row.status as InvoiceRecord["status"],
      currency_code: row.currencyCode,
      subtotal_minor: row.subtotalMinor,
      discount_minor: row.discountMinor,
      tax_minor: row.taxMinor,
      total_minor: row.totalMinor,
      amount_paid_minor: row.amountPaidMinor,
      amount_due_minor: row.amountDueMinor,
      issued_at: row.issuedAt.toISOString(),
      paid_at: iso(row.paidAt),
      items: itemsByInvoice.get(row.id) ?? [],
      created_at: row.createdAt.toISOString(),
    })),
    total,
  };
}

export async function listOrderInstallments(
  source: ListSource,
  orderId: string,
  params: { limit: number; page: number },
): Promise<InstallmentListResult> {
  const db = drizzleDbOf(source);
  if (db) return listOrderInstallmentsTargeted(db, orderId, params);
  // Pre-B-01 route logic, verbatim: the order's installments sorted
  // by installment_number, total = full filtered count, page sliced
  // after sorting.
  const { limit, page } = params;
  const filtered = (source as StackMateDataStore).state.order_installments
    .filter((i) => i.order_id === orderId)
    .sort((a, b) => a.installment_number - b.installment_number);
  return { items: applyPage(filtered, limit, page), total: filtered.length };
}

async function listOrderInstallmentsTargeted(
  db: ListDb,
  orderId: string,
  params: { limit: number; page: number },
): Promise<InstallmentListResult> {
  const { limit, page } = params;
  const where = eq(orderInstallments.orderId, orderId);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(orderInstallments)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const rows = await db
    .select()
    .from(orderInstallments)
    .where(where)
    .orderBy(asc(orderInstallments.installmentNumber))
    .limit(limit)
    .offset((page - 1) * limit);
  return {
    items: rows.map((row) => ({
      id: row.id,
      order_id: row.orderId,
      installment_number: row.installmentNumber,
      amount_minor: row.amountMinor,
      due_date: row.dueDate,
      status: row.status as OrderInstallmentRecord["status"],
      paid_amount_minor: row.paidAmountMinor,
      paid_at: iso(row.paidAt),
      notes: row.notes,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    })),
    total,
  };
}

/** Targeted existence check (for list routes that 404 on a missing parent). */
export async function invoiceExists(source: ListSource, id: string): Promise<boolean> {
  const db = drizzleDbOf(source);
  if (!db) return (source as StackMateDataStore).state.invoices.some((i) => i.id === id);
  return invoiceExistsTargeted(db, id);
}

async function invoiceExistsTargeted(db: ListDb, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.id, id))
    .limit(1);
  return rows.length > 0;
}
