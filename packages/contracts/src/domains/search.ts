/**
 * Global search (PLAN §29 / ADR-0010) — the header search bar.
 *
 * GET /api/v1/admin/search?q=… returns grouped record results (≤8 per
 * group), each with the SPA detail route (`to`). A group is included
 * only when the caller may read it; a group the caller cannot read is
 * omitted, never a 403 for the whole search.
 */
export type GlobalSearchGroupKey =
  | "customers"
  | "orders"
  | "products"
  | "licenses"
  | "subscriptions"
  | "tickets"
  | "leads"
  | "staff"
  | "sites";

export interface GlobalSearchItem {
  type: GlobalSearchGroupKey;
  id: string;
  label: string;
  sublabel: string | null;
  /** SPA route for the record's detail page. */
  to: string;
}

export interface GlobalSearchGroup {
  key: GlobalSearchGroupKey;
  label: string;
  items: GlobalSearchItem[];
}

export interface GlobalSearchResponse {
  query: string;
  groups: GlobalSearchGroup[];
}

/** Queries shorter than this return empty groups (no full-table dump). */
export const GLOBAL_SEARCH_MIN_QUERY_LENGTH = 2;

/** Per-group cap in the response. The cap is per GROUP, not a filter over
 * a loaded page — each group's query runs server-side over the full table
 * (PLAN §29 rule 3). */
export const GLOBAL_SEARCH_MAX_PER_GROUP = 8;
