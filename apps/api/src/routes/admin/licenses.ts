/**
 * Admin license routes (Hono) — Hono migration Phase 1.
 *
 * Converted verbatim from the hand-rolled dispatcher in
 * apps/api/src/app.ts (baseline feat e382d65, lines ~6160–6460):
 * admin license list/detail, manual grants, signing-key lifecycle
 * (list/rotate/revoke), activations (list/deactivate/transfer),
 * suspend/resume/revoke actions, entitlement snapshots. Service
 * layer, validators and envelopes are unchanged — only the HTTP
 * plumbing moved. Auth / CSRF / rate-limit middleware (Worker 3,
 * hono/*) provides c.var.requestId / env / store / principal; the
 * per-route permission checks below are preserved from app.ts.
 */
import { randomUUID } from "node:crypto";
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
import { appendAuditLog } from "../../modules/audit/service.ts";
import {
  appendLicenseEntitlementSnapshotByAdmin,
  createManualLicenseGrantByAdmin,
  deactivateLicenseActivationByAdmin,
  transferActivation,
  transitionLicenseStatusByAdmin,
} from "../../modules/licensing/service.ts";

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

function parseTimestampSort(
  query: Record<string, string | undefined>,
  field: string
): "desc" | "asc" {
  return query.sort === `${field}:asc` ? "asc" : "desc";
}

// --- B-01 targeted license lists -------------------------------------------
// The license list (+ activations + customer installations) runs
// targeted Drizzle queries against `store.drizzleDb` — never
// `store.state` — so it is safe on a `createTargeted()` store. Rows
// are mapped to the same snake_case record shapes the in-memory list
// returned (Drizzle rows are camelCase + Date). `listLicenses` is
// exported for the customer-detail licenses list (same assembly, no
// list-only reference fields).

import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../../db/schema/index.ts";
import {
  licenseActivations,
  licenseEntitlementSnapshotItems,
  licenseEntitlementSnapshots,
  licenses,
} from "../../../../../db/schema/licenses.ts";
import { customers } from "../../../../../db/schema/customers.ts";
import { products } from "../../../../../db/schema/catalog.ts";
import type {
  DatabaseState,
  LicenseActivationRecord,
  LicenseEntitlementSnapshotRecord,
  LicenseRecord,
  StackMateDataStore,
} from "../../platform/db/store.ts";

export type LicenseListDb = NodePgDatabase<typeof schema>;

/**
 * First argument accepted by the list functions in this file.
 *
 * Routes pass the request store; `b01-lists.test.ts` passes a raw
 * Drizzle db. A store WITH `drizzleDb` (targeted / full DrizzleStore)
 * takes the targeted SQL path; a plain in-memory store (state only)
 * takes the in-memory fallback; a raw db is used directly.
 */
export type ListSource = StackMateDataStore | LicenseListDb;

