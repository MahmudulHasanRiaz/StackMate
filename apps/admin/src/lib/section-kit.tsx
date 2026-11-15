/**
 * Section kit (design spec §4 + §8 checklist).
 *
 * Shared building blocks for every admin section route. Sections MUST use
 * these instead of inventing their own list/detail patterns:
 *  - PageHeader: breadcrumb + title + subtitle + ONE primary action.
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
  Input,
  Pagination,
  TableSkeleton,
  Toolbar,
  useToast,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* Page header (spec §4.1): breadcrumb, title, subtitle, ONE action    */
/* ------------------------------------------------------------------ */
export function PageHeader({
  breadcrumb,
  title,
  subtitle,
  action,
}: {
  breadcrumb: { label: string; href?: string }[];
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div>
      <Breadcrumb items={breadcrumb} />
      <div className="sm-page-header" style={{ marginTop: 8 }}>
        <div>
          <h1 className="sm-page-title">{title}</h1>
          {subtitle ? <p className="sm-page-subtitle">{subtitle}</p> : null}
        </div>
        {action}
      </div>
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
      <div className="sm-table-wrap">
        <ErrorState message={apiErrorMessage(error)} onRetry={onRetry} />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="sm-table-wrap">
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
      <Toolbar>
        <Input
          className="sm-search-input"
          type="search"
          placeholder="Search…"
          aria-label="Search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {toolbar}
      </Toolbar>
      {filteredCount === 0 ? (
        <div className="sm-table-wrap">
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
        <div className="sm-table-wrap">
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
