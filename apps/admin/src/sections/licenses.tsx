/**
 * Licenses & Activations — list + detail + "Validate a key" (spec §4.1/§4.2).
 *
 * Routes (wired by the parent in router.tsx): /licenses and
 * /licenses/$licenseId. Search, page, pageSize and the status filter are
 * URL-backed via the route's search params. Navigation uses
 * router.history.push because the routes are registered by the parent
 * after this file lands — typed Link/navigate cannot reference them
 * until then.
 *
 * API (verified in apps/api/src/app.ts):
 *  - GET /api/v1/admin/licenses — licenses.read; list strips
 *    license_key_hash + issued_raw_key_once; embeds customer_name,
 *    product_code/name, active_activations_count, expires_date_display.
 *  - GET /api/v1/admin/licenses/:id — licenses.read; same shape plus
 *    customer_email and entitlement_snapshots (lic.snapshots). The key
 *    hash is stripped — a full key is NEVER rendered here.
 *  - GET /api/v1/admin/licenses/:id/activations — licenses.read.
 *  - POST /api/v1/admin/licenses/:id/activations/:activationId/deactivate
 *    — licenses.manage; frees one seat, sets status "deactivated";
 *    409 when already deactivated.
 *  - POST /api/v1/admin/licenses/:id/{suspend|resume|revoke} —
 *    suspend/resume need licenses.manage, revoke needs licenses.revoke.
 *    Revoke also deactivates every active activation.
 *  - POST /api/v1/licenses/validate — PUBLIC license client route
 *    (no staff permission; rate-limited). Requires license_key,
 *    product_code, installation_id. Succeeds only when that installation
 *    is active for the license; returns valid, license_number,
 *    license_status, entitlement_version, entitlement_expires_at,
 *    next_validation_after — and an entitlement_token, which is
 *    deliberately NOT rendered anywhere in this file.
 * POST /api/v1/admin/licenses/manual-grants exists but is NOT wired
 * here: it needs customer/product pickers owned by other sections.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, KeyRound } from "lucide-react";
import { apiRequest, ApiClientError } from "../lib/api-client";
import { detailKey, listKey } from "../lib/query";
import {
  DetailFacts,
  ListTable,
  PageHeader,
  apiErrorMessage,
  parseListSearch,
  useAdminDetail,
  useAdminList,
  useAdminMutation,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  Card,
  CopyButton,
  DateCell,
  DateTimeCell,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  StatusBadge,
  TableSkeleton,
  useConfirm,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* DTOs (shapes verified against apps/api/src/app.ts + store.ts)        */
/* ------------------------------------------------------------------ */
interface LicenseListItem {
  id: string;
  license_number: string;
  license_key_hint: string;
  product_id: string;
  customer_id: string;
  status: string;
  activation_limit: number;
  valid_from: string;
  expires_at: string | null;
  grace_until: string | null;
  issued_at: string;
  customer_name: string | null;
  product_code: string | null;
  product_name: string | null;
  active_activations_count: number;
  expires_date_display: string;
}

interface EntitlementSnapshot {
  id: string;
  version_number: number;
  source_type: string;
  effective_at: string;
  reason: string | null;
  items: Array<{ feature_key_snapshot: string }>;
}

interface LicenseDetail extends LicenseListItem {
  customer_email: string | null;
  entitlement_snapshots: EntitlementSnapshot[];
}

interface LicenseActivation {
  id: string;
  license_id: string;
  domain_normalized: string | null;
  environment: string;
  status: string;
  activated_at: string;
  last_seen_at: string;
  deactivated_at: string | null;
}

interface ValidateResult {
  valid: boolean;
  license_number: string;
  license_status: string;
  entitlement_version: number;
  entitlement_expires_at: string;
  next_validation_after: string;
  // NOTE: the API also returns an entitlement_token (signed JWT).
  // It is never read or rendered here.
}

const LICENSE_STATUSES = ["pending", "active", "expired", "suspended", "revoked"] as const;

