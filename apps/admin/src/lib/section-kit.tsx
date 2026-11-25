/**
 * Section kit (design spec §4 + §8 checklist).
 *
 * Shared building blocks for every admin section route. Sections MUST use
 * these instead of inventing their own list/detail patterns:
 *  - PageHeader: breadcrumb + title + ONE main action
 *    (usually the accent variant; `primary` — white — is reserved
 *    for the single most-important creation on its page, e.g.
 *    "Create product" on the Products list). A prose page
 *    description goes in `help` — it renders ONLY behind the (i)
 *    button beside the title (clean header rule, 2026-11-16), never
 *    as visible text. `subtitle` is for one short line of DATA only
 *    (detail-page identity/metadata, e.g. order ref · source) or a
 *    money-safety warning; passing `help` suppresses `subtitle`.
 *  - useAdminList / useAdminDetail: TanStack Query over apiRequest.
 *  - useAdminMutation: mutation + toast + exact key invalidation.
 *  - ListTable: TanStack Table — search/sort/pagination over the
 *    collection the API returns. Search is server-driven where the
 *    section opts in (`serverSearch` + `opts.q` on useAdminList):
 *    the section threads its URL search into useAdminList's `q`
 *    option (debounced, `?q=` on the request) and ListTable's client
 *    filter is disabled — the rows it receives are already the
 *    matches. Pagination is server-driven: when the section passes
 *    `opts.page` / `opts.pageSize`, the hook sends `?page=` +
 *    `?limit=` (the API slices the (page-1)*limit window and reports
 *    the pre-limit `data.total`), and ListTable renders that page
 *    as-is (`serverPagination`) — no row is unreachable. Without
 *    page opts the hook keeps the old `?limit=100` window and
 *    ListTable paginates client-side within it (option loads and
 *    detail-tab lists, which have no server search).
 *  - DetailFacts: the 4–6 key facts row on detail pages.
 *
 * All five states (loading / empty / no-results / error / populated) are
 * handled here, so the silent-blank failure is impossible.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { keepPreviousData, useMutation, useQuery, type UseMutationOptions } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, PackageSearch, RefreshCw } from "lucide-react";
import { apiRequest, ApiClientError } from "./api-client";
import { detailKey, listKey, queryClient } from "./query";
import {
  Breadcrumb,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  InfoButton,
  Input,
  Pagination,
  TableSkeleton,
  Toolbar,
  useToast,
  type SearchableOption,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* Page header (spec §4.1): breadcrumb, title, ONE action. Prose      */