function drizzleDbOf(source: ListSource): LicenseListDb | null {
  const maybe = source as { drizzleDb?: LicenseListDb; state?: DatabaseState };
  if (maybe.drizzleDb) return maybe.drizzleDb;
  if (maybe.state) return null;
  return source as LicenseListDb;
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

export type SafeLicenseRecord = Omit<LicenseRecord, "license_key_hash" | "issued_raw_key_once">;

export interface LicenseListRef {
  customer_name: string | null;
  product_code: string | null;
  product_name: string | null;
  active_activations_count: number;
}

export interface LicenseListResult {
  items: SafeLicenseRecord[];
  total: number;
  refs: Map<string, LicenseListRef>;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

function licenseActivationOf(
  row: typeof licenseActivations.$inferSelect,
): LicenseActivationRecord {
  return {
    id: row.id,
    license_id: row.licenseId,
    installation_id_hash: row.installationIdHash,
    domain_normalized: row.domainNormalized,
    environment: row.environment as LicenseActivationRecord["environment"],
    status: row.status as LicenseActivationRecord["status"],
    activated_at: row.activatedAt.toISOString(),
    last_seen_at: row.lastSeenAt
      ? row.lastSeenAt.toISOString()
      : row.activatedAt.toISOString(),
    deactivated_at: isoOrNull(row.deactivatedAt),
    metadata:
      row.metadata !== null && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    created_at: row.createdAt.toISOString(),
  };
}

function safeLicenseOf(
  row: typeof licenses.$inferSelect,
  snapshots: LicenseEntitlementSnapshotRecord[],
  activations: LicenseActivationRecord[],
): SafeLicenseRecord {
  return {
    id: row.id,
    license_number: row.licenseNumber,
    product_id: row.productId,
    customer_id: row.customerId,
    source_order_item_id: row.sourceOrderItemId,
    subscription_id: row.subscriptionId,
    license_key_hint: row.licenseKeyHint,
    status: row.status as SafeLicenseRecord["status"],
    activation_limit: row.activationLimit,
    valid_from: row.validFrom.toISOString(),
    expires_at: isoOrNull(row.expiresAt),
    grace_until: isoOrNull(row.graceUntil),
    current_entitlement_snapshot_id:
      row.currentEntitlementSnapshotId ?? snapshots[0]?.id ?? "",
    snapshots,
    activations,
    issued_at: row.issuedAt ? row.issuedAt.toISOString() : row.createdAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function listLicenses(
  source: ListSource,
  params: {
    q: string;
    limit: number;
    page: number;
    sort?: "asc" | "desc";
    customerId?: string | null;
  },
): Promise<LicenseListResult> {
  const db = drizzleDbOf(source);
  if (db) return listLicensesTargeted(db, params);
  return listLicensesInMemory((source as StackMateDataStore).state, params);
}

/**
 * In-memory fallback — the pre-B-01 route logic, reproduced exactly:
 * license_number / customer-name / product-code substring filter,
 * sort by created_at (default desc) with id ASC tiebreak, safe
 * records (no license_key_hash / issued_raw_key_once), refs
 * (customer_name, product_code, product_name,
 * active_activations_count) for the page rows, total = full filtered
 * count, page sliced after sorting.
 */
function listLicensesInMemory(
  state: DatabaseState,
  params: {
    q: string;
    limit: number;
    page: number;
    sort?: "asc" | "desc";
    customerId?: string | null;
  },
): LicenseListResult {
  const { q, limit, page, sort = "desc", customerId } = params;
  const needle = q.toLowerCase();
  const filtered = state.licenses
    .filter((l) => (customerId ? l.customer_id === customerId : true))
    .filter(
      (l) =>
        includesQuery(l.license_number, needle) ||
        includesQuery(
          state.customers.find((cu) => cu.id === l.customer_id)?.name,
          needle,
        ) ||
        includesQuery(
          state.products.find((p) => p.id === l.product_id)?.code,
          needle,
        ),
    );
  const sorted = sortByTimestamp(filtered, "created_at", sort);
  const pageItems = applyPage(sorted, limit, page);
  const refs = new Map<string, LicenseListRef>();
  const items = pageItems.map((l) => {
    const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = l;
    const customer = state.customers.find((cu) => cu.id === l.customer_id);
    const product = state.products.find((p) => p.id === l.product_id);
    refs.set(l.id, {
      customer_name: customer?.name ?? null,
      product_code: product?.code ?? null,
      product_name: product?.name ?? null,
      active_activations_count: l.activations.filter((a) => a.status === "active").length,
    });
    return safe;
  });
  return { items, total: filtered.length, refs };
}

async function listLicensesTargeted(
  db: LicenseListDb,
  params: {
    q: string;
    limit: number;
    page: number;
    sort?: "asc" | "desc";
    customerId?: string | null;
  },
): Promise<LicenseListResult> {
  const { q, limit, page, sort = "desc", customerId } = params;
  const conditions: SQL[] = [];
  if (customerId) conditions.push(eq(licenses.customerId, customerId));
  if (q !== "") {
    const like = `%${escapeLikePattern(q)}%`;
    const match = or(
      ilike(licenses.licenseNumber, like),
      sql`EXISTS (SELECT 1 FROM "customers" WHERE "customers"."id" = "licenses"."customer_id" AND "customers"."name" ILIKE ${like})`,
      sql`EXISTS (SELECT 1 FROM "products" WHERE "products"."id" = "licenses"."product_id" AND "products"."code" ILIKE ${like})`,
    );
    if (match) conditions.push(match);
  }
  const where = conditions.length === 0 ? undefined : and(...conditions);

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(licenses)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);

  const orderBy =
    sort === "asc"
      ? [asc(licenses.createdAt), asc(licenses.id)]
      : [desc(licenses.createdAt), asc(licenses.id)];
  const rows = await db
    .select()
    .from(licenses)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset((page - 1) * limit);

  const ids = rows.map((r) => r.id);
  const snapshotsByLicense = new Map<string, LicenseEntitlementSnapshotRecord[]>();
  const activationsByLicense = new Map<string, LicenseActivationRecord[]>();
  const refs = new Map<string, LicenseListRef>();
  if (ids.length > 0) {
    const snapshotRows = await db
      .select()
      .from(licenseEntitlementSnapshots)
      .where(inArray(licenseEntitlementSnapshots.licenseId, ids))
      .orderBy(
        asc(licenseEntitlementSnapshots.licenseId),
        asc(licenseEntitlementSnapshots.versionNumber),
      );
    const snapshotIds = snapshotRows.map((r) => r.id);
    const snapshotItemsBySnapshot = new Map<
      string,
      LicenseEntitlementSnapshotRecord["items"]
    >();
    if (snapshotIds.length > 0) {
      const snapshotItemRows = await db
        .select()
        .from(licenseEntitlementSnapshotItems)
        .where(inArray(licenseEntitlementSnapshotItems.snapshotId, snapshotIds))
        .orderBy(
          asc(licenseEntitlementSnapshotItems.snapshotId),
          asc(licenseEntitlementSnapshotItems.featureKeySnapshot),
        );
      for (const it of snapshotItemRows) {
        const list = snapshotItemsBySnapshot.get(it.snapshotId) ?? [];
        list.push({
          feature_key_snapshot: it.featureKeySnapshot,
          value_type_snapshot:
            it.valueTypeSnapshot as LicenseEntitlementSnapshotRecord["items"][number]["value_type_snapshot"],
          entitlement_value: it.entitlementValue ?? null,
          unit_snapshot: it.unitSnapshot,
        });
        snapshotItemsBySnapshot.set(it.snapshotId, list);
      }
    }
    for (const s of snapshotRows) {
      const list = snapshotsByLicense.get(s.licenseId) ?? [];
      list.push({
        id: s.id,
        license_id: s.licenseId,
        version_number: s.versionNumber,
        source_type: s.sourceType as LicenseEntitlementSnapshotRecord["source_type"],
        effective_at: s.effectiveAt.toISOString(),
        reason: s.reason,
        snapshot_hash: s.snapshotHash,
        items: snapshotItemsBySnapshot.get(s.id) ?? [],
        created_by_user_id: s.createdByUserId,
        created_at: s.createdAt.toISOString(),
      });
      snapshotsByLicense.set(s.licenseId, list);
    }
    const activationRows = await db
      .select()
      .from(licenseActivations)
      .where(inArray(licenseActivations.licenseId, ids))
      .orderBy(
        asc(licenseActivations.licenseId),
        asc(licenseActivations.activatedAt),
        asc(licenseActivations.id),
      );
    for (const a of activationRows) {
      const list = activationsByLicense.get(a.licenseId) ?? [];
      list.push(licenseActivationOf(a));
      activationsByLicense.set(a.licenseId, list);
    }
    const customerRows = await db
      .select()
      .from(customers)
      .where(
        inArray(
          customers.id,
          [...new Set(rows.map((r) => r.customerId))],
        ),
      );
    const customersById = new Map(customerRows.map((cu) => [cu.id, cu]));
    const productRows = await db
      .select()
      .from(products)
      .where(
        inArray(
          products.id,
          [...new Set(rows.map((r) => r.productId))],
        ),
      );
    const productsById = new Map(productRows.map((p) => [p.id, p]));
    for (const row of rows) {
      const customer = customersById.get(row.customerId);
      const product = productsById.get(row.productId);
      const activations = activationsByLicense.get(row.id) ?? [];
      refs.set(row.id, {
        customer_name: customer?.name ?? null,
        product_code: product?.code ?? null,
        product_name: product?.name ?? null,
        active_activations_count: activations.filter((a) => a.status === "active").length,
      });
    }
  }

  return {
    items: rows.map((row) =>
      safeLicenseOf(
        row,
        snapshotsByLicense.get(row.id) ?? [],
        activationsByLicense.get(row.id) ?? [],
      ),
    ),
    total,
    refs,
  };
}

/** One license's activations, load order (activated_at ASC, id ASC). */
export async function listLicenseActivations(
  source: ListSource,
  licenseId: string,
  params: { limit: number; page: number },
): Promise<{ items: LicenseActivationRecord[]; total: number }> {
  const db = drizzleDbOf(source);
  if (!db) {
    // Pre-B-01 route logic, verbatim: the license's activations in
    // stored order, page-sliced; total = full count. (The route's
    // existence check 404s on a missing license first.)
    const { limit, page } = params;
    const state = (source as StackMateDataStore).state;
    const lic = state.licenses.find((l) => l.id === licenseId);
    const activations = lic ? lic.activations : [];
    return {
      items: activations.slice((page - 1) * limit, page * limit),
      total: activations.length,
    };
  }
  return listLicenseActivationsTargeted(db, licenseId, params);
}

async function listLicenseActivationsTargeted(
  db: LicenseListDb,
  licenseId: string,
  params: { limit: number; page: number },
): Promise<{ items: LicenseActivationRecord[]; total: number }> {
  const { limit, page } = params;
  const where = eq(licenseActivations.licenseId, licenseId);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(licenseActivations)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const rows = await db
    .select()
    .from(licenseActivations)
    .where(where)
    .orderBy(asc(licenseActivations.activatedAt), asc(licenseActivations.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { items: rows.map(licenseActivationOf), total };
}

export interface InstallationListItem extends LicenseActivationRecord {
  license_number: string;
  product_id: string;
}

/**
 * Customer installations: the customer's licenses' activations,
 * flattened in license load order (created_at ASC, id ASC), each
 * carrying its license_number + product_id. Customer-scoped, so the
 * flatten + page slice run over the customer's rows only.
 */
export async function listCustomerInstallations(
  source: ListSource,
  customerId: string,
  params: { limit: number; page: number },
): Promise<{ items: InstallationListItem[]; total: number }> {
  const db = drizzleDbOf(source);
  if (!db) {
    // Pre-B-01 route logic, verbatim: the customer's licenses'
    // activations flattened in license state order, each carrying its
    // license_number + product_id, page-sliced after flattening.
    const { limit, page } = params;
    const state = (source as StackMateDataStore).state;
    const all: InstallationListItem[] = state.licenses
      .filter((l) => l.customer_id === customerId)
      .flatMap((l) =>
        l.activations.map((a) => ({
          ...a,
          license_number: l.license_number,
          product_id: l.product_id,
        })),
      );
    return {
      items: all.slice((page - 1) * limit, page * limit),
      total: all.length,
    };
  }
  return listCustomerInstallationsTargeted(db, customerId, params);
}

async function listCustomerInstallationsTargeted(
  db: LicenseListDb,
  customerId: string,
  params: { limit: number; page: number },
): Promise<{ items: InstallationListItem[]; total: number }> {
  const { limit, page } = params;
  const licenseRows = await db
    .select({
      id: licenses.id,
      licenseNumber: licenses.licenseNumber,
      productId: licenses.productId,
    })
    .from(licenses)
    .where(eq(licenses.customerId, customerId))
    .orderBy(asc(licenses.createdAt), asc(licenses.id));
  if (licenseRows.length === 0) return { items: [], total: 0 };
  const activationRows = await db
    .select()
    .from(licenseActivations)
    .where(
      inArray(
        licenseActivations.licenseId,
        licenseRows.map((r) => r.id),
      ),
    )
    .orderBy(asc(licenseActivations.activatedAt), asc(licenseActivations.id));
  const byLicense = new Map(licenseRows.map((r) => [r.id, r]));
  const activationsByLicense = new Map<string, LicenseActivationRecord[]>();
  for (const a of activationRows) {
    const list = activationsByLicense.get(a.licenseId) ?? [];
    list.push(licenseActivationOf(a));
    activationsByLicense.set(a.licenseId, list);
  }
  const all: InstallationListItem[] = [];
  for (const lic of licenseRows) {
    const licRow = byLicense.get(lic.id)!;
    for (const a of activationsByLicense.get(lic.id) ?? []) {
      all.push({
        ...a,
        license_number: licRow.licenseNumber,
        product_id: licRow.productId,
      });
    }
  }
  return {
    items: all.slice((page - 1) * limit, page * limit),
    total: all.length,
  };
}

/** Targeted existence check (for list routes that 404 on a missing parent). */
export async function licenseExists(source: ListSource, id: string): Promise<boolean> {
  const db = drizzleDbOf(source);
  if (!db) return (source as StackMateDataStore).state.licenses.some((l) => l.id === id);
  return licenseExistsTargeted(db, id);
}

async function licenseExistsTargeted(db: LicenseListDb, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: licenses.id })
    .from(licenses)
    .where(eq(licenses.id, id))
    .limit(1);
  return rows.length > 0;
}

function pagedCollectionTotal<T>(
  c: Context<AppEnv>,
  pageItems: T[],
  total: number,
  status = 200,
): Response {
  return c.json(
    createCollectionEnvelope(pageItems, null, c.var.requestId, total),
    status as ContentfulStatusCode,
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

// Lenient variant for handlers that treat a missing/malformed body
// as "no body". A 413 is never swallowed: an oversize body must fail
// loudly.
async function readJsonBodyLenient(c: Context<AppEnv>): Promise<any> {
  try {
    return await readJsonBody(c);
  } catch (error) {
    if (error instanceof AppError && error.code === "PAYLOAD_TOO_LARGE") throw error;
    return {};
  }
}

export function registerAdminLicensesRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/admin/licenses", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
    // Never expose license_key_hash or raw keys in list responses (API Spec §12.3)
    const query = c.req.query();
    const { q, limit, page } = parseListQuery(query);
    const { items, total, refs } = await listLicenses(store, {
      q,
      limit,
      page,
      sort: parseTimestampSort(query, "created_at"),
    });
    return pagedCollectionTotal(
      c,
      items.map((l) => {
        const ref = refs.get(l.id) ?? {
          customer_name: null,
          product_code: null,
          product_name: null,
          active_activations_count: 0,
        };
        return {
          ...l,
          customer_name: ref.customer_name,
          product_code: ref.product_code,
          product_name: ref.product_name,
          active_activations_count: ref.active_activations_count,
          expires_date_display: l.expires_at
            ? formatDisplayDateDDMMYYYY(l.expires_at, env.DEFAULT_TIMEZONE)
            : "Lifetime",
        };
      }),
      total,
    );
  });

  app.post("/api/v1/admin/licenses/manual-grants", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = await readJsonBody(c);
    const granted = await createManualLicenseGrantByAdmin(
      store,
      principal,
      body,
      env.LICENSE_VERIFIER_SECRET,
      requestId
    );
    return ok(c, granted, 201);
  });

  // E-05: signing-key lifecycle admin API (PRD §13.5; API spec
  // §16.6). Rotation/revocation exist only as store methods
  // until now — these routes expose them, permission-gated and
  // audit-logged. Placed BEFORE the :licenseId detail match:
  // GET /admin/licenses/signing-keys would otherwise match
  // licenseId="signing-keys" and 404.
  // List: public JWKs (never private material) + status per key
  // (active vs retired — revoked keys leave the store, so they
  // never appear here, same as the public endpoint).
  app.get("/api/v1/admin/licenses/signing-keys", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
    const keys = store.listPublicSigningKeys();
    return ok(c, {
      active_key_id: store.activeSigningKeyId,
      keys: keys.map((jwk) => ({
        key_id: (jwk as { kid?: unknown }).kid ?? null,
        status:
          (jwk as { kid?: unknown }).kid === store.activeSigningKeyId
            ? "active"
            : "retired",
        public_key_jwk: jwk,
      })),
    });
  });

  app.post("/api/v1/admin/licenses/signing-keys/rotate", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as { key_id?: unknown };
    const requestedId =
      typeof body.key_id === "string" && body.key_id.trim().length > 0
        ? body.key_id.trim()
        : undefined;
    // The store derives a fresh id when none is given
    // (DrizzleStore); the in-memory store needs an explicit one,
    // so derive the same shape here when absent.
    const nextKeyId =
      requestedId ??
      `key-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const rotated = await store.rotateSigningKey(nextKeyId);
    await store.withTransaction((state) => {
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: principal.user.id,
        action: "licenses.signing_key.rotated",
        resource_type: "signing_key",
        resource_id: rotated.keyId,
        outcome: "success",
        request_id: requestId,
        changes: { key_id: rotated.keyId },
      });
    });
    return ok(
      c,
      {
        key_id: rotated.keyId,
        status: "active",
        public_key_jwk: rotated.publicKeyJwk,
      },
      201
    );
  });

  app.post("/api/v1/admin/licenses/signing-keys/:keyId/revoke", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // Revoke is irreversible for that key id — licenses.revoke,
    // like license revocation. The active key can never be
    // revoked (rotate first); the store enforces it with 409.
    await assertStaffPermissionAudited(store, principal, "licenses.revoke", requestId);
    const keyId = c.req.param("keyId");
    await store.revokeSigningKey(keyId);
    await store.withTransaction((state) => {
      appendAuditLog(state, {
        actor_type: "staff",
        actor_user_id: principal.user.id,
        action: "licenses.signing_key.revoked",
        resource_type: "signing_key",
        resource_id: keyId,
        outcome: "success",
        request_id: requestId,
        changes: { key_id: keyId },
      });
    });
    return ok(c, { revoked: true, key_id: keyId });
  });

  // Batch 1: license detail + activations.
  // NOTE: GET /api/v1/admin/licenses/manual-grants would also match
  // this pattern with licenseId="manual-grants" — but that path has
  // no GET route, so a 404 here is correct; the POST above runs first.
  app.get("/api/v1/admin/licenses/:licenseId", async (c) => {
    const store = c.var.store;
    const env = c.var.env;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
    const lic = store.state.licenses.find(
      (l) => l.id === c.req.param("licenseId")
    );
    if (!lic) throw new AppError("NOT_FOUND", "License not found.", 404);
    const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = lic;
    const customer = store.state.customers.find((cu) => cu.id === lic.customer_id);
    const product = store.state.products.find((p) => p.id === lic.product_id);
    return ok(c, {
      ...safe,
      customer_name: customer?.name ?? null,
      customer_email: customer?.email ?? null,
      product_code: product?.code ?? null,
      product_name: product?.name ?? null,
      active_activations_count: lic.activations.filter((a) => a.status === "active")
        .length,
      expires_date_display: lic.expires_at
        ? formatDisplayDateDDMMYYYY(lic.expires_at, env.DEFAULT_TIMEZONE)
        : "Lifetime",
      entitlement_snapshots: lic.snapshots,
    });
  });

  app.get("/api/v1/admin/licenses/:licenseId/activations", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    await assertStaffPermissionAudited(store, principal, "licenses.read", requestId);
    const licenseId = c.req.param("licenseId");
    if (!(await licenseExists(store, licenseId))) {
      throw new AppError("NOT_FOUND", "License not found.", 404);
    }
    const { limit, page } = parseListQuery(c.req.query());
    const { items, total } = await listLicenseActivations(store, licenseId, { limit, page });
    return pagedCollectionTotal(c, items, total);
  });

  app.post("/api/v1/admin/licenses/:licenseId/activations/:activationId/deactivate", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = (await readJsonBodyLenient(c)) as { reason?: string };
    const result = await deactivateLicenseActivationByAdmin(
      store,
      principal,
      c.req.param("licenseId"),
      c.req.param("activationId"),
      body,
      requestId
    );
    return ok(c, result);
  });

  app.post("/api/v1/admin/licenses/:licenseId/activations/:activationId/transfer", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // E-03: audited activation transfer (Roadmap Stage 6 exit;
    // API spec §12.2).
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = await readJsonBody(c);
    const result = await transferActivation(
      store,
      principal,
      c.req.param("licenseId"),
      c.req.param("activationId"),
      body,
      requestId
    );
    return ok(c, result);
  });

  app.post("/api/v1/admin/licenses/:licenseId/:action", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    const action = c.req.param("action");
    if (action !== "suspend" && action !== "resume" && action !== "revoke") {
      // app.ts falls through to 404 for any other :action value.
      throw new AppError(
        "NOT_FOUND",
        `Route 'POST /api/v1/admin/licenses/${c.req.param("licenseId")}/${action}' not found.`,
        404
      );
    }
    // M-9: revoke is irreversible — it needs licenses.revoke;
    // suspend/resume need licenses.manage.
    await assertStaffPermissionAudited(
      store,
      principal,
      action === "revoke" ? "licenses.revoke" : "licenses.manage",
      requestId
    );
    const body = (await readJsonBodyLenient(c)) as { reason?: string };
    const updated = await transitionLicenseStatusByAdmin(
      store,
      principal,
      c.req.param("licenseId"),
      action,
      body.reason ?? "Admin lifecycle command",
      requestId
    );
    const { license_key_hash: _h, issued_raw_key_once: _r, ...safe } = updated;
    return ok(c, safe);
  });

  app.post("/api/v1/admin/licenses/:licenseId/entitlement-snapshots", async (c) => {
    const store = c.var.store;
    const principal = requirePrincipal(c);
    const requestId = c.var.requestId;
    // M-9: the mutation maps to its write permission at the
    // dispatcher (audited variant, so a denial is recorded).
    await assertStaffPermissionAudited(store, principal, "licenses.manage", requestId);
    const body = (await readJsonBody(c)) as {
      reason: string;
      entitlements: Record<string, unknown>;
    };
    const snap = await appendLicenseEntitlementSnapshotByAdmin(
      store,
      principal,
      c.req.param("licenseId"),
      {
        reason: body.reason,
        entitlements: body.entitlements,
        requestId,
      }
    );
    return ok(c, snap, 201);
  });
}
