/**
 * Audit Log — read-only record of staff, system, and integration actions.
 *
 * GET /api/v1/admin/audit-logs (audit_logs.read). Server-side search
 * (?q=) and filters (?action=, ?resource=, ?outcome=) over the full
 * history; the actor-type filter stays client-side (the API's ?actor=
 * filters by actor user id, not by type). Search, page, and pageSize
 * are URL-backed via the route search params; filters are URL-backed
 * the same way. There are no mutation endpoints for audit logs
 * (read-only by design) — this section creates nothing.
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
  SearchableSelect,
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
import {
  humanizeType,
  resolveResourceName,
  shortId,
  useResourceMaps,
  useStaffNameMap,
} from "../lib/resolve-names";

interface AuditLogRecord {
  id: string;
  actor_type: "staff" | "system" | "integration";
  actor_user_id: string | null;
  integrated_site_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  // Server-resolved human display name (F3 follow-up): the API returns
  // it for every resource type; null when the resource no longer exists.
  resource_display_name?: string | null;
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
    {
      q: search.q,
      page: search.page,
      pageSize: search.pageSize,
      // Server-side: ?action=, ?resource=, ?outcome= filter the full
      // history. ?actor= is NOT threaded — it filters by actor user
      // id, while this page's actor filter is the actor TYPE, so it
      // stays client-side in the `filtered` memo below.
      extra: {
        ...(search.action ? { action: search.action } : {}),
        ...(search.resource_type ? { resource: search.resource_type } : {}),
        ...(search.outcome ? { outcome: search.outcome } : {}),
      },
    },
  );

  // Filter-dropdown options come from a separate UNFILTERED load:
  // deriving them from the filtered rows would narrow the dropdowns
  // to the current filter (pick action=X and the action list would
  // show only X). When no filter/search is active this shares the
  // main query's key, so TanStack dedupes it into one fetch.
  const optionsQuery = useAdminList<AuditLogRecord>(
    "audit-logs",
    "/api/v1/admin/audit-logs",
  );

  /* F3 (2026-11-16, follow-up): the API returns a server-resolved
     `resource_display_name` for every resource type (see
     resolveAuditResourceDisplayName in the audit service); the
     client-side maps below are only the fallback for rows the server
     could not resolve (deleted resources). Actor names still resolve
     client-side (staff list join). Unknown ids fall back to a short id,
     never the full UUID. */
  const staffNames = useStaffNameMap();
  const resourceMaps = useResourceMaps();

  const actions = useMemo(
    () => distinctSorted((optionsQuery.data ?? []).map((e) => e.action)),
    [optionsQuery.data],
  );
  const resourceTypes = useMemo(
    () => distinctSorted((optionsQuery.data ?? []).map((e) => e.resource_type)),
    [optionsQuery.data],
  );
  const actorTypes = useMemo(
    () => distinctSorted((optionsQuery.data ?? []).map((e) => e.actor_type)),
    [optionsQuery.data],
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
        cell: ({ row }) => {
          // Server value first (covers every resource type, including
          // nested ones and sessions); client-side maps are the fallback
          // for rows the server could not resolve (deleted resources);
          // a short id is the last resort — never a bare full UUID.
          const display =
            row.original.resource_display_name ??
            resolveResourceName(
              row.original.resource_type,
              row.original.resource_id,
              resourceMaps,
            );
          return (
            <span className="sm-cell-line">
              {display ? (
                <span className="sm-break sm-cell-text">{display}</span>
              ) : (
                <span className="sm-mono sm-cell-text">
                  {shortId(row.original.resource_id)}
                </span>
              )}
              <span className="sm-hint sm-cell-text">
                {humanizeType(row.original.resource_type)}
              </span>
            </span>
          );
        },
      },
      {
        accessorKey: "actor_type",
        header: "Actor",
        cell: ({ row }) => {
          const name = row.original.actor_user_id
            ? staffNames.get(row.original.actor_user_id)
            : undefined;
          return (
            <span className="sm-cell-line">
              <span className="sm-cell-text">
                {name ?? humanizeType(row.original.actor_type)}
              </span>
              {row.original.actor_user_id ? (
                <span className="sm-mono sm-hint sm-cell-text">
                  {shortId(row.original.actor_user_id)}
                </span>
              ) : null}
            </span>
          );
        },
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
            <span className="sm-mono">{shortId(row.original.request_id)}</span>
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
    [resourceMaps, staffNames],
  );

  const changeEntries = selected ? Object.entries(selected.changes ?? {}) : [];

  return (
    <section aria-labelledby="audit-logs-heading">
      <PageHeader
        breadcrumb={[{ label: "Administration" }, { label: "Audit Log" }]}
        title="Audit Log"
        help="Immutable record of staff, system, and integration actions"
      />
      <ListTable<AuditLogRecord>
        columns={columns}
        data={filtered}
        serverSearch
        serverPagination
        refreshSection="audit-logs"
        filtersActive={filtersActive}
        total={query.total}
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
            {/* Searchable, local mode (PLAN §29): the action vocabulary
               grows with the product (100+ event names), so a plain
               dropdown is unusable. The options are the distinct set
               from the UNFILTERED collection (optionsQuery) — deriving
               them from the filtered rows would narrow the dropdown to
               the current filter. A URL-restored value shows itself
               (selectedLabel) even before its rows load. */}
            <SearchableSelect
              id="audit-action-filter"
              value={search.action ?? ""}
              onChange={(v) =>
                updateSearch(
                  { action: v === "" ? undefined : v },
                  true,
                )
              }
              options={actions.map((a) => ({ value: a, label: a }))}
              selectedLabel={search.action ?? undefined}
              leadingOptions={[{ value: "", label: "All actions" }]}
              placeholder="All actions"
              ariaLabel="Filter by action"
            />
            {/* Same: resource types are a fixed but >8 vocabulary. */}
            <SearchableSelect
              id="audit-resource-filter"
              value={search.resource_type ?? ""}
              onChange={(v) =>
                updateSearch(
                  { resource_type: v === "" ? undefined : v },
                  true,
                )
              }
              options={resourceTypes.map((r) => ({ value: r, label: r }))}
              selectedLabel={search.resource_type ?? undefined}
              leadingOptions={[{ value: "", label: "All resources" }]}
              placeholder="All resources"
              ariaLabel="Filter by resource type"
            />
            <Select
              id="audit-outcome-filter"
              name="outcome"
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
            {/* Same: actor types are few, but the same searchable
               treatment keeps the toolbar consistent. */}
            <SearchableSelect
              id="audit-actor-filter"
              value={search.actor_type ?? ""}
              onChange={(v) =>
                updateSearch(
                  { actor_type: v === "" ? undefined : v },
                  true,
                )
              }
              options={actorTypes.map((a) => ({ value: a, label: a }))}
              selectedLabel={search.actor_type ?? undefined}
              leadingOptions={[{ value: "", label: "All actors" }]}
              placeholder="All actors"
              ariaLabel="Filter by actor type"
            />
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
                    <span className="sm-break">
                      {selected.resource_display_name ??
                        resolveResourceName(
                          selected.resource_type,
                          selected.resource_id,
                          resourceMaps,
                        ) ??
                        shortId(selected.resource_id)}{" "}
                      <span className="sm-hint">
                        ({humanizeType(selected.resource_type)})
                      </span>
                    </span>
                  ),
                },
                {
                  label: "Actor",
                  value: selected.actor_user_id ? (
                    <span>
                      {staffNames.get(selected.actor_user_id) ??
                        humanizeType(selected.actor_type)}{" "}
                      <span className="sm-mono sm-hint">
                        {shortId(selected.actor_user_id)}
                      </span>
                    </span>
                  ) : (
                    humanizeType(selected.actor_type)
                  ),
                },
                ...(selected.integrated_site_id
                  ? [
                      {
                        label: "Integrated site",
                        value: (
                          <span className="sm-break">
                            {resourceMaps.sites.get(
                              selected.integrated_site_id,
                            ) ?? shortId(selected.integrated_site_id)}
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
                      <span className="sm-mono">{shortId(selected.request_id)}</span>
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