/* goes in `help` (behind the (i) button, never visible by default);   */
/* `subtitle` is data/metadata only — and never renders when `help`    */
/* is present, so a header can never show prose again.                 */
/* ------------------------------------------------------------------ */
export function PageHeader({
  breadcrumb,
  title,
  subtitle,
  help,
  action,
}: {
  breadcrumb: { label: string; href?: string }[];
  title: string;
  subtitle?: string;
  help?: string;
  action?: ReactNode;
}) {
  /* F7 (2026-11-16): the breadcrumb's last crumb repeats the page
     title verbatim on most list pages ("Products" under "Products").
     Drop it when it duplicates the title; the title itself is the
     heading. Detail crumbs (an ID, "…", a different label) stay. */
  const crumbs =
    breadcrumb.length > 0 &&
    breadcrumb[breadcrumb.length - 1]?.label === title
      ? breadcrumb.slice(0, -1)
      : breadcrumb;
  return (
    <div>
      <div className="sm-page-header">
        <div>
          <div className="sm-page-title-row">
            <h1 className="sm-page-title">{title}</h1>
            {help ? <InfoButton text={help} /> : null}
          </div>
          {subtitle && !help ? <p className="sm-page-subtitle">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {crumbs.length > 0 ? (
        <div className="sm-page-breadcrumb">
          <Breadcrumb items={crumbs} />
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data hooks                                                          */
/* ------------------------------------------------------------------ */
/* Audit H-01: the list search is server-driven. The section threads
 *  its URL search value in as `opts.q` (the sections agent wires the
 *  call sites); the hook debounces it 250ms (same as QuickNav) and
 *  sends it as `?q=` on the request, so the server searches the FULL
 *  dataset instead of the loaded page. The debounced value joins the
 *  query key, so each distinct search caches separately — and
 *  invalidation by listKey(section) still matches, because TanStack
 *  Query matches invalidation keys by prefix. Without `opts.q` the
 *  hook behaves exactly as before (no `?q=`, same key).
 *
 * Server pagination (audit follow-up): the API slices the
 * (page-1)*limit window and reports the server `data.total`.
 * When the section passes `opts.page` / `opts.pageSize`, the hook
 * sends `?page=` + `?limit=<pageSize>` and joins both into the
 * query key, so each page caches separately (invalidation by
 * listKey(section) still matches by prefix). `keepPreviousData`
 * keeps the old page visible while the next one loads, so paging
 * never flashes the skeleton. Without page opts the hook keeps
 * the old behaviour — always `?limit=100` (the API max) — and
 * reports the server `data.total` alongside the items (`total`
 * falls back to the loaded count when an endpoint does not return
 * one). The return shape keeps `data` as the items array, so every
 * existing call site reads `query.data` unchanged; pages pass
 * `query.total` to ListTable, which paginates client-side within
 * the loaded window when `serverPagination` is off, and renders
 * the server page as-is when it is on.
 *
 * `opts.extra` threads server-side filter params the endpoint
 * already supports (e.g. `{ payment_status: "paid" }`,
 * `{ status: "active" }`) — the values join the query key, so each
 * filter combination caches separately. Pages keep their
 * client-side filter memo as well (same predicate); it is a no-op
 * over the server-filtered rows. Only thread a param the endpoint
 * actually reads — unknown params are ignored by the API, and a
 * threaded param must never change what another part of the page
 * derives from the same query (e.g. a header count). */
export const LIST_FETCH_LIMIT = 100;

export function useAdminList<T>(
  section: string,
  path: string,
  // exactOptionalPropertyTypes is on: call sites pass `q: parsed.q`
  // (string | undefined) and extra maps with undefined-valued keys
  // for inactive filters, so both accept an explicit undefined here.
  // Undefined extra values are dropped before the request is built.
  // `page` / `pageSize` opt a list into true server pagination
  // (see the hook comment above); omit both for the ?limit=100
  // window used by option loads and detail-tab lists.
  opts?: {
    q?: string | undefined;
    extra?: Record<string, string | undefined> | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
  },
) {
  const q = opts?.q ?? "";
  const extra = opts?.extra;
  const page = opts?.page;
  const pageSize = opts?.pageSize;
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q), 250);
    return () => window.clearTimeout(timer);
  }, [q]);
  // Stable key for the extra params: call sites build the object
  // inline each render, so the sorted-entries string is the key —
  // never the object identity. Undefined-valued entries are dropped
  // so `{ status: undefined }` and `{}` share one cache entry.
  const extraEntries = extra
    ? Object.entries(extra)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
    : [];
  const extraKey = extraEntries.length > 0 ? JSON.stringify(extraEntries) : "";
  const query = useQuery({
    queryKey: [
      ...listKey(section),
      ...(debouncedQ ? [{ q: debouncedQ }] : []),
      ...(extraKey ? [{ extra: extraKey }] : []),
      ...(page !== undefined ? [{ page, pageSize: pageSize ?? 25 }] : []),
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      for (const [key, value] of extraEntries) params.set(key, value as string);
      if (page !== undefined) {
        params.set("page", String(page));
        params.set("limit", String(pageSize ?? 25));
      } else {
        params.set("limit", String(LIST_FETCH_LIMIT));
      }
      if (debouncedQ) params.set("q", debouncedQ);
      const sep = path.includes("?") ? "&" : "?";
      const res = await apiRequest<{ items: T[]; total?: number }>(`${path}${sep}${params}`);
      return res;
    },
    // Paging must not flash the skeleton: the previous page stays
    // on screen while the next one loads (same pattern as the
    // dashboard's keepPreviousData).
    placeholderData: keepPreviousData,
  });
  return {
    ...query,
    data: query.data?.items,
    total: query.data?.total ?? query.data?.items?.length ?? 0,
  };
}

export function useAdminDetail<T>(section: string, id: string, path: string) {
  return useQuery({
    queryKey: detailKey(section, id),
    queryFn: () => apiRequest<T>(path),
  });
}

/* ------------------------------------------------------------------ */
/* Server-side option loading for SearchableSelect (PLAN §29).         */
/* The query runs against the list endpoint's ?q= (server-side over    */
/* the full dataset, first 25 matches) — never a filter over a loaded  */
/* page. The caller's abort signal is combined with the 30s client     */
/* bound, so a hung search still settles. Audit H-03: the loader      */
/* accepts server-side filter params (opts.extra, e.g.                */
/* { status: "active" } / { is_enabled: "true" } — the API agent      */
/* adds them) and forwards them on the request instead of filtering   */
/* the loaded page client-side. This folds in the sections agent's     */
/* local loadFilteredOptions copies (orders, payment-review, tickets,  */
/* leads) — those call sites can now use this helper with { extra }   */
/* and the copies can be deleted at integration. Audit L-01: with     */
/* opts.withMeta the loader also reports whether the server capped    */
/* the page (a full page means there may be more matches) —           */
/* SearchableSelect renders the "Showing first N — refine your        */
/* search" hint from it.                                               */
/* ------------------------------------------------------------------ */
export async function loadListOptions<T>(
  path: string,
  query: string,
  toOption: (item: T) => SearchableOption,
  signal?: AbortSignal,
  opts?: { limit?: number; extra?: Record<string, string>; withMeta?: false },
): Promise<SearchableOption[]>;
export async function loadListOptions<T>(
  path: string,
  query: string,
  toOption: (item: T) => SearchableOption,
  signal?: AbortSignal,
  opts?: { limit?: number; extra?: Record<string, string>; withMeta: true },
): Promise<{ options: SearchableOption[]; capped: boolean }>;
export async function loadListOptions<T>(
  path: string,
  query: string,
  toOption: (item: T) => SearchableOption,
  signal?: AbortSignal,
  opts?: { limit?: number; extra?: Record<string, string>; withMeta?: boolean },
): Promise<SearchableOption[] | { options: SearchableOption[]; capped: boolean }> {
  const limit = opts?.limit ?? 25;
  const params = new URLSearchParams(opts?.extra ?? {});
  params.set("limit", String(limit));
  const trimmed = query.trim();
  if (trimmed) params.set("q", trimmed);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await apiRequest<{ items: T[] }>(`${path}?${params}`, {
      signal: controller.signal,
    });
    const options = res.items.map(toOption);
    // A full page means the server may hold more matches than the
    // cap returned; a short page proves the result set is complete.
    const capped = res.items.length >= limit;
    return opts?.withMeta ? { options, capped } : options;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/* ------------------------------------------------------------------ */
/* Label resolution for SearchableSelect (PLAN §29).                   */
/* When a value is preset but its label is not among the loaded        */
/* options (e.g. a filter value restored from the URL), the combobox   */
/* fetches the single record's detail once and shows its label — never */
/* a raw id. A 404/empty result resolves to null (the input falls back */
/* to its placeholder) instead of showing a UUID.                      */
/* ------------------------------------------------------------------ */
export function detailLabelResolver<T>(
  pathFor: (id: string) => string,
  toLabel: (item: T) => string | null,
): (value: string, signal: AbortSignal) => Promise<string | null> {
  return async (value, signal) => {
    try {
      const item = await apiRequest<T>(pathFor(value), { signal });
      return toLabel(item);
    } catch {
      return null;
    }
  };
}

/**
 * A-04: one idempotency key per form instance (not per click).
 * Call it at the top of a form/dialog component and pass the returned
 * key as `idempotencyKey` on every consequential POST that form makes
 * (create / approve / activate / rotate / refund / invite / grant).
 * A retry after a network timeout then replays instead of executing
 * twice; a fresh form instance gets a fresh key. The key is stable
 * for the component's lifetime (useState initializer runs once).
 */
export function useIdempotencyKey(): string {
  const [key] = useState(() => crypto.randomUUID());
  return key;
}

/** E-20: download rows as a CSV file (bulk-export action). */
export function downloadCsv(filename: string, header: string[], rows: string[][]) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const text = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function useAdminMutation<TData, TVariables>(options: {
  mutationFn: (variables: TVariables) => Promise<TData>;
  invalidateKeys: readonly (readonly unknown[])[];
  successTitle: string;
  successMessage?: string;
  onSuccess?: (data: TData, variables: TVariables) => void;
}) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: (data, variables) => {
      for (const key of options.invalidateKeys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      toast({
        title: options.successTitle,
        ...(options.successMessage ? { message: options.successMessage } : {}),
        variant: "success",
      });
      options.onSuccess?.(data, variables);
    },
    onError: (err: unknown) => {
      toast({
        title: "Action failed",
        message: err instanceof Error ? err.message : "Unknown error",
        variant: "danger",
      });
    },
  } satisfies UseMutationOptions<TData, Error, TVariables>);
}

