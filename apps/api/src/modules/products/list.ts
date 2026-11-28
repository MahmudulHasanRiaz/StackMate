/**
 * B-01 targeted admin product list.
 *
 * Runs against `store.drizzleDb` (a `createTargeted()` store's `state`
 * is empty, so this must never read `store.state`): SQL WHERE for the
 * `q` search, ORDER BY created_at ASC (the combined-load order),
 * LIMIT/OFFSET for the page, plus a separate COUNT for the total.
 * Rows are mapped to the same snake_case `ProductRecord` shape the
 * in-memory list returned (Drizzle rows are camelCase + Date).
 */
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../../../db/schema/index.ts";
import { productFeatures, products } from "../../../../../db/schema/catalog.ts";
import { productPackages } from "../../../../../db/schema/entitlements.ts";
import type { ProductRecord } from "../../platform/db/store.ts";
import type {
  DatabaseState,
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

export interface ProductListParams {
  q: string;
  limit: number;
  page: number;
}

export interface ProductListItem extends ProductRecord {
  features_count: number;
  packages_count: number;
}

export interface ProductListResult {
  items: ProductListItem[];
  total: number;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function productOf(row: typeof products.$inferSelect, channels: string[]): ProductRecord {
  return {
    id: row.id,
    code: row.code,
    slug: row.slug,
    name: row.name,
    description: row.description,
    product_type: row.productType,
    fulfillment_type: row.fulfillmentType,
    distribution_channels: channels,
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

export async function listProducts(
  source: ListSource,
  params: ProductListParams,
): Promise<ProductListResult> {
  const db = drizzleDbOf(source);
  if (db) return listProductsTargeted(db, params);
  return listProductsInMemory((source as StackMateDataStore).state, params);
}

/**
 * In-memory fallback — the pre-B-01 route logic, reproduced exactly:
 * name/code substring filter, features/packages counts from state,
 * total = full filtered count, page sliced after filtering. Sorted
 * created_at ASC, id ASC (the targeted order; identical to insertion
 * order for sequentially seeded rows, deterministic otherwise).
 */
function listProductsInMemory(
  state: DatabaseState,
  params: ProductListParams,
): ProductListResult {
  const { q, limit, page } = params;
  const needle = q.toLowerCase();
  const filtered = byCreatedAsc(
    state.products.filter(
      (p) => includesQuery(p.name, needle) || includesQuery(p.code, needle),
    ),
  );
  return {
    items: applyPage(filtered, limit, page).map((p) => ({
      ...p,
      features_count: state.product_features.filter((f) => f.product_id === p.id).length,
      packages_count: state.product_packages.filter((pkg) => pkg.product_id === p.id).length,
    })),
    total: filtered.length,
  };
}

async function listProductsTargeted(
  db: ListDb,
  params: ProductListParams,
): Promise<ProductListResult> {
  const { q, limit, page } = params;
  const conditions: SQL[] = [];
  if (q !== "") {
    const like = `%${escapeLikePattern(q)}%`;
    const match = or(ilike(products.name, like), ilike(products.code, like));
    if (match) conditions.push(match);
  }
  const where = conditions.length === 0 ? undefined : and(...conditions);

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(products)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);

  const rows = await db
    .select()
    .from(products)
    .where(where)
    .orderBy(asc(products.createdAt), asc(products.id))
    .limit(limit)
    .offset((page - 1) * limit);

  const ids = rows.map((r) => r.id);
  const channelsByProduct = new Map<string, string[]>();
  const featuresCount = new Map<string, number>();
  const packagesCount = new Map<string, number>();
  if (ids.length > 0) {
    const channelRows = await db
      .select()
      .from(schema.productDistributionChannels)
      .where(inArray(schema.productDistributionChannels.productId, ids))
      .orderBy(
        asc(schema.productDistributionChannels.productId),
        asc(schema.productDistributionChannels.channelKey),
      );
    for (const ch of channelRows) {
      const list = channelsByProduct.get(ch.productId) ?? [];
      list.push(ch.channelKey);
      channelsByProduct.set(ch.productId, list);
    }
    const featureCounts = await db
      .select({
        productId: productFeatures.productId,
        value: sql<number>`count(*)`,
      })
      .from(productFeatures)
      .where(inArray(productFeatures.productId, ids))
      .groupBy(productFeatures.productId);
    for (const row of featureCounts) {
      featuresCount.set(row.productId, Number(row.value));
    }
    const packageCounts = await db
      .select({
        productId: productPackages.productId,
        value: sql<number>`count(*)`,
      })
      .from(productPackages)
      .where(inArray(productPackages.productId, ids))
      .groupBy(productPackages.productId);
    for (const row of packageCounts) {
      packagesCount.set(row.productId, Number(row.value));
    }
  }

  return {
    items: rows.map((row) => ({
      ...productOf(row, channelsByProduct.get(row.id) ?? []),
      features_count: featuresCount.get(row.id) ?? 0,
      packages_count: packagesCount.get(row.id) ?? 0,
    })),
    total,
  };
}

/** Targeted existence check (for list routes that 404 on a missing parent). */
export async function productExists(source: ListSource, id: string): Promise<boolean> {
  const db = drizzleDbOf(source);
  if (!db) return (source as StackMateDataStore).state.products.some((p) => p.id === id);
  return productExistsTargeted(db, id);
}

async function productExistsTargeted(db: ListDb, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  return rows.length > 0;
}
