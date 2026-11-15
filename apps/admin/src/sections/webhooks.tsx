/**
 * Webhooks & Outbox (design spec §4.1/§4.2).
 *
 * Routes (registered in router.tsx):
 *   /webhooks, /webhooks/$webhookId
 *
 * Search is read with `useSearch({ strict: false })`: the route id is
 * "/_main/webhooks" (the operational shell is a pathless `_main`
 * layout route), so a plain-path `from: "/webhooks"` throws
 * "Invariant failed" at render (jsdom repro 2026-11-15).
 *
 * Endpoints used (all `integrations.manage`):
 *   GET  /api/v1/admin/webhooks
 *   POST /api/v1/admin/webhooks
 *   POST /api/v1/admin/webhooks/:id/test
 *   GET  /api/v1/admin/webhooks/:id/deliveries
 *   GET  /api/v1/admin/outbox-events[?status=]
 *   POST /api/v1/admin/outbox-events/:id/replay
 *   GET  /api/v1/admin/integrated-sites (site names)
 *
 * MISSING ENDPOINT — there is NO GET /api/v1/admin/webhooks/:id.
 * The detail page therefore reads the endpoint from the webhook list
 * and shows "Webhook endpoint not found" when the id is absent.
 *
 * HONESTY NOTE — outbound webhook delivery in production is still
 * simulated (the outbox dispatcher's default transport never makes a
 * real HTTP call). Only the test endpoint performs a real fetch (10s
 * timeout) and its result is shown verbatim. This UI never claims a
 * production delivery reached its destination.
 */
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, FlaskConical, Plus, Webhook } from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { detailKey, listKey } from "../lib/query";
import {
  DetailFacts,
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminDetail,
  useAdminList,
  useAdminMutation,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  Chip,
  CopyButton,
  DateCell,
  DateTimeCell,
  Dialog,
  ErrorState,
  Field,
  Input,
  RowMenu,
  Select,
  StatusBadge,
  TableSkeleton,
  Tabs,
  Toolbar,
  useConfirm,
} from "../components/primitives";
import type { IntegratedSite } from "./integrations";

/* ------------------------------------------------------------------ */
/* Route helpers (see header note)                                     */
/* ------------------------------------------------------------------ */
function useRouteSearch() {
  // No `from`: the route id is "/_main/webhooks" (pathless `_main`
  // layout parent), so a plain-path `from: "/webhooks"` throws
  // "Invariant failed" at render (jsdom repro 2026-11-15). Read the
  // current route's search like the other list sections.
  return useSearch({ strict: false }) as unknown as Record<string, unknown>;
}

function useRouteNavigate() {
  const navigate = useNavigate();
  return (options: {
    to: string;
    search?: Record<string, unknown>;
    params?: Record<string, string>;
  }) => navigate(options as never);
}

/* ------------------------------------------------------------------ */
/* DTOs (apps/api/src/platform/db/store.ts)                            */
/* ------------------------------------------------------------------ */
export interface WebhookEndpoint {
  id: string;
  integrated_site_id: string | null;
  url: string;
  description: string;
  subscribed_events: string[];
  status: "active" | "disabled" | "revoked";
  secret_key_id: string;
  key_version: string;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_endpoint_id: string;
  event_id: string;
  delivery_id: string;
  status: "pending" | "delivered" | "retrying" | "failed";
  attempt_count: number;
  last_http_status: number | null;
  delivered_at: string | null;
}

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

interface RegisteredWebhook {
  endpoint: WebhookEndpoint;
  raw_signing_secret_once: string;
}

interface WebhookTestResult {
  endpoint_id: string;
  delivery_id: string;
  event_type: string;
  http_status: number | null;
  delivered: boolean;
  error: string | null;
}

const OUTBOX_FILTERS = ["all", "pending", "processing", "delivered", "dead_letter"] as const;
type OutboxFilter = (typeof OUTBOX_FILTERS)[number];

function useOutboxEvents(filter: OutboxFilter) {
  return useQuery({
    queryKey: ["admin", "outbox-events", "list", filter],
    queryFn: async () => {
      const path =
        filter === "all"
          ? "/api/v1/admin/outbox-events"
          : `/api/v1/admin/outbox-events?status=${filter}`;
      const res = await apiRequest<{ items: OutboxEvent[] }>(path);
      return res.items;
    },
  });
}

