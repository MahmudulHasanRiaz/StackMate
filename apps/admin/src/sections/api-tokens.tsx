/**
 * API Tokens — scoped bearer tokens for external API clients (OD-13).
 *
 * Route (wiring owed — router.tsx / shell.tsx / settings.tsx are under
 * active edit by other workers, see the wiring note at the bottom):
 *   /settings/api-tokens
 *
 * Endpoints (admin, `api_tokens.manage`):
 *   GET  /api/v1/admin/api-tokens
 *   POST /api/v1/admin/api-tokens
 *   POST /api/v1/admin/api-tokens/:id/revoke
 *
 * The raw token value is shown EXACTLY ONCE, in the create dialog
 * after a successful mint, with a Copy button and a warning that it
 * will never be shown again. No response ever carries `token_hash`.
 *
 * Fetch calls are INLINE here (local `requestApiTokens`, mirroring
 * lib/api-client's pattern: credentials include, 30s timeout,
 * `{ data }` envelope unwrap) because lib/api-client.ts is under
 * active edit by another worker — this file must not import from it
 * until that work lands. When it does, these three calls can move to
 * api-client.ts unchanged.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { ListTable, PageHeader } from "../lib/section-kit";
import {
  Alert,
  Button,
  Checkbox,
  DateCell,
  DateTimeCell,
  Dialog,
  Field,
  GroupField,
  StatusBadge,
  useConfirm,
} from "../components/primitives";
import type { ColumnDef } from "@tanstack/react-table";

/* ------------------------------------------------------------------ */
/* Inline fetch (api-client.ts pattern — see the file header).         */
/* ------------------------------------------------------------------ */

class ApiTokensError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "ApiTokensError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const API_TOKENS_TIMEOUT_MS = 30_000;

async function requestApiTokens<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(path, {
      ...options,
      credentials: "include",
      headers,
      signal: options.signal ?? AbortSignal.timeout(API_TOKENS_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiTokensError(
        "REQUEST_TIMEOUT",
        "Request timed out — the server did not respond in time. Please retry.",
        0,
      );
    }
    throw err;
  }
  const json = (await res.json().catch(() => null)) as {
    data?: T;
    error?: { code: string; message: string };
  } | null;
  if (!res.ok || !json || json.error) {
    throw new ApiTokensError(
      json?.error?.code ?? "HTTP_ERROR",
      json?.error?.message ?? `Request failed with status ${res.status}`,
      res.status,
    );
  }
  return json.data as T;
}

/* ------------------------------------------------------------------ */
/* Types + scope catalogue.                                            */
/* ------------------------------------------------------------------ */

