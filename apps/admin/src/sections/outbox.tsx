/**
 * Outbox & Deliveries — Administration group (design spec §4.1).
 *
 * Route (registered in router.tsx, under the _main shell): /outbox
 *
 * This used to be the "Outbox events" tab on the webhook detail page
 * (sections/webhooks.tsx); it moved here in the 2026-11-16
 * restructure — the outbox is an audit/report view, not webhook
 * configuration.
 *
 * Endpoints used (all `integrations.manage`):
 *   GET  /api/v1/admin/outbox-events[?status=]
 *   POST /api/v1/admin/outbox-events/:id/replay
 *
 * Replay is dead-letter only: the API refuses other statuses.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Webhook } from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { PageHeader, useAdminMutation } from "../lib/section-kit";
import {
  humanizeType,
  resolveResourceName,
  shortId,
  useResourceMaps,
} from "../lib/resolve-names";
import {
  Button,
  Chip,
  DateTimeCell,
  Dialog,
  ErrorState,
  Input,
  Pagination,
  StatusBadge,
  TableSkeleton,
  Toolbar,
  useConfirm,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* DTO (apps/api/src/platform/db/store.ts — OutboxEventRecord)          */
/* ------------------------------------------------------------------ */
export interface OutboxEvent {
  id: string;
  event_key: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "delivered" | "dead_letter";
  attempt_count: number;
  available_at: string;
  locked_until: string | null;
  locked_by: string | null;
  last_error_code: string | null;
  created_at: string;
  processed_at: string | null;
}

const OUTBOX_FILTERS = [
  "all",
  "pending",
  "processing",
  "delivered",
  "dead_letter",
] as const;
type OutboxFilter = (typeof OUTBOX_FILTERS)[number];

/* F5 (2026-11-16): filter chips use ONE capitalisation everywhere —
   first letter capitalised ("Pending", "Dead letter"), never a mix
   of lower-case and capitalised labels. */
function filterLabel(f: OutboxFilter): string {
  if (f === "all") return "All";
  if (f === "dead_letter") return "Dead letter";
  return f[0]!.toUpperCase() + f.slice(1);
}