/** Test-result banner: shows the real fetch outcome verbatim. */
function TestResultBanner({
  result,
  onDismiss,
}: {
  result: WebhookTestResult;
  onDismiss: () => void;
}) {
  return (
    <Alert
      variant={result.delivered ? "success" : "danger"}
      onDismiss={onDismiss}
    >
      {result.delivered
        ? `Test delivered — HTTP ${result.http_status ?? "—"} (delivery ${result.delivery_id}).`
        : `Test failed — HTTP ${result.http_status ?? "—"}${result.error ? `: ${result.error}` : ""} (delivery ${result.delivery_id}).`}
    </Alert>
  );
}

/* ------------------------------------------------------------------ */
/* List: /webhooks                                                     */
/* ------------------------------------------------------------------ */
export function WebhooksSection() {
  const rawSearch = useRouteSearch();
  const search = parseListSearch(rawSearch);
  const navigate = useRouteNavigate();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [newSecret, setNewSecret] = useState<{
    keyId: string;
    secret: string;
  } | null>(null);
  const [lastTest, setLastTest] = useState<WebhookTestResult | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const query = useAdminList<WebhookEndpoint>(
    "webhooks",
    "/api/v1/admin/webhooks",
  );
  const sitesQuery = useAdminList<IntegratedSite>(
    "integrated-sites",
    "/api/v1/admin/integrated-sites",
  );
  const siteNames = new Map(
    (sitesQuery.data ?? []).map((s) => [s.id, s.name]),
  );

  const setSearch = (patch: Record<string, string | number | undefined>) => {
    const next: Record<string, unknown> = {
      q: search.q,
      page: search.page,
      pageSize: search.pageSize,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    navigate({ to: "/webhooks", search: next });
  };

  const runTest = async (endpointId: string) => {
    setTestingId(endpointId);
    try {
      const result = await apiRequest<WebhookTestResult>(
        `/api/v1/admin/webhooks/${endpointId}/test`,
        { method: "POST" },
      );
      setLastTest(result);
    } catch (err) {
      setLastTest({
        endpoint_id: endpointId,
        delivery_id: "—",
        event_type: "webhook.test",
        http_status: null,
        delivered: false,
        error: err instanceof Error ? err.message : "Test request failed.",
      });
    } finally {
      setTestingId(null);
    }
  };

  const columns: ColumnDef<WebhookEndpoint, unknown>[] = [
    {
      header: "URL",
      accessorKey: "url",
      cell: ({ row }) => <span className="sm-mono">{row.original.url}</span>,
    },
    {
      header: "Description",
      accessorKey: "description",
      cell: ({ row }) => row.original.description,
    },
    {
      header: "Site",
      accessorKey: "integrated_site_id",
      cell: ({ row }) =>
        row.original.integrated_site_id
          ? (siteNames.get(row.original.integrated_site_id) ?? (
              <span className="sm-mono">{row.original.integrated_site_id}</span>
            ))
          : "—",
    },
    {
      header: "Events",
      accessorKey: "subscribed_events",
      enableSorting: false,
      cell: ({ row }) => row.original.subscribed_events.join(", "),
    },
    {
      header: "Status",
      accessorKey: "status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      header: "Secret key",
      accessorKey: "secret_key_id",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="sm-mono">
          {row.original.secret_key_id}
          <CopyButton
            value={row.original.secret_key_id}
            label="Copy secret key ID"
          />
        </span>
      ),
    },
    {
      header: "Created",
      accessorKey: "created_at",
      cell: ({ row }) => <DateCell value={row.original.created_at} />,
    },
    {
      header: "Actions",
      id: "actions",
      enableSorting: false,
      cell: ({ row }) => {
        const ep = row.original;
        // 2+ row actions → one "…" menu (Neon Branches pattern). The test
        // result surfaces in the page's last-test panel; the mutation
        // toasts report success/failure, so no inline spinner is lost.
        return (
          <RowMenu
            items={[
              {
                icon: FlaskConical,
                label: "Test delivery",
                disabled: ep.status !== "active" || testingId === ep.id,
                onSelect: () => void runTest(ep.id),
              },
              {
                icon: Eye,
                label: "View details",
                onSelect: () =>
                  navigate({
                    to: "/webhooks/$webhookId",
                    params: { webhookId: ep.id },
                  }),
              },
            ]}
          />
        );
      },
    },
  ];

  return (
    <section aria-labelledby="webhooks-heading">
      <PageHeader
        breadcrumb={[{ label: "Integrations" }, { label: "Webhooks & Outbox" }]}
        title="Webhooks & Outbox"
        subtitle="Outbound webhook endpoints and the transactional outbox"
        action={
          <Button variant="primary" icon={Plus} onClick={() => setRegisterOpen(true)}>
            Register webhook
          </Button>
        }
      />
      {newSecret ? (
        <Alert
          variant="warning"
          onDismiss={() => setNewSecret(null)}
        >
          <div>
            <strong>Signing secret {newSecret.keyId} created</strong> — copy it
            now. It will not be shown again.
            <div className="sm-mono">{newSecret.secret}</div>
          </div>
          <CopyButton value={newSecret.secret} label="Copy signing secret" />
        </Alert>
      ) : null}
      {lastTest ? (
        <TestResultBanner
          result={lastTest}
          onDismiss={() => setLastTest(null)}
        />
      ) : null}
      <Alert variant="info">
        Production delivery is still simulated — only the Test button makes a
        real HTTP call (10s timeout).
      </Alert>
      <ListTable<WebhookEndpoint>
        columns={columns}
        data={query.data}
        search={search.q ?? ""}
        onSearchChange={(q) => setSearch({ q: q || undefined, page: 1 })}
        page={search.page ?? 1}
        onPageChange={(page) => setSearch({ page })}
        pageSize={search.pageSize ?? 25}
        onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={Webhook}
        emptyTitle="No webhook endpoints yet"
        emptyBody="Register an endpoint to receive event deliveries."
        emptyActionLabel="Register webhook"
        onEmptyAction={() => setRegisterOpen(true)}
        getRowId={(row) => row.id}
      />
      <RegisterWebhookDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onCreated={(data) => {
          setNewSecret({
            keyId: data.endpoint.secret_key_id,
            secret: data.raw_signing_secret_once,
          });
          setRegisterOpen(false);
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Register webhook dialog                                             */
/* ------------------------------------------------------------------ */
function RegisterWebhookDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (data: RegisteredWebhook) => void;
}) {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [siteId, setSiteId] = useState("");
  const [events, setEvents] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const sitesQuery = useAdminList<IntegratedSite>(
    "integrated-sites",
    "/api/v1/admin/integrated-sites",
  );

  const create = useAdminMutation<RegisteredWebhook, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<RegisteredWebhook>("/api/v1/admin/webhooks", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("webhooks")],
    successTitle: "Webhook registered",
    onSuccess: (data) => onCreated(data),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const doSubmit = () => {
    const next: Record<string, string> = {};
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
        next.url = "Enter a valid http(s) URL.";
    } catch {
      next.url = "Enter a valid URL.";
    }
    if (description.trim().length < 2)
      next.description = "Description must be at least 2 characters.";
    const parsedEvents = events
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsedEvents.length === 0)
      next.events = "Subscribe to at least one event.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    create.mutate({
      url: url.trim(),
      description: description.trim(),
      integrated_site_id: siteId || null,
      subscribed_events: parsedEvents,
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Register webhook"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={doSubmit}>
            Register webhook
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="URL" required error={errors.url ?? ""} htmlFor="wh-url">
          <Input
            id="wh-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/stackmate-webhook"
            aria-invalid={Boolean(errors.url) || undefined}
          />
        </Field>
        <Field
          label="Description"
          required
          error={errors.description ?? ""}
          htmlFor="wh-desc"
        >
          <Input
            id="wh-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-invalid={Boolean(errors.description) || undefined}
          />
        </Field>
        <Field label="Integrated site" htmlFor="wh-site">
          <Select
            id="wh-site"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
          >
            <option value="">All sites (no site)</option>
            {(sitesQuery.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Subscribed events"
          required
          hint="Comma-separated event names."
          error={errors.events ?? ""}
          htmlFor="wh-events"
        >
          <Input
            id="wh-events"
            value={events}
            onChange={(e) => setEvents(e.target.value)}
            placeholder="order.paid, subscription.renewed"
            aria-invalid={Boolean(errors.events) || undefined}
          />
        </Field>
        <p className="sm-hint">
          The signing secret is shown once after registration. Copy it before
          closing.
        </p>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Detail: /webhooks/$webhookId — tabs: Deliveries, Outbox events     */
/* No GET /api/v1/admin/webhooks/:id exists, so the endpoint is read  */
/* from the list.                                                       */
/* ------------------------------------------------------------------ */
export function WebhookDetailSection({ id }: { id: string }) {
  const [tab, setTab] = useState("deliveries");
  const [lastTest, setLastTest] = useState<WebhookTestResult | null>(null);
  const navigate = useRouteNavigate();

  const listQuery = useAdminList<WebhookEndpoint>(
    "webhooks",
    "/api/v1/admin/webhooks",
  );
  const endpoint = (listQuery.data ?? []).find((e) => e.id === id);
  const sitesQuery = useAdminList<IntegratedSite>(
    "integrated-sites",
    "/api/v1/admin/integrated-sites",
  );
  const siteName = endpoint?.integrated_site_id
    ? (sitesQuery.data ?? []).find((s) => s.id === endpoint.integrated_site_id)
        ?.name ?? endpoint.integrated_site_id
    : null;

  const test = useAdminMutation<WebhookTestResult, void>({
    mutationFn: () =>
      apiRequest<WebhookTestResult>(`/api/v1/admin/webhooks/${id}/test`, {
        method: "POST",
      }),
    invalidateKeys: [detailKey("webhook-deliveries", id)],
    successTitle: "Test finished",
    onSuccess: (data) => setLastTest(data),
  });

  if (listQuery.isPending) {
    return (
      <section aria-labelledby="webhook-detail-heading">
        <PageHeader
          breadcrumb={[
            { label: "Integrations" },
            { label: "Webhooks & Outbox", href: "/webhooks" },
          ]}
          title="Webhook endpoint"
        />
        <TableSkeleton rows={4} />
      </section>
    );
  }

  if (listQuery.isError || !endpoint) {
    return (
      <section aria-labelledby="webhook-detail-heading">
        <PageHeader
          breadcrumb={[
            { label: "Integrations" },
            { label: "Webhooks & Outbox", href: "/webhooks" },
          ]}
          title="Webhook endpoint"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={
              listQuery.isError && listQuery.error instanceof Error
                ? listQuery.error.message
                : "Webhook endpoint not found."
            }
            onRetry={() => void listQuery.refetch()}
          />
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="webhook-detail-heading">
      <PageHeader
        breadcrumb={[
          { label: "Integrations" },
          { label: "Webhooks & Outbox", href: "/webhooks" },
          { label: endpoint.description },
        ]}
        title={endpoint.description}
        subtitle={endpoint.url}
        action={
          <Button
            variant="primary"
            disabled={endpoint.status !== "active"}
            loading={test.isPending}
            onClick={() => test.mutate()}
          >
            Test endpoint
          </Button>
        }
      />
      {lastTest ? (
        <TestResultBanner
          result={lastTest}
          onDismiss={() => setLastTest(null)}
        />
      ) : null}
      <Alert variant="info">
        Production delivery is still simulated — only the Test button makes a
        real HTTP call (10s timeout).
      </Alert>
      <Toolbar>
        <StatusBadge status={endpoint.status} />
        <span className="sm-mono">
          {endpoint.secret_key_id}
          <CopyButton
            value={endpoint.secret_key_id}
            label="Copy secret key ID"
          />
        </span>
      </Toolbar>
      <DetailFacts
        facts={[
          { label: "URL", value: endpoint.url },
          { label: "Site", value: siteName ?? "—" },
          {
            label: "Subscribed events",
            value: endpoint.subscribed_events.join(", "),
          },
          { label: "Key version", value: endpoint.key_version },
          { label: "Created", value: <DateCell value={endpoint.created_at} /> },
        ]}
      />
      <Tabs
        tabs={[
          { key: "deliveries", label: "Deliveries" },
          { key: "outbox", label: "Outbox events" },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === "deliveries" ? (
        <WebhookDeliveriesTab webhookId={id} />
      ) : (
        <OutboxTab />
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate({ to: "/webhooks" })}
      >
        ← Back to webhooks
      </Button>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Deliveries tab                                                      */
/* ------------------------------------------------------------------ */
function WebhookDeliveriesTab({ webhookId }: { webhookId: string }) {
  const query = useAdminDetail<{ items: WebhookDelivery[] }>(
    "webhook-deliveries",
    webhookId,
    `/api/v1/admin/webhooks/${webhookId}/deliveries`,
  );
  // NOTE: useAdminDetail returns the unwrapped envelope `data`, which for
  // a collection endpoint is `{ items: [...] }`.
  const rows = query.data?.items ?? [];

  if (query.isPending) return <TableSkeleton rows={5} />;
  if (query.isError) {
    return (
      <div className="sm-table-wrap">
        <ErrorState
          message={
            query.error instanceof Error
              ? query.error.message
              : "Could not load deliveries."
          }
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="sm-table-wrap">
        <div className="sm-empty">
          <Webhook size={18} strokeWidth={2} className="sm-empty-icon" />
          <div className="sm-empty-title">No deliveries yet</div>
          <p>Deliveries appear here after events are sent or tested.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="sm-table-wrap">
      <table className="sm-table">
        <thead>
          <tr>
            <th>Delivery ID</th>
            <th>Event ID</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>HTTP status</th>
            <th>Delivered at</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>
                <span className="sm-mono">{d.delivery_id}</span>
              </td>
              <td>
                <span className="sm-mono">{d.event_id}</span>
              </td>
              <td>
                <StatusBadge status={d.status} />
              </td>
              <td>
                <span className="sm-tabular">{d.attempt_count}</span>
              </td>
              <td>
                <span className="sm-tabular">{d.last_http_status ?? "—"}</span>
              </td>
              <td>
                <DateTimeCell value={d.delivered_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Outbox tab                                                          */
/* ------------------------------------------------------------------ */
function OutboxTab() {
  const [filter, setFilter] = useState<OutboxFilter>("all");
  const query = useOutboxEvents(filter);
  const confirm = useConfirm();
  const rows = query.data ?? [];

  const replay = useAdminMutation<OutboxEvent, string>({
    mutationFn: (eventId) =>
      apiRequest<OutboxEvent>(`/api/v1/admin/outbox-events/${eventId}/replay`, {
        method: "POST",
      }),
    invalidateKeys: [
      ["admin", "outbox-events", "list", "all"],
      ["admin", "outbox-events", "list", "pending"],
      ["admin", "outbox-events", "list", "processing"],
      ["admin", "outbox-events", "list", "delivered"],
      ["admin", "outbox-events", "list", "dead_letter"],
    ],
    successTitle: "Outbox event replayed",
    successMessage: "The event is pending again with its attempt count reset.",
  });

  return (
    <div>
      <Toolbar>
        {OUTBOX_FILTERS.map((f) => (
          <Chip
            key={f}
            active={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === "all"
              ? "All"
              : f === "dead_letter"
                ? "Dead letter"
                : f}
          </Chip>
        ))}
      </Toolbar>
      {query.isPending ? (
        <TableSkeleton rows={5} />
      ) : query.isError ? (
        <div className="sm-table-wrap">
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
        <div className="sm-table-wrap">
          <div className="sm-empty">
            <Webhook size={18} strokeWidth={2} className="sm-empty-icon" />
            <div className="sm-empty-title">No outbox events</div>
            <p>
              {filter === "all"
                ? "No outbox events have been recorded yet."
                : `No ${filter === "dead_letter" ? "dead-lettered" : filter} outbox events.`}
            </p>
          </div>
        </div>
      ) : (
        <div className="sm-table-wrap">
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
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="sm-mono">{e.event_key}</span>
                  </td>
                  <td>{e.event_type}</td>
                  <td>
                    {e.aggregate_type} ·{" "}
                    <span className="sm-mono">{e.aggregate_id}</span>
                  </td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td>
                    <span className="sm-tabular">{e.attempt_count}</span>
                  </td>
                  <td>{e.last_error_code ?? "—"}</td>
                  <td>
                    <DateCell value={e.created_at} />
                  </td>
                  <td>
                    <DateTimeCell value={e.processed_at} />
                  </td>
                  <td>
                    {e.status === "dead_letter" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={
                          replay.isPending && replay.variables === e.id
                        }
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
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
