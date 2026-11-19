/**
 * TanStack Query client (design spec §12.2).
 *
 * One client for the whole admin SPA. Server state is never duplicated
 * into useState: sections read through useQuery with stable keys and
 * cancel stale requests on unmount / key change (default Query
 * behaviour). Mutations invalidate the affected keys.
 */
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

/** Stable key factory — one key per list so invalidation is exact. */
export const listKey = (section: string) => ["admin", section, "list"] as const;
export const detailKey = (section: string, id: string) =>
  ["admin", section, "detail", id] as const;