export interface ApiTokenRow {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

interface CreatedToken {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  expires_at: string | null;
  created_at: string;
  value: string;
}

/**
 * Grantable scopes — the permission catalogue (db/seeds/
 * seed-reference.ts) MINUS the two keys a token may never carry
 * (`users.manage`, `api_tokens.manage`). Labels are the seed
 * descriptions, so the UI never shows a raw permission enum. A scope
 * the server adds later renders via `scopeLabel`'s humanized
 * fallback instead of a raw key.
 */
const GRANTABLE_SCOPES: ReadonlyArray<{
  key: string;
  label: string;
  group: string;
}> = [
  { key: "products.read", label: "View products and integration profiles", group: "Products" },
  { key: "products.create", label: "Create new products", group: "Products" },
  { key: "products.update", label: "Edit and archive products", group: "Products" },
  { key: "features.manage", label: "Create and manage product feature definitions", group: "Products" },
  { key: "packages.manage", label: "Create and edit draft packages and prices", group: "Products" },
  { key: "packages.publish", label: "Publish immutable package versions and retire plans", group: "Products" },
  { key: "customers.read", label: "View customers and customer history", group: "Customers" },
  { key: "customers.manage", label: "Create and update customer records", group: "Customers" },
  { key: "orders.read", label: "View orders and invoices", group: "Orders" },
  { key: "orders.create", label: "Create manual and custom-package orders", group: "Orders" },
  { key: "orders.manage", label: "Cancel orders and void invoices", group: "Orders" },
  { key: "payments.read", label: "View payment methods, submissions, and evidence", group: "Payments" },
  { key: "payments.methods.manage", label: "Configure manual MFS and bank payment methods", group: "Payments" },
  { key: "payments.approve", label: "Verify and approve manual payment submissions", group: "Payments" },
  { key: "payments.reject", label: "Reject manual payment submissions", group: "Payments" },
  { key: "subscriptions.read", label: "View subscriptions and renewal periods", group: "Subscriptions" },
  { key: "subscriptions.manage", label: "Create renewal invoices, pause, resume, or cancel subscriptions", group: "Subscriptions" },
  { key: "licenses.read", label: "View licenses and activations", group: "Licenses" },
  { key: "licenses.manage", label: "Issue complimentary grants, suspend, resume, or adjust license entitlements", group: "Licenses" },
  { key: "licenses.revoke", label: "Irreversibly revoke licenses and deactivate installations", group: "Licenses" },
  { key: "integrations.read", label: "View external website integrations, webhooks, and delivery records", group: "Integrations" },
  { key: "integrations.manage", label: "Register external websites, verify domains, and manage webhooks", group: "Integrations" },
  { key: "integrations.rotate_credentials", label: "Create, rotate, and revoke site credentials", group: "Integrations" },
  { key: "tracking.read", label: "View Meta Pixel and Conversions API tracking events", group: "Tracking" },
  { key: "tracking.manage", label: "Configure Meta Pixel and Conversions API tracking", group: "Tracking" },
  { key: "tickets.view", label: "View support tickets and their history", group: "Support" },
  { key: "tickets.manage", label: "Create, assign, and resolve support tickets", group: "Support" },
  { key: "leads.view", label: "View leads and their history", group: "Leads" },
  { key: "leads.manage", label: "Create, assign, convert, and manage leads", group: "Leads" },
  { key: "media.view", label: "View the media library and download files", group: "Media" },
  { key: "media.manage", label: "Upload, rename, move, and delete media files", group: "Media" },
  { key: "expenses.read", label: "View expenses and profit & loss analytics", group: "Expenses" },
  { key: "expenses.manage", label: "Create, edit, and delete expenses", group: "Expenses" },
  { key: "expense_categories.manage", label: "Create, edit, and delete expense categories", group: "Expenses" },
  { key: "audit_logs.read", label: "Inspect administrative and security audit logs", group: "Administration" },
];

const SCOPE_LABELS = new Map(GRANTABLE_SCOPES.map((s) => [s.key, s.label]));

/** Human label for a scope key — never the raw enum. */
function scopeLabel(key: string): string {
  const known = SCOPE_LABELS.get(key);
  if (known) return known;
  return key
    .split(/[._]/)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const SCOPE_GROUPS = Array.from(
  new Map(GRANTABLE_SCOPES.map((s) => [s.group, true])).keys(),
);

function tokenStatus(row: ApiTokenRow): "active" | "expired" | "revoked" {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return "expired";
  return "active";
}

export function ApiTokensSection() {
  const confirm = useConfirm();
  const [rows, setRows] = useState<ApiTokenRow[] | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiTokensError | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [expiresDate, setExpiresDate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await requestApiTokens<{ items: ApiTokenRow[]; total?: number }>(
        "/api/v1/admin/api-tokens?limit=100",
      );
      setRows(res.items);
    } catch (err) {
      setError(
        err instanceof ApiTokensError
          ? err
          : new ApiTokensError("HTTP_ERROR", "Could not load API tokens.", 0),
      );
      setRows(undefined);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setName("");
    setSelectedScopes([]);
    setExpiresDate("");
    setFormError(null);
    setCreated(null);
    setCopied(false);
    setCreateOpen(true);
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setCreated(null);
    setCopied(false);
  };

  const toggleScope = (key: string, checked: boolean) => {
    setSelectedScopes((prev) =>
      checked ? [...prev, key] : prev.filter((s) => s !== key),
    );
  };

  const submitCreate = async () => {
    if (name.trim().length === 0) {
      setFormError("A name is required.");
      return;
    }
    if (selectedScopes.length === 0) {
      setFormError("Select at least one scope.");
      return;
    }
    setFormError(null);
    setCreating(true);
    try {
      const res = await requestApiTokens<{ token: CreatedToken }>(
        "/api/v1/admin/api-tokens",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            scopes: selectedScopes,
            ...(expiresDate ? { expires_at: expiresDate } : {}),
          }),
        },
      );
      setCreated(res.token);
      void load();
    } catch (err) {
      setFormError(
        err instanceof ApiTokensError
          ? err.message
          : "Could not create the token.",
      );
    } finally {
      setCreating(false);
    }
  };

  const copyValue = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.value);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (non-secure context) — the value
      // stays visible in the dialog for manual copy.
      setCopied(false);
    }
  };

  const askRevoke = async (row: ApiTokenRow) => {
    const ok = await confirm({
      title: "Revoke this API token?",
      body: `Token “${row.name}” (${row.token_prefix}…) will stop working immediately. Any client using it will be rejected. This cannot be undone — create a new token if access is still needed.`,
      confirmLabel: "Revoke token",
      danger: true,
      warning: "Revoking a token immediately cuts off every client using it.",
    });
    if (!ok) return;
    setRevokingId(row.id);
    try {
      await requestApiTokens(
        `/api/v1/admin/api-tokens/${row.id}/revoke`,
        { method: "POST", body: JSON.stringify({}) },
      );
      void load();
    } catch (err) {
      setError(
        err instanceof ApiTokensError
          ? err
          : new ApiTokensError("HTTP_ERROR", "Could not revoke the token.", 0),
      );
    } finally {
      setRevokingId(null);
    }
  };

  const columns: ColumnDef<ApiTokenRow, unknown>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span>
            {row.original.name}
            <span className="sm-hint"> {row.original.token_prefix}…</span>
          </span>
        ),
      },
      {
        accessorKey: "token_prefix",
        header: "Prefix",
        cell: ({ row }) => (
          <span className="sm-mono">{row.original.token_prefix}…</span>
        ),
      },
      {
        accessorKey: "scopes",
        header: "Scopes",
        cell: ({ row }) => {
          const labels = row.original.scopes.map(scopeLabel);
          const shown = labels.slice(0, 2).join(", ");
          const extra = labels.length - 2;
          return (
            <span title={labels.join("\n")}>
              {shown}
              {extra > 0 ? ` +${extra} more` : ""}
            </span>
          );
        },
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => <DateTimeCell value={row.original.created_at} />,
      },
      {
        accessorKey: "expires_at",
        header: "Expires",
        cell: ({ row }) => <DateCell value={row.original.expires_at} />,
      },
      {
        accessorKey: "last_used_at",
        header: "Last used",
        cell: ({ row }) => <DateTimeCell value={row.original.last_used_at} />,
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={tokenStatus(row.original)} />,
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.revoked_at ? (
            "—"
          ) : (
            <Button
              variant="danger-ghost"
              size="sm"
              disabled={revokingId !== null}
              loading={revokingId === row.original.id}
              onClick={() => void askRevoke(row.original)}
            >
              Revoke
            </Button>
          ),
      },
    ],
    [revokingId],
  );

  return (
    <section aria-labelledby="api-tokens-heading">
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "API Tokens" }]}
        title="API Tokens"
        help="Scoped bearer tokens for external API clients — a token grants exactly the scopes it was created with, never staff management or token management"
        action={
          <Button variant="primary" onClick={openCreate}>
            Create token
          </Button>
        }
      />
      {error ? (
        <Alert variant="danger">
          {error.statusCode === 403
            ? "You do not have permission to manage API tokens."
            : error.message}
        </Alert>
      ) : null}
      <ListTable<ApiTokenRow>
        columns={columns}
        data={rows}
        search={search}
        onSearchChange={(q) => {
          setSearch(q);
          setPage(1);
        }}
        page={page}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        isLoading={isLoading}
        isError={error !== null}
        error={error}
        onRetry={() => void load()}
        emptyIcon={KeyRound}
        emptyTitle="No API tokens"
        emptyBody="No scoped API tokens have been created yet. Create one for each external client that calls the API."
        emptyActionLabel="Create token"
        onEmptyAction={openCreate}
        getRowId={(row) => row.id}
      />

      <Dialog
        open={createOpen}
        onClose={closeCreate}
        title={created ? "Token created — copy it now" : "Create API token"}
        size="md"
        footer={
          created ? (
            <Button variant="primary" onClick={closeCreate}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={closeCreate}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={creating}
                disabled={creating}
                onClick={() => void submitCreate()}
              >
                Create token
              </Button>
            </>
          )
        }
      >
        {created ? (
          <>
            <Alert variant="warning">
              Copy this token now — it will never be shown again. Store
              it somewhere safe; the server keeps only its hash.
            </Alert>
            <Field label="Token value" required>
              <span className="sm-mono" style={{ wordBreak: "break-all" }}>
                {created.value}
              </span>
            </Field>
            <Button
              variant={copied ? "secondary" : "accent"}
              icon={copied ? Check : Copy}
              onClick={() => void copyValue()}
            >
              {copied ? "Copied" : "Copy token"}
            </Button>
            <p className="sm-hint">
              {created.name} · {created.scopes.map(scopeLabel).join(", ")}
              {created.expires_at
                ? ` · Expires ${created.expires_at.slice(0, 10)}`
                : " · No expiry"}
            </p>
          </>
        ) : (
          <>
            {formError ? <Alert variant="danger">{formError}</Alert> : null}
            <Field label="Name" required hint="A label for this client, e.g. “Website checkout”">
              <input
                className="sm-input"
                type="text"
                value={name}
                maxLength={100}
                placeholder="Website checkout"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <GroupField
              label="Scopes"
              required
              hint="The token grants exactly these permissions — never more than its creator holds. Staff management and token management can never be granted to a token."
            >
              {SCOPE_GROUPS.map((group) => (
                <div key={group}>
                  <span className="sm-label">{group}</span>
                  {GRANTABLE_SCOPES.filter((s) => s.group === group).map(
                    (scope) => (
                      <Checkbox
                        key={scope.key}
                        id={`scope-${scope.key}`}
                        name={`scope-${scope.key}`}
                        label={scope.label}
                        checked={selectedScopes.includes(scope.key)}
                        onChange={(e) => toggleScope(scope.key, e.target.checked)}
                      />
                    ),
                  )}
                </div>
              ))}
            </GroupField>
            <Field label="Expires" hint="Optional — leave empty for a token that never expires.">
              <input
                className="sm-input"
                type="date"
                value={expiresDate}
                onChange={(e) => setExpiresDate(e.target.value)}
              />
            </Field>
          </>
        )}
      </Dialog>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Router + nav wiring — OWED (do not wire from this file).            */
/*                                                                     */
/* router.tsx (dirty — other workers):                                 */
/*   const ApiTokensSection = lazy(() =>                               */
/*     import("./sections/api-tokens").then((m) => ({ default:         */
/*       m.ApiTokensSection })),                                       */
/*   );                                                                */
/*   const settingsApiTokensRoute = makeSettingsListRoute(              */
/*     "/api-tokens", ApiTokensSection);                                */
/*   …add settingsApiTokensRoute to the settings children in           */
/*   routeTree (beside settingsSigningKeysRoute).                      */
/*                                                                     */
/* sections/settings.tsx SETTINGS_CATEGORIES (dirty — other workers):  */
/*   { slug: "api-tokens", label: "API Tokens", icon: KeyRound,        */
/*     to: "/settings/api-tokens", group: "Security",                  */
/*     permission: "api_tokens.manage" },                              */
/*   (beside the "signing-keys" entry; KeyRound is already imported    */
/*   there. shell.tsx renders Settings nav from this list, so no       */
/*   shell.tsx edit is needed.)                                        */
/* ------------------------------------------------------------------ */