function useOutboxEvents(filter: OutboxFilter) {
  return useQuery({
    queryKey: ["admin", "outbox-events", "list", filter],
    queryFn: async () => {
      // The API defaults lists to 25 rows — ask for the max window
      // (100). The endpoint has no ?q=, so search stays client-side
      // over the loaded collection (see the M-05 note below).
      const path =
        filter === "all"
          ? "/api/v1/admin/outbox-events?limit=100"
          : `/api/v1/admin/outbox-events?status=${filter}&limit=100`;
      const res = await apiRequest<{ items: OutboxEvent[] }>(path);
      return res.items;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */
export function OutboxSection() {
  const [filter, setFilter] = useState<OutboxFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [viewEvent, setViewEvent] = useState<OutboxEvent | null>(null);
  const query = useOutboxEvents(filter);
  const confirm = useConfirm();
  const rows = query.data ?? [];
  const resourceMaps = useResourceMaps();
  // M-05: search. The endpoint has no ?q= (it only reads ?status=),
  // so this filters client-side over the loaded collection — the same
  // established pattern as this page's client-side paging (F6). A
  // server ?q= is the core API agent's follow-up if the outbox grows.
  const needle = search.trim().toLowerCase();
  const filteredRows =
    needle.length === 0
      ? rows
      : rows.filter((e) => {
          const hay = [
            e.event_key,
            e.event_type,
            e.aggregate_type,
            e.aggregate_id,
            resolveResourceName(e.aggregate_type, e.aggregate_id, resourceMaps) ?? "",
            e.last_error_code ?? "",
          ]
            .join(" ")
            .toLowerCase();
          return hay.includes(needle);
        });
  /* F6 (2026-11-16): the outbox had no pagination — client-side paging
     over the loaded collection, like ListTable. */
  const pageRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);

  const replay = useAdminMutation<OutboxEvent, string>({
    mutationFn: (eventId) =>
      apiRequest<OutboxEvent>(
        `/api/v1/admin/outbox-events/${eventId}/replay`,
        {
          method: "POST",
        },
      ),
    invalidateKeys: [
      ["admin", "outbox-events", "list", "all"],
      ["admin", "outbox-events", "list", "pending"],
      ["admin", "outbox-events", "list", "processing"],
      ["admin", "outbox-events", "list", "delivered"],
      ["admin", "outbox-events", "list", "dead_letter"],
    ],
    successTitle: "Outbox event replayed",
    successMessage:
      "The event is pending again with its attempt count reset.",
  });

  return (
    <section aria-labelledby="outbox-heading">
      <PageHeader
        breadcrumb={[
          { label: "Administration" },
          { label: "Outbox & Deliveries" },
        ]}
        title="Outbox & Deliveries"
        help="Transactional outbox — every event the platform must deliver, and its retries"
      />
      <Toolbar>
        <Input
          id="outbox-search"
          name="q"
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search events…"
          aria-label="Search outbox events"
          autoComplete="off"
        />
        {OUTBOX_FILTERS.map((f) => (
          <Chip
            key={f}
            active={filter === f}
            onClick={() => {
              setFilter(f);
              setPage(1);
            }}
          >
            {filterLabel(f)}
          </Chip>
        ))}
      </Toolbar>
      {query.isPending ? (
        <TableSkeleton rows={5} />
      ) : query.isError ? (
        <div className="sm-table-flat">
          <ErrorState
            message={
              query.error instanceof Error
                ? query.error.message
                : "Could not load outbox events."
            }
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="sm-table-flat">
          <div className="sm-empty">
            <Webhook size={18} strokeWidth={2} className="sm-empty-icon" />
            <div className="sm-empty-title">No outbox events</div>
            <p>
              {rows.length === 0
                ? filter === "all"
                  ? "No outbox events have been recorded yet."
                  : `No ${filter === "dead_letter" ? "dead-lettered" : filter} outbox events.`
                : `No outbox events match “${search.trim()}”.`}
            </p>
          </div>
        </div>
      ) : (
        <div className="sm-table-flat">
          <table className="sm-table">
            <thead>
              <tr>
                <th>Event key</th>
                <th>Type</th>
                <th>Aggregate</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Created</th>
                <th>Processed</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="sm-mono">{e.event_key}</span>
                  </td>
                  <td>{e.event_type}</td>
                  <td>
                    {humanizeType(e.aggregate_type)} ·{" "}
                    <span className="sm-break">
                      {resolveResourceName(
                        e.aggregate_type,
                        e.aggregate_id,
                        resourceMaps,
                      ) ?? shortId(e.aggregate_id)}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td>
                    <span className="sm-tabular">{e.attempt_count}</span>
                  </td>
                  <td>{e.last_error_code ?? "—"}</td>
                  <td>
                    <DateTimeCell value={e.created_at} />
                  </td>
                  <td>
                    <DateTimeCell value={e.processed_at} />
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 8 }}>
                      <Button variant="ghost" size="sm" onClick={() => setViewEvent(e)}>
                        View
                      </Button>
                      {e.status === "dead_letter" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={replay.isPending && replay.variables === e.id}
                          onClick={() =>
                            void (async () => {
                              const ok = await confirm({
                                title: "Replay outbox event?",
                                body: (
                                  <div>
                                    <p>
                                      {e.event_key} returns to pending with its
                                      attempt count reset to 0 and will be
                                      dispatched again.
                                    </p>
                                    <p>
                                      Only dead-lettered events can be replayed.
                                    </p>
                                  </div>
                                ),
                                confirmLabel: "Replay",
                              });
                              if (ok) replay.mutate(e.id);
                            })()
                          }
                        >
                          Replay
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={filteredRows.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        </div>
      )}
      <Dialog
        open={viewEvent !== null}
        onClose={() => setViewEvent(null)}
        title={viewEvent ? `Outbox event ${viewEvent.event_key}` : "Outbox event"}
        footer={
          <Button variant="secondary" onClick={() => setViewEvent(null)}>
            Close
          </Button>
        }
      >
        {viewEvent ? (
          <div>
            <p className="sm-hint">
              {viewEvent.event_type} · {humanizeType(viewEvent.aggregate_type)} ·{" "}
              {viewEvent.status} · {viewEvent.attempt_count} attempt
              {viewEvent.attempt_count === 1 ? "" : "s"}
            </p>
            <pre
              className="sm-mono"
              style={{
                marginTop: 12,
                padding: "var(--sm-space-3)",
                background: "var(--sm-surface-muted)",
                border: "1px solid var(--sm-border)",
                borderRadius: 4,
                overflow: "auto",
                maxHeight: 320,
                fontSize: 12,
              }}
            >
              {JSON.stringify(viewEvent.payload, null, 2)}
            </pre>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
