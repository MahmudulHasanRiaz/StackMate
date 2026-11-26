/**
 * B-01 targeted admin payment lists.
 *
 * Same contract as `modules/products/list.ts`: targeted Drizzle
 * queries against `store.drizzleDb` (never `store.state`), SQL WHERE /
 * ORDER BY / LIMIT / OFFSET + a separate COUNT, rows mapped to the
 * snake_case record shapes the in-memory lists returned.
 */
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../../db/schema/index.ts";
import {
  paymentMethodTransferRails,
  paymentMethods,
  paymentProviders,
  paymentRefunds,
  paymentSubmissions,
  paymentTransactions,
} from "../../../../../db/schema/payments.ts";
import type {
  DatabaseState,
  PaymentMethodRecord,
  PaymentProviderRecord,
  PaymentRefundRecord,
  PaymentSubmissionRecord,
  PaymentTransactionRecord,
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

export interface PaymentListParams {
  q: string;
  limit: number;
  page: number;
}

export interface PaymentListResult<T> {
  items: T[];
  total: number;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function countTotal(
  db: ListDb,
  table: typeof paymentProviders | typeof paymentMethods | typeof paymentRefunds,
  where: SQL | undefined,
): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(table as typeof paymentProviders)
    .where(where);
  return Number(rows[0]?.value ?? 0);
}

export async function listPaymentProviders(
  source: ListSource,
  params: PaymentListParams,
): Promise<PaymentListResult<PaymentProviderRecord>> {
  const db = drizzleDbOf(source);
  if (db) return listPaymentProvidersTargeted(db, params);
  // Pre-B-01 route logic, verbatim: display_name substring filter,
  // total = full filtered count, page sliced after filtering.
  // (PaymentProviderRecord has no created_at, so there is no sort —
  // same as the old route and the targeted query's tiebreak-free
  // order over seeded rows.)
  const { q, limit, page } = params;
  const needle = q.toLowerCase();
  const filtered = (source as StackMateDataStore).state.payment_providers.filter((p) =>
    includesQuery(p.display_name, needle),
  );
  return { items: applyPage(filtered, limit, page), total: filtered.length };
}

async function listPaymentProvidersTargeted(
  db: ListDb,
  params: PaymentListParams,
): Promise<PaymentListResult<PaymentProviderRecord>> {
  const { q, limit, page } = params;
  const where =
    q === ""
      ? undefined
      : ilike(paymentProviders.displayName, `%${escapeLikePattern(q)}%`);
  const total = await countTotal(db, paymentProviders, where);
  const rows = await db
    .select()
    .from(paymentProviders)
    .where(where)
    .orderBy(asc(paymentProviders.createdAt), asc(paymentProviders.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return {
    items: rows.map((row) => ({
      id: row.id,
      provider_key: row.providerKey,
      display_name: row.displayName,
      provider_type: row.providerType as PaymentProviderRecord["provider_type"],
      adapter_key: row.adapterKey,
      status: row.status as PaymentProviderRecord["status"],
    })),
    total,
  };
}

export async function listPaymentMethods(
  source: ListSource,
  params: PaymentListParams & { isEnabled?: boolean | null },
): Promise<PaymentListResult<PaymentMethodRecord>> {
  const db = drizzleDbOf(source);
  if (db) return listPaymentMethodsTargeted(db, params);
  // Pre-B-01 route logic, verbatim: is_enabled filter + display_name
  // substring filter, total = full filtered count, page sliced after
  // filtering. Rows are returned as stored.
  const { q, limit, page, isEnabled } = params;
  const needle = q.toLowerCase();
  const filtered = byCreatedAsc(
    (source as StackMateDataStore).state.payment_methods
      .filter((m) => (isEnabled === null || isEnabled === undefined ? true : m.is_enabled === isEnabled))
      .filter((m) => includesQuery(m.display_name, needle)),
  );
  return { items: applyPage(filtered, limit, page), total: filtered.length };
}

async function listPaymentMethodsTargeted(
  db: ListDb,
  params: PaymentListParams & { isEnabled?: boolean | null },
): Promise<PaymentListResult<PaymentMethodRecord>> {
  const { q, limit, page, isEnabled } = params;
  const conditions: SQL[] = [];
  if (isEnabled !== null && isEnabled !== undefined) {
    conditions.push(eq(paymentMethods.isEnabled, isEnabled));
  }
  if (q !== "") {
    conditions.push(ilike(paymentMethods.displayName, `%${escapeLikePattern(q)}%`));
  }
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const total = await countTotal(db, paymentMethods, where);
  const rows = await db
    .select()
    .from(paymentMethods)
    .where(where)
    .orderBy(asc(paymentMethods.createdAt), asc(paymentMethods.id))
    .limit(limit)
    .offset((page - 1) * limit);

  const ids = rows.map((r) => r.id);
  const railsByMethod = new Map<string, PaymentMethodRecord["transfer_rails"]>();
  if (ids.length > 0) {
    const railRows = await db
      .select()
      .from(paymentMethodTransferRails)
      .where(inArray(paymentMethodTransferRails.paymentMethodId, ids))
      .orderBy(
        asc(paymentMethodTransferRails.paymentMethodId),
        asc(paymentMethodTransferRails.railKey),
      );
    for (const rail of railRows) {
      const list = railsByMethod.get(rail.paymentMethodId) ?? [];
      list.push(rail.railKey as PaymentMethodRecord["transfer_rails"][number]);
      railsByMethod.set(rail.paymentMethodId, list);
    }
  }

  return {
    items: rows.map((row) => {
      const cfg =
        row.configuration !== null && typeof row.configuration === "object"
          ? (row.configuration as Record<string, unknown>)
          : {};
      const configuration: PaymentMethodRecord["configuration"] = {
        account_number:
          typeof cfg["account_number"] === "string" ? cfg["account_number"] : "",
        transaction_id_requirement: (
          cfg["transaction_id_requirement"] === "required" ||
          cfg["transaction_id_requirement"] === "optional" ||
          cfg["transaction_id_requirement"] === "disabled"
            ? cfg["transaction_id_requirement"]
            : "disabled"
        ) as PaymentMethodRecord["configuration"]["transaction_id_requirement"],
      };
      if (typeof cfg["account_holder_name"] === "string") {
        configuration.account_holder_name = cfg["account_holder_name"];
      }
      if (typeof cfg["bank_name"] === "string") configuration.bank_name = cfg["bank_name"];
      if (typeof cfg["branch_name"] === "string") {
        configuration.branch_name = cfg["branch_name"];
      }
      if (typeof cfg["routing_number"] === "string") {
        configuration.routing_number = cfg["routing_number"];
      }
      return {
        id: row.id,
        provider_id: row.providerId,
        method_key: row.methodKey,
        display_name: row.displayName,
        method_kind: row.methodKind as PaymentMethodRecord["method_kind"],
        account_type: row.accountType as PaymentMethodRecord["account_type"],
        account_label: row.accountLabel,
        instructions: row.instructions,
        configuration,
        transfer_rails: railsByMethod.get(row.id) ?? [],
        is_enabled: row.isEnabled,
        sort_order: row.sortOrder,
        created_at: row.createdAt.toISOString(),
      };
    }),
    total,
  };
}

export async function listPaymentRefunds(
  source: ListSource,
  params: PaymentListParams,
): Promise<PaymentListResult<PaymentRefundRecord>> {
  const db = drizzleDbOf(source);
  if (db) return listPaymentRefundsTargeted(db, params);
  // Pre-B-01 route logic, verbatim: id / payment_transaction_id /
  // reason / provider_refund_id substring filter, total = full
  // filtered count, page sliced after filtering.
  const { q, limit, page } = params;
  const needle = q.toLowerCase();
  const filtered = byCreatedAsc(
    (source as StackMateDataStore).state.payment_refunds.filter(
      (r) =>
        includesQuery(r.id, needle) ||
        includesQuery(r.payment_transaction_id, needle) ||
        includesQuery(r.reason, needle) ||
        includesQuery(r.provider_refund_id, needle),
    ),
  );
  return { items: applyPage(filtered, limit, page), total: filtered.length };
}

async function listPaymentRefundsTargeted(
  db: ListDb,
  params: PaymentListParams,
): Promise<PaymentListResult<PaymentRefundRecord>> {
  const { q, limit, page } = params;
  // UUID columns need a ::text cast for ILIKE (the old in-memory
  // filter did a substring match on the UUID string).
  const like = `%${escapeLikePattern(q)}%`;
  const where =
    q === ""
      ? undefined
      : or(
          sql`"payment_refunds"."id"::text ILIKE ${like}`,
          sql`"payment_refunds"."payment_transaction_id"::text ILIKE ${like}`,
          ilike(paymentRefunds.reason, like),
          ilike(paymentRefunds.providerRefundId, like),
        );
  const total = await countTotal(db, paymentRefunds, where);
  const rows = await db
    .select()
    .from(paymentRefunds)
    .where(where)
    .orderBy(asc(paymentRefunds.createdAt), asc(paymentRefunds.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return {
    items: rows.map((row) => ({
      id: row.id,
      payment_transaction_id: row.paymentTransactionId,
      amount_minor: row.amountMinor,
      currency_code: row.currencyCode,
      status: row.status as PaymentRefundRecord["status"],
      reason: row.reason,
      provider_refund_id: row.providerRefundId,
      requested_by_user_id: row.requestedByUserId,
      processed_by_user_id: row.processedByUserId,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    })),
    total,
  };
}

function submissionOf(row: typeof paymentSubmissions.$inferSelect): PaymentSubmissionRecord {
  return {
    id: row.id,
    order_id: row.orderId,
    customer_id: row.customerId,
    payment_method_id: row.paymentMethodId,
    installment_id: row.installmentId,
    amount_minor: row.amountMinor,
    currency_code: row.currencyCode,
    sender_name: row.senderName,
    sender_phone: row.senderPhone,
    sender_bank_name: row.senderBankName,
    sender_account_reference: row.senderAccountReference,
    transfer_rail_key: row.transferRailKey,
    transaction_reference: row.transactionReference,
    normalized_transaction_reference: row.normalizedTransactionReference,
    payment_date: row.paymentDate,
    proof_asset_id: row.proofAssetId,
    duplicate_risk_Warning: row.duplicateRiskWarning,
    status: row.status as PaymentSubmissionRecord["status"],
    customer_note: row.customerNote,
    submitted_at: row.submittedAt.toISOString(),
    reviewed_at: iso(row.reviewedAt),
    reviewed_by_user_id: row.reviewedByUserId,
  };
}

function transactionOf(row: typeof paymentTransactions.$inferSelect): PaymentTransactionRecord {
  return {
    id: row.id,
    order_id: row.orderId,
    payment_method_id: row.paymentMethodId,
    payment_submission_id: row.paymentSubmissionId,
    provider_id: row.providerId,
    provider_transaction_id: row.providerTransactionId,
    amount_minor: row.amountMinor,
    currency_code: row.currencyCode,
    status: row.status as PaymentTransactionRecord["status"],
    paid_at: iso(row.paidAt) ?? row.createdAt.toISOString(),
    verified_by_user_id: row.verifiedByUserId,
    verification_source:
      row.verificationSource as PaymentTransactionRecord["verification_source"],
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Customer-detail payments tab: { submissions, transactions } for
 * the customer's orders (same shape as the old in-memory handler).
 * Not paged, like the old handler.
 */
export async function listCustomerPayments(
  source: ListSource,
  customerId: string,
): Promise<{
  submissions: PaymentSubmissionRecord[];
  transactions: PaymentTransactionRecord[];
}> {
  const db = drizzleDbOf(source);
  if (!db) {
    // Pre-B-01 route logic, verbatim: submissions for the customer's
    // orders (state order), transactions for those submissions (state
    // order). Not paged, like the old handler.
    const state = (source as StackMateDataStore).state;
    const orderIds = new Set(
      state.orders.filter((o) => o.customer_id === customerId).map((o) => o.id),
    );
    const submissions = state.payment_submissions.filter((s) => orderIds.has(s.order_id));
    const submissionIds = new Set(submissions.map((s) => s.id));
    return {
      submissions,
      transactions: state.payment_transactions.filter(
        (t) =>
          t.payment_submission_id !== null &&
          submissionIds.has(t.payment_submission_id),
      ),
    };
  }
  return listCustomerPaymentsTargeted(db, customerId);
}

async function listCustomerPaymentsTargeted(
  db: ListDb,
  customerId: string,
): Promise<{
  submissions: PaymentSubmissionRecord[];
  transactions: PaymentTransactionRecord[];
}> {
  const orderRows = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.customerId, customerId));
  const orderIds = orderRows.map((r) => r.id);
  if (orderIds.length === 0) return { submissions: [], transactions: [] };
  const submissions = await db
    .select()
    .from(paymentSubmissions)
    .where(inArray(paymentSubmissions.orderId, orderIds))
    .orderBy(asc(paymentSubmissions.submittedAt), asc(paymentSubmissions.id));
  const submissionIds = submissions.map((s) => s.id);
  const transactions =
    submissionIds.length === 0
      ? []
      : await db
          .select()
          .from(paymentTransactions)
          .where(inArray(paymentTransactions.paymentSubmissionId, submissionIds))
          .orderBy(asc(paymentTransactions.createdAt), asc(paymentTransactions.id));
  return {
    submissions: submissions.map(submissionOf),
    transactions: transactions.map(transactionOf),
  };
}