export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

/* ------------------------------------------------------------------ */
/* Route search params for list pages (URL-backed filters, spec §8)     */
/* ------------------------------------------------------------------ */
export interface ListSearch {
  q?: string;
  page?: number;
  pageSize?: number;
}

export function parseListSearch(search: Record<string, unknown>): ListSearch {
  const q = typeof search.q === "string" && search.q.length > 0 ? search.q : undefined;
  const page = Number(search.page);
  const pageSize = Number(search.pageSize);
  return {
    ...(q ? { q } : {}),
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    pageSize: [25, 50, 100].includes(pageSize) ? pageSize : 25,
  };
}

/* ------------------------------------------------------------------ */
/* ListTable — TanStack Table + all five states                        */
/* ------------------------------------------------------------------ */
export function ListTable<T>({
  columns,
  data,
  search,
  onSearchChange,
  page,
  onPageChange,
  pageSize,
  onPageSizeChange,
  isLoading,
  isError,
  error,
  onRetry,
  emptyIcon = PackageSearch,
  emptyTitle,
  emptyBody,
  emptyActionLabel,
  onEmptyAction,
  toolbar,
  getRowId,
  serverSearch = false,
  refreshSection,
  refreshQueryKey,
  filtersActive = false,
  total,
  serverPagination = false,
  disableSorting = false,
  serverSort,
  enableRowSelection = false,
  onSelectionChange,
  bulkActions,
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[] | undefined;
  search: string;
  onSearchChange: (q: string) => void;
  page: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  emptyIcon?: Parameters<typeof EmptyState>[0]["icon"];
  emptyTitle: string;
  emptyBody: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  toolbar?: ReactNode;
  getRowId?: (row: T) => string;
  /** Audit H-01: true when the section threads its search into
   *  useAdminList's `q` option — the rows are already the server's
   *  matches, so the client JSON filter is disabled. False keeps the
   *  client filter for unmigrated pages. */
  serverSearch?: boolean;
  /** Audit L-04: the list section key (the same string passed to
   *  useAdminList) — renders a Refresh button that invalidates the
   *  list query, the manual counterpart to the 30s staleTime. */
  refreshSection?: string;
  /** D-10: an exact query key to invalidate instead — for tables
   *  whose rows come from a detail query (e.g. a site's domains),
   *  where no list key exists to refresh. */
  refreshQueryKey?: readonly unknown[];
  /** Audit L-02: true when any toolbar filter is set to a non-default
   *  value — the toolbar stays visible on an empty collection so the
   *  user can see (and clear) what filtered everything out. The
   *  section owns this; ListTable cannot introspect the toolbar. */
  filtersActive?: boolean;
  /** Server pagination (audit follow-up): the server `data.total`
   *  for this list, from `useAdminList`'s `total` — the Pagination
   *  footer shows it ("Showing 1–25 of 347"). Falls back to the
   *  client-filtered count when the section does not pass one
   *  (embedded tables with no list endpoint). */
  total?: number;
  /** True when the rows are exactly the server's page (the section
   *  passed `page`/`pageSize` to useAdminList): the table must NOT
   *  slice them client-side — TanStack's pagination row model would
   *  empty page 2+ of a 25-row page — and the step-back below uses
   *  the server total, not the loaded count. False keeps the old
   *  ?limit=100 window behaviour (client-side paging within the
   *  loaded rows). */
  serverPagination?: boolean;
  /** D-01: the server has no sort for this list (or the section has
   *  not threaded one) — render every header as plain text. Client
   *  sorting over one loaded page would imply a global order that
   *  does not exist. */
  disableSorting?: boolean;
  /** D-01 (server sort): when provided, only `sortableColumns` get
   *  sortable headers and clicks call `onChange` with
   *  `<columnId>:asc|desc` (or undefined to clear) — the section
   *  threads that value into useAdminList's `extra: { sort }` and the
   *  server orders the full set. No client-side sort runs. */
  serverSort?: {
    sortableColumns: string[];
    value: string | undefined;
    onChange: (sort: string | undefined) => void;
  };
  /** E-20: row selection + bulk actions (PRD §17.5). Adds a checkbox
   *  column; `bulkActions` render above the table while rows are
   *  selected. Selection is per loaded page. */
  enableRowSelection?: boolean;
  onSelectionChange?: (rows: T[]) => void;
  bulkActions?: Array<{
    label: string;
    danger?: boolean;
    disabled?: boolean;
    onSelect: (rows: T[]) => void;
  }>;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsPickerRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(() => data ?? [], [data]);
  // E-20: selection column (never hideable, never sortable).
  const tableColumns = useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!enableRowSelection) return columns;
    const selectColumn: ColumnDef<T, unknown> = {
      id: "__select",
      header: "",
      enableSorting: false,
      enableHiding: false,
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label="Select row"
          checked={row.getIsSelected()}
          onChange={(e) => row.toggleSelected(e.target.checked)}
        />
      ),
    };
    return [selectColumn, ...columns];
  }, [columns, enableRowSelection]);

  // Server pagination: when `serverPagination` is on, the rows are
  // exactly the server's page — the table renders them as-is and
  // the step-back uses the SERVER total (a page past the last one,
  // e.g. after a delete emptied it, steps back to the last page
  // instead of rendering an empty one; Pagination's own clamp does
  // the same on the populated branch). When it is off, the hook
  // fetched the first 100 rows and the table paginates within that
  // window — the "Next" button on the last loaded page still offers
  // the next page, and it steps back here.
  const serverTotalPages =
    serverPagination && total !== undefined
      ? Math.max(1, Math.ceil(total / pageSize))
      : null;
  const loadedPages =
    serverTotalPages ?? Math.max(1, Math.ceil(rows.length / pageSize));
  useEffect(() => {
    if (!isLoading && page > loadedPages) {
      onPageChange(loadedPages);
    }
  }, [isLoading, page, loadedPages, onPageChange]);

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      globalFilter: search,
      pagination: { pageIndex: page - 1, pageSize },
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    enableRowSelection,
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function"
          ? updater({ pageIndex: page - 1, pageSize })
          : updater;
      if (next.pageIndex !== page - 1) onPageChange(next.pageIndex + 1);
      if (next.pageSize !== pageSize) onPageSizeChange(next.pageSize);
    },
    getCoreRowModel: getCoreRowModel(),
    // D-01: no client-side sort when the server sorts (serverSort)
    // or when sorting is disabled — the rows arrive already ordered.
    ...(serverSort || disableSorting ? {} : { getSortedRowModel: getSortedRowModel() }),
    getFilteredRowModel: getFilteredRowModel(),
    // Audit follow-up (server pagination): when the rows are the
    // server's page, TanStack must NOT slice them — its pagination
    // row model would take rows 25–50 of a 25-row page and render
    // an empty tbody on every page past the first. The window mode
    // keeps the row model (client-side paging within the 100 rows).
    // (Spread, not `getPaginationRowModel: undefined` — the admin
    // tsconfig has exactOptionalPropertyTypes on.)
    ...(serverPagination ? {} : { getPaginationRowModel: getPaginationRowModel() }),
    // Audit H-01: server-driven search passes every row — the server
    // already filtered. The JSON-stringify filter stays for pages
    // that have not migrated yet.
    globalFilterFn: serverSearch
      ? () => true
      : (row, _columnId, filterValue) => {
          const needle = String(filterValue).toLowerCase();
          return JSON.stringify(row.original).toLowerCase().includes(needle);
        },
    ...(getRowId ? { getRowId: (row: T) => getRowId(row) } : {}),
  });

  // E-20: report the selected rows to the section (for bulk
  // actions); selection is per loaded page.
  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original);
  useEffect(() => {
    onSelectionChange?.(selectedRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSelection]);
  useEffect(() => {
    if (!columnsOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!columnsPickerRef.current?.contains(e.target as Node)) setColumnsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [columnsOpen]);

  // Neon list pattern: the search is full-width, directly under the
  // breadcrumb — the toolbar below it holds only filters/actions.
  // The Refresh affordance (audit L-04) sits at the search row's
  // right; the row is shared by the populated and the empty states.
  const searchRow = (
    <div className="sm-list-search">
      <Input
        className="sm-search-input"
        type="search"
        placeholder="Search…"
        aria-label="Search"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      {refreshSection || refreshQueryKey ? (
        <IconButton
          label="Refresh list"
          icon={RefreshCw}
          onClick={() =>
            void queryClient.invalidateQueries({
              queryKey: refreshQueryKey ?? listKey(refreshSection!),
            })
          }
        />
      ) : null}
      {/* E-20: column visibility (TanStack native). Every hideable
          column is listed; the selection column is never listed. */}
      <div className="sm-column-picker" ref={columnsPickerRef}>
        <IconButton
          label="Choose columns"
          icon={Columns3}
          onClick={() => setColumnsOpen((v) => !v)}
        />
        {columnsOpen ? (
          <div className="sm-column-picker-panel" role="menu" aria-label="Choose columns">
            {table
              .getAllLeafColumns()
              .filter((c) => c.getCanHide())
              .map((c) => (
                <label key={c.id} className="sm-column-picker-item">
                  <input
                    type="checkbox"
                    checked={c.getIsVisible()}
                    onChange={(e) => c.toggleVisibility(e.target.checked)}
                  />
                  <span>{String(c.columnDef.header ?? c.id)}</span>
                </label>
              ))}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (isLoading) return <TableSkeleton rows={5} />;
  if (isError) {
    return (
      <div className="sm-table-flat">
        <ErrorState message={apiErrorMessage(error)} onRetry={onRetry} />
      </div>
    );
  }
  if (rows.length === 0) {
    // Audit L-02: an empty collection used to hide the whole
    // search/filter toolbar — the user could not see what was
    // filtering, or clear it. When a search is typed or any filter
    // is active, keep the search row + toolbar above the empty state
    // (with Clear search when a search is active). A genuinely empty
    // collection with no search/filters keeps the plain empty state.
    if (search === "" && !filtersActive) {
      return (
        <div className="sm-table-flat">
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle}
            body={emptyBody}
            {...(emptyActionLabel && onEmptyAction
              ? { actionLabel: emptyActionLabel, onAction: onEmptyAction }
              : {})}
          />
        </div>
      );
    }
    return (
      <div>
        {searchRow}
        {toolbar ? <Toolbar>{toolbar}</Toolbar> : null}
        <div className="sm-table-flat">
          <EmptyState
            icon={emptyIcon}
            title="No results"
            body={
              search
                ? `Nothing matches “${search}”. Try a different search.`
                : "No records match the current filters. Try adjusting the filters."
            }
            {...(search
              ? { actionLabel: "Clear search", onAction: () => onSearchChange("") }
              : {})}
          />
        </div>
      </div>
    );
  }

  const filteredCount = table.getFilteredRowModel().rows.length;
  return (
    <div>
      {searchRow}
      {toolbar ? <Toolbar>{toolbar}</Toolbar> : null}
      {enableRowSelection && selectedRows.length > 0 && bulkActions?.length ? (
        <div className="sm-bulk-bar" role="group" aria-label="Bulk actions">
          <span className="sm-bulk-count">{selectedRows.length} selected</span>
          {bulkActions.map((a) => (
            <Button
              key={a.label}
              variant={a.danger ? "danger" : "secondary"}
              size="sm"
              disabled={a.disabled}
              onClick={() => {
                a.onSelect(selectedRows);
                setRowSelection({});
              }}
            >
              {a.label}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setRowSelection({})}>
            Clear
          </Button>
        </div>
      ) : null}
      {filteredCount === 0 ? (
        <div className="sm-table-flat">
          <EmptyState
            icon={emptyIcon}
            title="No results"
            body={
              search
                ? `Nothing matches “${search}”. Try a different search.`
                : "No records match the current filters. Try adjusting the filters."
            }
            {...(search
              ? { actionLabel: "Clear search", onAction: () => onSearchChange("") }
              : {})}
          />
        </div>
      ) : (
        <div className="sm-table-flat">
          <table className="sm-table">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    // D-01: serverSort → only the listed columns sort,
                    // via the server; disableSorting → nothing sorts.
                    const canSort = disableSorting
                      ? false
                      : serverSort
                        ? serverSort.sortableColumns.includes(header.column.id)
                        : header.column.getCanSort();
                    const sorted = serverSort
                      ? serverSort.value === `${header.column.id}:asc`
                        ? "asc"
                        : serverSort.value === `${header.column.id}:desc`
                          ? "desc"
                          : false
                      : header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        aria-sort={
                          sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : undefined
                        }
                      >
                        {canSort ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (serverSort) {
                                const id = header.column.id;
                                const next =
                                  serverSort.value === `${id}:asc`
                                    ? `${id}:desc`
                                    : serverSort.value === `${id}:desc`
                                      ? undefined
                                      : `${id}:asc`;
                                serverSort.onChange(next);
                              } else {
                                header.column.toggleSorting();
                              }
                            }}
                            aria-label={`Sort by ${String(header.column.columnDef.header ?? header.id)}`}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? (
                              <ArrowUp size={14} strokeWidth={2} />
                            ) : sorted === "desc" ? (
                              <ArrowDown size={14} strokeWidth={2} />
                            ) : (
                              <ArrowUpDown size={14} strokeWidth={2} />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total ?? filteredCount}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DetailFacts — the 4–6 key facts row on detail pages (spec §4.2)     */
/* ------------------------------------------------------------------ */
export function DetailFacts({
  facts,
}: {
  facts: { label: string; value: ReactNode }[];
}) {
  return (
    <div className="sm-facts">
      {facts.map((f) => (
        <div className="sm-fact" key={f.label}>
          <div className="sm-fact-label">{f.label}</div>
          <div className="sm-fact-value">{f.value}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DetailLayout — detail page main column + right inspector rail       */
/* (Neon image-77, audit G7). The key facts that used to render as a   */
/* .sm-facts grid above the content now live in the rail, named for    */
/* the entity ("Product", "Order", …); the main column holds           */
/* everything else (status badge, alerts, cards, tabs, tables). Below  */
/* 1280px the rail stacks under the main column (tokens.css).          */
/* Dialogs, drawers, wizard review steps, and facts inside Cards keep  */
/* the DetailFacts grid — the rail is for top-level detail pages only. */
/* ------------------------------------------------------------------ */
export function DetailLayout({
  title,
  facts,
  children,
}: {
  title: string;
  facts: { label: string; value: ReactNode }[];
  children: ReactNode;
}) {
  return (
    <div className="sm-detail-layout">
      <div className="sm-detail-main">{children}</div>
      <aside className="sm-inspector" aria-label={`${title} details`}>
        <div className="sm-inspector-section">
          <div className="sm-inspector-title">{title}</div>
          {facts.map((f) => (
            <div className="sm-inspector-row" key={f.label}>
              <span className="sm-inspector-label">{f.label}</span>
              <span className="sm-inspector-value">{f.value}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
