/**
 * Audit Log — read-only record of staff, system, and integration actions.
 *
 * GET /api/v1/admin/audit-logs (audit_logs.read). The API returns the full
 * collection with NO server-side filters, so action / resource / outcome /
 * actor filters are applied client-side over the loaded collection.
 * Search, page, and pageSize are URL-backed via the route search params;
 * filters are URL-backed the same way. There are no mutation endpoints
 * for audit logs (read-only by design) — this section creates nothing.
 *
 * Changes are sanitized server-side (passwords/secrets redacted) and are
 * rendered exactly as returned; nothing here ever tries to un-redact.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, ScrollText } from "lucide-react";
import {
  Button,
  CopyButton,
  DateTimeCell,
  Drawer,
  IconButton,
  Select,
  StatusBadge,
} from "../components/primitives";
import {
  DetailFacts,
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminList,
} from "../lib/section-kit";

interface AuditLogRecord {
  id: string;
  actor_type: "staff" | "system" | "integration";
  actor_user_id: string | null;
  integrated_site_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: "success" | "denied" | "failed";
  request_id: string;
  changes: Record<string, unknown>;
  created_at: string;
  created_date_display?: string;
}

interface AuditLogSearch {
  q?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  action?: string | undefined;
  resource_type?: string | undefined;
  outcome?: string | undefined;
  actor_type?: string | undefined;
}

function parseAuditLogSearch(search: Record<string, unknown>): AuditLogSearch {
  const base = parseListSearch(search);
  const pick = (key: string): string | undefined => {
    const value = search[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  return {
    ...base,
    action: pick("action"),
    resource_type: pick("resource_type"),
    outcome: pick("outcome"),
    actor_type: pick("actor_type"),
  };
}

function distinctSorted(values: (string | null | undefined)[]): string[] {
  return Array.from(
    new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0)),
  ).sort();
}

function renderChangeValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    return <pre className="sm-mono">{JSON.stringify(value, null, 2)}</pre>;
  }
  return String(value);
}

export function AuditLogsSection() {
  // No `from` until the parent wires the /audit-logs route in router.tsx:
  // the route id does not exist in the registered router type yet, so a
  // strict `from` rejects the literal path at type level. `strict: false`
  // reads the search of the route this component renders under (which
  // will be /audit-logs). Once the route lands (with validateSearch),
  // switch both hooks to `useSearch({ from: "/audit-logs" })` /
  // `useNavigate({ from: "/audit-logs" })`.
  const rawSearch = useSearch({ strict: false });
  const search = parseAuditLogSearch(rawSearch as Record<string, unknown>);
  // No `from`/`to` here either (same unregistered-route reason): the
  // untyped hook navigates relative to the current route, and the full
  // next search object is built from the parsed current search, so no
  // state is lost. Router drops `undefined` search params when
  // serializing the URL. The cast below only bridges the type gap until
  // the route is registered; after wiring, replace with
  // `useNavigate({ from: "/audit-logs" })` and drop the cast.
  const navigate = useNavigate() as unknown as (opts: {
    search: AuditLogSearch;
  }) => void;
  const [selected, setSelected] = useState<AuditLogRecord | null>(null);

  const query = useAdminList<AuditLogRecord>(
    "audit-logs",
    "/api/v1/admin/audit-logs",
  );

  const actions = useMemo(
    () => distinctSorted((query.data ?? []).map((e) => e.action)),
    [query.data],
  );
  const resourceTypes = useMemo(
    () => distinctSorted((query.data ?? []).map((e) => e.resource_type)),
    [query.data],
  );
  const actorTypes = useMemo(
    () => distinctSorted((query.data ?? []).map((e) => e.actor_type)),
    [query.data],
  );

  const filtersActive = Boolean(
    search.action ?? search.resource_type ?? search.outcome ?? search.actor_type,
  );

  const filtered = useMemo(
    () =>
      (query.data ?? []).filter(
        (e) =>
          (!search.action || e.action === search.action) &&
          (!search.resource_type || e.resource_type === search.resource_type) &&
          (!search.outcome || e.outcome === search.outcome) &&
          (!search.actor_type || e.actor_type === search.actor_type),
      ),
    [
      query.data,
      search.action,
      search.resource_type,
      search.outcome,
      search.actor_type,
    ],
  );

  const updateSearch = (patch: Partial<AuditLogSearch>, resetPage: boolean) => {
    const next: AuditLogSearch = {
      ...search,
      ...patch,
      ...(resetPage ? { page: 1 } : {}),
    };
    void navigate({ search: next });
  };

  const clearFilters = () => {
    updateSearch(
      {
        q: undefined,
        action: undefined,
        resource_type: undefined,
        outcome: undefined,
        actor_type: undefined,
      },
      true,
    );
  };

  const columns: ColumnDef<AuditLogRecord, unknown>[] = useMemo(
    () => [
      {
        accessorKey: "created_at",
        header: "Timestamp",
        cell: ({ row }) => <DateTimeCell value={row.original.created_at} />,
      },
      {
        accessorKey: "action",
        header: "Action",
        cell: ({ row }) => <span className="sm-mono">{row.original.action}</span>,
      },
      {
        accessorKey: "resource_type",
        header: "Resource",
        cell: ({ row }) => (
          <div>
            <span className="sm-mono">{row.original.resource_type}</span>
            <div className="sm-mono sm-hint">{row.original.resource_id}</div>
          </div>
        ),
      },
      {
        accessorKey: "actor_type",
        header: "Actor",
        cell: ({ row }) => (
          <div>
            {row.original.actor_type}
            {row.original.actor_user_id ? (
              <div className="sm-mono sm-hint">{row.original.actor_user_id}</div>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "outcome",
        header: "Outcome",
        cell: ({ row }) => <StatusBadge status={row.original.outcome} />,
      },
      {
        accessorKey: "request_id",
        header: "Request ID",
        cell: ({ row }) => (
          <span>
            <span className="sm-mono">{row.original.request_id}</span>
            <CopyButton value={row.original.request_id} label="Copy request ID" />
          </span>
        ),
      },
      {
        id: "view",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <IconButton
            label={`View audit event ${row.original.action}`}
            icon={Eye}
            onClick={() => setSelected(row.original)}
          />
        ),
      },
    ],
    [],
  );

  const changeEntries = selected ? Object.entries(selected.changes ?? {}) : [];

  return (
    <section aria-labelledby="audit-logs-heading">
      <PageHeader
        breadcrumb={[{ label: "Administration" }, { label: "Audit Log" }]}
        title="Audit Log"
        subtitle="Immutable record of staff, system, and integration actions"
      />
      <ListTable<AuditLogRecord>
        columns={columns}
        data={filtered}
        search={search.q ?? ""}
        onSearchChange={(q) => updateSearch({ q: q === "" ? undefined : q }, true)}
        page={search.page ?? 1}
        onPageChange={(page) => updateSearch({ page }, false)}
        pageSize={search.pageSize ?? 25}
        onPageSizeChange={(pageSize) => updateSearch({ pageSize }, true)}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        getRowId={(row) => row.id}
        emptyIcon={ScrollText}
        emptyTitle={
          filtersActive || search.q
            ? "No matching audit events"
            : "No audit events yet"
        }
        emptyBody={
          filtersActive || search.q
            ? "No audit events match the current search or filters."
            : "Audit events will appear here when staff, the system, or an integration acts."
        }
        {...(filtersActive || search.q
          ? { emptyActionLabel: "Clear search and filters", onEmptyAction: clearFilters }
          : {})}
        toolbar={
          <>
            <Select
              aria-label="Filter by action"
              value={search.action ?? ""}
              onChange={(e) =>
                updateSearch(
                  { action: e.target.value === "" ? undefined : e.target.value },
                  true,
                )
              }
            >
              <option value="">All actions</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by resource type"
              value={search.resource_type ?? ""}
              onChange={(e) =>
                updateSearch(
                  { resource_type: e.target.value === "" ? undefined : e.target.value },
                  true,
                )
              }
            >
              <option value="">All resources</option>
              {resourceTypes.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by outcome"
              value={search.outcome ?? ""}
              onChange={(e) =>
                updateSearch(
                  { outcome: e.target.value === "" ? undefined : e.target.value },
                  true,
                )
              }
            >
              <option value="">All outcomes</option>
              <option value="success">Success</option>
              <option value="denied">Denied</option>
              <option value="failed">Failed</option>
            </Select>
            <Select
              aria-label="Filter by actor type"
              value={search.actor_type ?? ""}
              onChange={(e) =>
                updateSearch(
                  { actor_type: e.target.value === "" ? undefined : e.target.value },
                  true,
                )
              }
            >
              <option value="">All actors</option>
              {actorTypes.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
            {filtersActive ? (
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </>
        }
      />
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? selected.action : "Audit event"}
      >
        {selected ? (
          <div>
            <DetailFacts
              facts={[
                {
                  label: "Timestamp",
                  value: <DateTimeCell value={selected.created_at} />,
                },
                {
                  label: "Action",
                  value: <span className="sm-mono">{selected.action}</span>,
                },
                {
                  label: "Resource",
                  value: (
                    <span className="sm-mono">
                      {selected.resource_type} / {selected.resource_id}
                    </span>
                  ),
                },
                {
                  label: "Actor",
                  value: selected.actor_user_id ? (
                    <span>
                      {selected.actor_type}{" "}
                      <span className="sm-mono">{selected.actor_user_id}</span>
                    </span>
                  ) : (
                    selected.actor_type
                  ),
                },
                ...(selected.integrated_site_id
                  ? [
                      {
                        label: "Integrated site",
                        value: (
                          <span className="sm-mono">
                            {selected.integrated_site_id}
                          </span>
                        ),
                      },
                    ]
                  : []),
                {
                  label: "Outcome",
                  value: <StatusBadge status={selected.outcome} />,
                },
                {
                  label: "Request ID",
                  value: (
                    <span>
                      <span className="sm-mono">{selected.request_id}</span>
                      <CopyButton
                        value={selected.request_id}
                        label="Copy request ID"
                      />
                    </span>
                  ),
                },
              ]}
            />
            <h3 className="sm-card-title">Changes</h3>
            <p className="sm-hint">
              Sanitized by the server — secrets are shown as [REDACTED].
            </p>
            {changeEntries.length === 0 ? (
              <p className="sm-hint">No changes recorded for this event.</p>
            ) : (
              <div className="sm-table-wrap">
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changeEntries.map(([key, value]) => (
                      <tr key={key}>
                        <td>
                          <span className="sm-mono">{key}</span>
                        </td>
                        <td>{renderChangeValue(value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </Drawer>
    </section>
  );
}
