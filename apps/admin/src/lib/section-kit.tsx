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
 *  - ListTable: TanStack Table — client-side search/sort/pagination over
 *    the collection the API returns (the API has no server pagination).
 *    Search + page are URL-backed: the section owns them via its route's
 *    search params and passes them in.
 *  - DetailFacts: the 4–6 key facts row on detail pages.
 *
 * All five states (loading / empty / no-results / error / populated) are
 * handled here, so the silent-blank failure is impossible.
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useMutation, useQuery, type UseMutationOptions } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, PackageSearch } from "lucide-react";
import { apiRequest, ApiClientError } from "./api-client";
import { detailKey, listKey, queryClient } from "./query";
import {
  Breadcrumb,
  EmptyState,
  ErrorState,
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
export function useAdminList<T>(section: string, path: string) {
  const query = useQuery({
    queryKey: listKey(section),
    queryFn: async () => {
      const res = await apiRequest<{ items: T[] }>(path);
      return res.items;
    },
  });
  return query;
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
/* bound, so a hung search still settles.                              */
/* ------------------------------------------------------------------ */
export async function loadListOptions<T>(
  path: string,
  query: string,
  toOption: (item: T) => SearchableOption,
  signal?: AbortSignal,
  opts?: { limit?: number },
): Promise<SearchableOption[]> {
  const params = new URLSearchParams({ limit: String(opts?.limit ?? 25) });
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
    return res.items.map(toOption);
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
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const rows = useMemo(() => data ?? [], [data]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: search, pagination: { pageIndex: page - 1, pageSize } },
    onSortingChange: setSorting,
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function"
          ? updater({ pageIndex: page - 1, pageSize })
          : updater;
      if (next.pageIndex !== page - 1) onPageChange(next.pageIndex + 1);
      if (next.pageSize !== pageSize) onPageSizeChange(next.pageSize);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const needle = String(filterValue).toLowerCase();
      return JSON.stringify(row.original).toLowerCase().includes(needle);
    },
    ...(getRowId ? { getRowId: (row: T) => getRowId(row) } : {}),
  });

  if (isLoading) return <TableSkeleton rows={5} />;
  if (isError) {
    return (
      <div className="sm-table-flat">
        <ErrorState message={apiErrorMessage(error)} onRetry={onRetry} />
      </div>
    );
  }
  if (rows.length === 0) {
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

  const filteredCount = table.getFilteredRowModel().rows.length;
  return (
    <div>
      {/* Neon list pattern: the search is full-width, directly under the
          breadcrumb — the toolbar below it holds only filters/actions. */}
      <div className="sm-list-search">
        <Input
          className="sm-search-input"
          type="search"
          placeholder="Search…"
          aria-label="Search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      {toolbar ? <Toolbar>{toolbar}</Toolbar> : null}
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
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
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
                            onClick={() => header.column.toggleSorting()}
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
            total={filteredCount}
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
