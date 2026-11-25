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
 *   GET  /api/v1/admin/outbox-events[?status=][?q=]
 *   POST /api/v1/admin/outbox-events/:id/replay
 *   POST /api/v1/admin/outbox/dispatch
 *
 * Replay is dead-letter only: the API refuses other statuses.
 * "Dispatch now" runs the same drain the cron runs every minute
 * (real transport — a 2xx records "delivered", no subscribers
 * records "skipped", Meta CAPI stays "simulated") and reports the
 * claimed / delivered / simulated / skipped / retrying /
 * dead-lettered counts.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Webhook } from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { listKey } from "../lib/query";
import { apiErrorMessage, PageHeader, useAdminList, useAdminMutation, useIdempotencyKey } from "../lib/section-kit";
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
  useToast,
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
  // Q3 (2026-11-22): "simulated" — recorded but never sent (no
  // transport configured / Meta CAPI stub). "skipped" — no active
  // endpoint subscribed, so nothing received the event. Both are
  // terminal and must never be mistaken for "delivered".
  status: "pending" | "processing" | "delivered" | "dead_letter" | "simulated" | "skipped";
  attempt_count: number;
  available_at: string;
  locked_until: string | null;
  locked_by: string | null;
  last_error_code: string | null;
  created_at: string;
  processed_at: string | null;
}

/* Dispatch summary — POST /api/v1/admin/outbox/dispatch returns the
   batch counts (apps/api/src/modules/webhooks/service.ts,
   processTransactionalOutboxBatch). Every field is surfaced in the
   toast, including "skipped" (Q3). */
interface DispatchSummary {
  claimed: number;
  delivered: number;
  simulated: number;
  skipped: number;
  retrying: number;
  dead_lettered: number;
}

const OUTBOX_FILTERS = [
  "all",
  "pending",
  "processing",
  "delivered",
  "dead_letter",
  "simulated",
  "skipped",
] as const;
type OutboxFilter = (typeof OUTBOX_FILTERS)[number];

/* D-03: one list-key prefix — replay and dispatch invalidate every
   outbox list query (any filter/search/page) by prefix, so a row
   never sits stale under a filter it just left. */
const OUTBOX_LIST_KEYS = [listKey("outbox-events")] as const;

/* F5 (2026-11-16): filter chips use ONE capitalisation everywhere —
   first letter capitalised ("Pending", "Dead letter"), never a mix
   of lower-case and capitalised labels. */
function filterLabel(f: OutboxFilter): string {
  if (f === "all") return "All";
  if (f === "dead_letter") return "Dead letter";
  return f[0]!.toUpperCase() + f.slice(1);
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
  // D-03: server pagination — page/pageSize thread into the query and
  // the SERVER total is rendered. The old 100-row client window (and
  // the client slice over it) is gone: page N now fetches page N.
  // Search stays server-side (H-01): `?q=` matches the full dataset
  // (event_key / event_type / aggregate_type / aggregate_id / status).
  // Note: searching a resolved display name (e.g. an order number)
  // no longer matches — the order detail page is the way to an
  // order's events.
  const query = useAdminList<OutboxEvent>(
    "outbox-events",
    "/api/v1/admin/outbox-events",
    {
      q: search,
      page,
      pageSize,
      extra: { status: filter !== "all" ? filter : undefined },
    },
  );
  const confirm = useConfirm();
  const rows = query.data ?? [];
  const resourceMaps = useResourceMaps();
  const pageRows = rows;

  // A-04: one key per section instance — a retried replay replays.
  const replayKey = useIdempotencyKey();
  const replay = useAdminMutation<OutboxEvent, string>({
    mutationFn: (eventId) =>
      apiRequest<OutboxEvent>(
        `/api/v1/admin/outbox-events/${eventId}/replay`,
        {
          method: "POST",
          idempotencyKey: replayKey,
        },
      ),
    invalidateKeys: OUTBOX_LIST_KEYS,
    successTitle: "Outbox event replayed",
    successMessage:
      "The event is pending again with its attempt count reset.",
  });

  // Q4: the manual dispatch endpoint existed but nothing called it —
  // the only trigger was the cron. "Dispatch now" runs the same drain
  // on demand and toasts every count the endpoint returns (claimed,
  // delivered, simulated, skipped, retrying, dead-lettered).
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const dispatch = useMutation({
    mutationFn: () =>
      apiRequest<DispatchSummary>("/api/v1/admin/outbox/dispatch", {
        method: "POST",
      }),
    onSuccess: async (summary) => {
      for (const key of OUTBOX_LIST_KEYS) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      toast({
        title: "Outbox dispatched",
        message:
          `Claimed ${summary.claimed} · delivered ${summary.delivered} · ` +
          `simulated ${summary.simulated} · skipped ${summary.skipped} · ` +
          `retrying ${summary.retrying} · dead-lettered ${summary.dead_lettered}.`,
        variant: "success",
      });
    },
    onError: (err) => {
      toast({
        title: "Dispatch failed",
        message: apiErrorMessage(err),
        variant: "danger",
      });
    },
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
        action={
          <Button
            variant="primary"
            loading={dispatch.isPending}
            onClick={() => dispatch.mutate()}
          >
            Dispatch now
          </Button>
        }
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
      ) : rows.length === 0 ? (
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
            total={query.total}
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