function sentenceCase(value: string): string {
  const words = value.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ------------------------------------------------------------------ */
/* List + Validate a key                                               */
/* ------------------------------------------------------------------ */
export function LicensesSection() {
  const router = useRouter();
  const rawSearch = useSearch({ strict: false }) as unknown as Record<string, unknown>;
  const parsed = parseListSearch(rawSearch);
  const page = parsed.page ?? 1;
  const pageSize = parsed.pageSize ?? 25;
  const statusParam = typeof rawSearch.status === "string" ? rawSearch.status : "all";
  const statusFilter = (LICENSE_STATUSES as readonly string[]).includes(statusParam)
    ? statusParam
    : "all";

  const query = useAdminList<LicenseListItem>("licenses", "/api/v1/admin/licenses");

  const updateSearch = (patch: {
    q?: string;
    page?: number;
    pageSize?: number;
    status?: string;
  }) => {
    const nextQ = patch.q !== undefined ? patch.q : parsed.q;
    const nextPage = patch.page !== undefined ? patch.page : page;
    const nextPageSize = patch.pageSize !== undefined ? patch.pageSize : pageSize;
    const nextStatus = patch.status !== undefined ? patch.status : statusFilter;
    const params = new URLSearchParams();
    if (nextQ) params.set("q", nextQ);
    if (nextPage > 1) params.set("page", String(nextPage));
    if (nextPageSize !== 25) params.set("pageSize", String(nextPageSize));
    if (nextStatus !== "all") params.set("status", nextStatus);
    const qs = params.toString();
    router.history.push(`/licenses${qs ? `?${qs}` : ""}`);
  };

  const filtered = useMemo(() => {
    const items = query.data ?? [];
    if (statusFilter === "all") return items;
    return items.filter((l) => l.status === statusFilter);
  }, [query.data, statusFilter]);

  const columns: ColumnDef<LicenseListItem, unknown>[] = useMemo(
    () => [
      {
        accessorKey: "license_number",
        header: "License",
        cell: ({ row }) => (
          <span className="sm-mono">
            {row.original.license_number}
            <CopyButton value={row.original.license_number} label="Copy license number" />
          </span>
        ),
      },
      {
        accessorKey: "license_key_hint",
        header: "Key hint",
        cell: ({ row }) => <span className="sm-mono">{row.original.license_key_hint}</span>,
      },
      {
        accessorKey: "product_name",
        header: "Product",
        cell: ({ row }) => (
          <span>
            {row.original.product_name ?? "—"}
            <span className="sm-hint">
              {row.original.product_code ? ` ${row.original.product_code}` : ""}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "customer_name",
        header: "Customer",
        cell: ({ row }) => row.original.customer_name ?? "—",
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "activations",
        header: "Activations",
        cell: ({ row }) => (
          <span className="sm-tabular">
            {row.original.active_activations_count} / {row.original.activation_limit}
          </span>
        ),
      },
      {
        accessorKey: "expires_date_display",
        header: "Expires",
        cell: ({ row }) => (
          <span className="sm-tabular">{row.original.expires_date_display}</span>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            icon={Eye}
            onClick={() => router.history.push(`/licenses/${row.original.id}`)}
          >
            View
          </Button>
        ),
      },
    ],
    [router],
  );

  return (
    <section aria-labelledby="licenses-heading">
      <PageHeader
        breadcrumb={[{ label: "Licenses & Activations" }]}
        title="Licenses & Activations"
        subtitle="Issued licenses, activation seats, and key checks"
      />
      <ListTable
        columns={columns}
        data={filtered}
        search={parsed.q ?? ""}
        onSearchChange={(q) => updateSearch({ q, page: 1 })}
        page={page}
        onPageChange={(page) => updateSearch({ page })}
        pageSize={pageSize}
        onPageSizeChange={(pageSize) => updateSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={KeyRound}
        emptyTitle="No licenses yet"
        emptyBody="Licenses appear here when an order or manual grant issues one."
        toolbar={
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => updateSearch({ status: e.target.value, page: 1 })}
          >
            <option value="all">All statuses</option>
            {LICENSE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {sentenceCase(s)}
              </option>
            ))}
          </Select>
        }
        getRowId={(row) => row.id}
      />
      <ValidateKeyCard />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Validate a key — POST /api/v1/licenses/validate (public route)      */
/* The key is sent in the POST body only, never in a URL, never        */
/* stored, and never rendered. The returned entitlement token is       */
/* never rendered either.                                              */
/* ------------------------------------------------------------------ */
function ValidateKeyCard() {
  const [licenseKey, setLicenseKey] = useState("");
  const [productCode, setProductCode] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    licenseKey?: string;
    productCode?: string;
    installationId?: string;
  }>({});
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errors: typeof fieldErrors = {};
    if (licenseKey.trim().length < 12) {
      errors.licenseKey = "License key must be at least 12 characters.";
    }
    if (productCode.trim().length < 2) {
      errors.productCode = "Product code is required.";
    }
    if (installationId.trim().length < 6) {
      errors.installationId = "Installation ID must be at least 6 characters.";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setChecking(true);
    setFormError(null);
    setResult(null);
    try {
      const res = await apiRequest<ValidateResult>("/api/v1/licenses/validate", {
        method: "POST",
        body: JSON.stringify({
          license_key: licenseKey.trim(),
          product_code: productCode.trim(),
          installation_id: installationId.trim(),
        }),
      });
      setResult(res);
    } catch (err) {
      setFormError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Validation failed.",
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card title="Validate a key">
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <Field
          label="License key"
          required
          hint="Pasted key is sent in the request body only."
          {...(fieldErrors.licenseKey ? { error: fieldErrors.licenseKey } : {})}
          htmlFor="validate-license-key"
        >
          <Input
            id="validate-license-key"
            type="password"
            autoComplete="off"
            placeholder="Paste the full license key"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            aria-invalid={fieldErrors.licenseKey ? true : undefined}
            disabled={checking}
          />
        </Field>
        <Field
          label="Product code"
          required
          {...(fieldErrors.productCode ? { error: fieldErrors.productCode } : {})}
          htmlFor="validate-product-code"
        >
          <Input
            id="validate-product-code"
            type="text"
            autoComplete="off"
            placeholder="e.g. STACKMATE-PRO"
            value={productCode}
            onChange={(e) => setProductCode(e.target.value)}
            aria-invalid={fieldErrors.productCode ? true : undefined}
            disabled={checking}
          />
        </Field>
        <Field
          label="Installation ID"
          required
          {...(fieldErrors.installationId ? { error: fieldErrors.installationId } : {})}
          htmlFor="validate-installation-id"
        >
          <Input
            id="validate-installation-id"
            type="text"
            autoComplete="off"
            placeholder="Installation ID from the customer site"
            value={installationId}
            onChange={(e) => setInstallationId(e.target.value)}
            aria-invalid={fieldErrors.installationId ? true : undefined}
            disabled={checking}
          />
        </Field>
        {formError ? <Alert variant="danger">{formError}</Alert> : null}
        {result ? (
          <Alert variant="success">
            <span>
              Key is valid for license {result.license_number} (
              <StatusBadge status={result.license_status} />). Entitlement
              version {result.entitlement_version}; token expires{" "}
              <DateTimeCell value={result.entitlement_expires_at} />; validate
              again after <DateTimeCell value={result.next_validation_after} />.
            </span>
          </Alert>
        ) : null}
        <Button variant="primary" type="submit" loading={checking} disabled={checking}>
          Validate key
        </Button>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */
export function LicenseDetailSection({ id }: { id: string }) {
  const confirm = useConfirm();
  const query = useAdminDetail<LicenseDetail>(
    "licenses",
    id,
    `/api/v1/admin/licenses/${id}`,
  );
  // Distinct query key ("license-activations") so the activations cache
  // never collides with the licenses list cache.
  const activations = useAdminList<LicenseActivation>(
    "license-activations",
    `/api/v1/admin/licenses/${id}/activations`,
  );

  const lifecycle = useAdminMutation<unknown, "suspend" | "resume" | "revoke">({
    mutationFn: (action) =>
      apiRequest(`/api/v1/admin/licenses/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ reason: `License ${action} by staff` }),
      }),
    invalidateKeys: [
      detailKey("licenses", id),
      listKey("licenses"),
      listKey("license-activations"),
    ],
    successTitle: "License updated",
  });

  const deactivate = useAdminMutation<unknown, string>({
    mutationFn: (activationId) =>
      apiRequest(
        `/api/v1/admin/licenses/${id}/activations/${activationId}/deactivate`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    invalidateKeys: [
      detailKey("licenses", id),
      listKey("licenses"),
      listKey("license-activations"),
    ],
    successTitle: "Activation deactivated",
    successMessage: "One activation seat is now free.",
  });

  const askLifecycle = async (action: "suspend" | "resume" | "revoke") => {
    const bodies: Record<typeof action, string> = {
      suspend:
        "The license status becomes Suspended and the key stops validating until it is resumed.",
      resume: "The license status becomes Active and the key validates again.",
      revoke:
        "The license status becomes Revoked, the key stops validating permanently, and every active activation on this license is deactivated.",
    };
    const ok = await confirm({
      title: `${sentenceCase(action)} license?`,
      body: bodies[action],
      confirmLabel: sentenceCase(action),
      danger: action === "revoke",
    });
    if (ok) lifecycle.mutate(action);
  };

  const askDeactivate = async (activation: LicenseActivation) => {
    const ok = await confirm({
      title: "Deactivate activation?",
      body: `This deactivates the ${activation.environment} installation at ${activation.domain_normalized ?? "unknown domain"}. The seat is freed for another installation. The installation stops validating.`,
      confirmLabel: "Deactivate",
      danger: true,
    });
    if (ok) deactivate.mutate(activation.id);
  };

  if (query.isPending) {
    return (
      <section aria-labelledby="license-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Licenses", href: "/licenses" }, { label: "…" }]}
          title="License"
        />
        <TableSkeleton rows={6} />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section aria-labelledby="license-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Licenses", href: "/licenses" }, { label: "Not found" }]}
          title="License"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={query.error instanceof Error ? query.error.message : "License not found."}
            onRetry={() => void query.refetch()}
          />
        </div>
      </section>
    );
  }

  const lic = query.data;
  const busy = lifecycle.isPending || deactivate.isPending;

  return (
    <section aria-labelledby="license-detail-heading">
      <PageHeader
        breadcrumb={[{ label: "Licenses", href: "/licenses" }, { label: lic.license_number }]}
        title={`License ${lic.license_number}`}
        subtitle="License detail, activations, and entitlement snapshots"
        action={
          <>
            <StatusBadge status={lic.status} />
            {lic.status === "active" ? (
              <Button
                variant="secondary"
                disabled={busy}
                loading={lifecycle.isPending && lifecycle.variables === "suspend"}
                onClick={() => void askLifecycle("suspend")}
              >
                Suspend
              </Button>
            ) : null}
            {lic.status === "suspended" ? (
              <Button
                variant="primary"
                disabled={busy}
                loading={lifecycle.isPending && lifecycle.variables === "resume"}
                onClick={() => void askLifecycle("resume")}
              >
                Resume
              </Button>
            ) : null}
            {lic.status !== "revoked" && lic.status !== "expired" ? (
              <Button
                variant="danger"
                disabled={busy}
                loading={lifecycle.isPending && lifecycle.variables === "revoke"}
                onClick={() => void askLifecycle("revoke")}
              >
                Revoke
              </Button>
            ) : null}
          </>
        }
      />
      <DetailFacts
        facts={[
          {
            label: "License number",
            value: (
              <span className="sm-mono">
                {lic.license_number}
                <CopyButton value={lic.license_number} label="Copy license number" />
              </span>
            ),
          },
          { label: "Key hint", value: <span className="sm-mono">{lic.license_key_hint}</span> },
          {
            label: "Product",
            value: lic.product_name
              ? `${lic.product_name} (${lic.product_code ?? ""})`
              : "—",
          },
          {
            label: "Customer",
            value: lic.customer_name
              ? `${lic.customer_name}${lic.customer_email ? ` (${lic.customer_email})` : ""}`
              : "—",
          },
          {
            label: "Activations",
            value: `${lic.active_activations_count} / ${lic.activation_limit}`,
          },
          { label: "Valid from", value: <DateCell value={lic.valid_from} /> },
          { label: "Expires", value: lic.expires_date_display },
          { label: "Grace until", value: <DateCell value={lic.grace_until} /> },
          { label: "Issued", value: <DateCell value={lic.issued_at} /> },
        ]}
      />

      <div className="sm-card">
        <h2 className="sm-card-title">Activations</h2>
        {activations.isPending ? (
          <TableSkeleton rows={3} />
        ) : activations.isError ? (
          <ErrorState
            message={apiErrorMessage(activations.error)}
            onRetry={() => void activations.refetch()}
          />
        ) : (activations.data ?? []).length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No activations"
            body="No installation has activated this license yet."
          />
        ) : (
          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th scope="col">Installation</th>
                  <th scope="col">Environment</th>
                  <th scope="col">Status</th>
                  <th scope="col">Activated</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Deactivated</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(activations.data ?? []).map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className="sm-mono">
                        {a.domain_normalized ?? a.id.slice(0, 8)}
                        <CopyButton value={a.id} label="Copy activation ID" />
                      </span>
                    </td>
                    <td>{sentenceCase(a.environment)}</td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                    <td>
                      <DateTimeCell value={a.activated_at} />
                    </td>
                    <td>
                      <DateTimeCell value={a.last_seen_at} />
                    </td>
                    <td>
                      <DateCell value={a.deactivated_at} />
                    </td>
                    <td>
                      {a.status === "active" ? (
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          disabled={busy}
                          loading={deactivate.isPending && deactivate.variables === a.id}
                          onClick={() => void askDeactivate(a)}
                        >
                          Deactivate
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

      <div className="sm-card">
        <h2 className="sm-card-title">Entitlement snapshots</h2>
        {lic.entitlement_snapshots.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No entitlement snapshots"
            body="This license has no entitlement snapshots recorded."
          />
        ) : (
          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Source</th>
                  <th scope="col">Effective</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Items</th>
                </tr>
              </thead>
              <tbody>
                {lic.entitlement_snapshots.map((s) => (
                  <tr key={s.id}>
                    <td className="sm-tabular">{s.version_number}</td>
                    <td>{sentenceCase(s.source_type)}</td>
                    <td>
                      <DateTimeCell value={s.effective_at} />
                    </td>
                    <td>{s.reason ?? "—"}</td>
                    <td className="sm-tabular">{s.items.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
