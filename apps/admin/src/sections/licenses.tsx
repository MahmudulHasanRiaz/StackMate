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
 *  - POST /api/v1/admin/licenses/manual-grants — licenses.manage;
 *    manual grant dialog (E-07) below. The issued key is shown once
 *    and never stored.
 *  - POST /api/v1/admin/licenses/:id/activations/:activationId/transfer
 *    — licenses.manage; transfer dialog (E-03) on the detail page.
 *    Body shape is the assumed { new_installation_id,
 *    new_domain_normalized, reason } — the API worker aligns it.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, KeyRound } from "lucide-react";
import { apiRequest, ApiClientError } from "../lib/api-client";
import { ddmmyyyyToIso, normalizeDateInput } from "../lib/dates";
import { detailKey, listKey } from "../lib/query";
import {
  DetailLayout,
  ListTable,
  PageHeader,
  apiErrorMessage,
  detailLabelResolver,
  loadListOptions,
  parseListSearch,
  useAdminDetail,
  useAdminList,
  useAdminMutation,
  useIdempotencyKey,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  Card,
  CopyButton,
  DateCell,
  DateTimeCell,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SearchableSelect,
  Select,
  StatusBadge,
  TableSkeleton,
  Textarea,
  useConfirm,
} from "../components/primitives";
import type { CustomerDto } from "./customers";
import type { FeatureDto } from "./features";
import type { ProductListItem } from "./products";

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
  // D-01: server sort (?sort=created_at:asc|desc — the API supports
  // it) + server status filter, threaded into the list query.
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [grantOpen, setGrantOpen] = useState(false);

  const query = useAdminList<LicenseListItem>("licenses", "/api/v1/admin/licenses", {
    q: parsed.q,
    page,
    pageSize,
    extra: {
      ...(statusFilter !== "all" ? { status: statusFilter } : {}),
      ...(sort ? { sort } : {}),
    },
  });

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
        help="Issued licenses, activation seats, and key checks"
        action={
          <Button variant="primary" icon={KeyRound} onClick={() => setGrantOpen(true)}>
            Manual grant
          </Button>
        }
      />
      <ListTable
        columns={columns}
        data={filtered}
        serverSearch
        serverPagination
        serverSort={{ sortableColumns: ["created_at"], value: sort, onChange: setSort }}
        refreshSection="licenses"
        filtersActive={statusFilter !== "all"}
        total={query.total}
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
            id="licenses-status-filter"
            name="status"
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
      {grantOpen ? <ManualGrantDialog onClose={() => setGrantOpen(false)} /> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Manual grant — POST /api/v1/admin/licenses/manual-grants (E-07)     */
/* The issued key is shown ONCE and never stored: it lives only in    */
/* this dialog's state and is dropped when the dialog closes.          */
/* ------------------------------------------------------------------ */
function parseFeatureValue(raw: string): unknown {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

function ManualGrantDialog({ onClose }: { onClose: () => void }) {
  const [customerId, setCustomerId] = useState("");
  const [productId, setProductId] = useState("");
  const [activationLimit, setActivationLimit] = useState("1");
  const [expiresDisplay, setExpiresDisplay] = useState("");
  const [reason, setReason] = useState("");
  const [entValues, setEntValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  // A-04: one key per dialog instance — a retried grant replays.
  const formKey = useIdempotencyKey();

  const featuresQuery = useQuery({
    queryKey: ["admin", "products", productId, "features"],
    queryFn: async () => {
      const res = await apiRequest<{ items: FeatureDto[] }>(
        `/api/v1/admin/products/${productId}/features?limit=100`,
      );
      return res.items;
    },
    enabled: productId !== "",
  });
  const features = (featuresQuery.data ?? []).filter((f) => f.status === "active");

  const mutation = useAdminMutation<{ issued_license_key_once?: string | null }, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<{ issued_license_key_once?: string | null }>(
        "/api/v1/admin/licenses/manual-grants",
        { method: "POST", body: JSON.stringify(body), idempotencyKey: formKey },
      ),
    invalidateKeys: [listKey("licenses")],
    successTitle: "License granted",
    onSuccess: (data) => setIssuedKey(data.issued_license_key_once ?? null),
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (!customerId) next.customer_id = "Choose a customer.";
    if (!productId) next.product_id = "Choose a product.";
    const limit = Number(activationLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
      next.activation_limit = "Activation limit must be a whole number from 1 to 10000.";
    const expiresIso = expiresDisplay.trim()
      ? ddmmyyyyToIso(expiresDisplay.trim())
      : null;
    if (expiresDisplay.trim() && expiresIso === null)
      next.expires_at = "Use a valid DD/MM/YYYY date, or leave empty for no expiry.";
    if (reason.trim().length < 3) next.reason = "Reason needs at least 3 characters.";
    else if (reason.trim().length > 500) next.reason = "Reason must be at most 500 characters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    // Entitlements are keyed by feature_key with the typed value
    // shape ({ value_type, value }); a feature left blank is omitted
    // and keeps the product default.
    const entitlements: Record<string, unknown> = {};
    for (const f of features) {
      const v = (entValues[f.id] ?? "").trim();
      if (!v) continue;
      entitlements[f.feature_key] = {
        value_type: f.value_type,
        value: parseFeatureValue(v),
      };
    }
    mutation.mutate(
      {
        customer_id: customerId,
        product_id: productId,
        activation_limit: limit,
        ...(expiresIso ? { expires_at: expiresIso } : { expires_at: null }),
        reason: reason.trim(),
        entitlements,
      },
      {
        onError: (err) => setFormError(err instanceof Error ? err.message : "Request failed"),
      },
    );
  };

  return (
    <Dialog open size="md" onClose={onClose} title="Manual grant">
      {issuedKey ? (
        <div>
          <Alert variant="success">
            License granted. Copy the key now — it is shown once and is never
            stored or shown again.
          </Alert>
          <div style={{ marginTop: 16 }}>
            <Field label="License key (shown once)">
              <span className="sm-mono">
                {issuedKey}
                <CopyButton value={issuedKey} label="Copy license key" />
              </span>
            </Field>
          </div>
          <div className="sm-dialog-footer sm-dialog-footer-flush">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {formError ? <Alert variant="danger">{formError}</Alert> : null}
          <div className="sm-form-grid" style={{ marginTop: 16 }}>
            <Field label="Customer" required htmlFor="grant-customer" error={errors.customer_id ?? ""}>
              <SearchableSelect
                id="grant-customer"
                value={customerId}
                onChange={(v) => setCustomerId(v)}
                loadOptions={(q, signal) =>
                  loadListOptions<CustomerDto>(
                    "/api/v1/admin/customers",
                    q,
                    (c) => ({
                      value: c.id,
                      label: c.email ? `${c.name} — ${c.email}` : c.name,
                    }),
                    signal,
                  )
                }
                resolveLabel={detailLabelResolver<CustomerDto>(
                  (id) => `/api/v1/admin/customers/${id}`,
                  (c) => (c.email ? `${c.name} — ${c.email}` : c.name),
                )}
                placeholder="Type a name, email or phone…"
                ariaLabel="Customer"
              />
            </Field>
            <Field label="Product" required htmlFor="grant-product" error={errors.product_id ?? ""}>
              <SearchableSelect
                id="grant-product"
                value={productId}
                onChange={(v) => {
                  setProductId(v);
                  setEntValues({});
                }}
                loadOptions={(q, signal) =>
                  loadListOptions<ProductListItem>(
                    "/api/v1/admin/products",
                    q,
                    (p) => ({ value: p.id, label: p.name }),
                    signal,
                  )
                }
                resolveLabel={detailLabelResolver<ProductListItem>(
                  (id) => `/api/v1/admin/products/${id}`,
                  (p) => p.name,
                )}
                placeholder="Type a product name…"
                ariaLabel="Product"
              />
            </Field>
            <Field label="Activation limit" required htmlFor="grant-limit" error={errors.activation_limit ?? ""}>
              <Input
                id="grant-limit"
                name="activation_limit"
                inputMode="numeric"
                value={activationLimit}
                onChange={(e) => setActivationLimit(e.target.value)}
                aria-invalid={Boolean(errors.activation_limit) || undefined}
              />
            </Field>
            <Field label="Expires (DD/MM/YYYY)" htmlFor="grant-expires" hint="Leave empty for no expiry." error={errors.expires_at ?? ""}>
              <Input
                id="grant-expires"
                name="expires_at"
                value={expiresDisplay}
                onChange={(e) => setExpiresDisplay(normalizeDateInput(e.target.value))}
                placeholder="DD/MM/YYYY"
                aria-invalid={Boolean(errors.expires_at) || undefined}
              />
            </Field>
          </div>
          <div style={{ marginTop: 16 }}>
            <Field label="Reason" required htmlFor="grant-reason" error={errors.reason ?? ""}>
              <Textarea
                id="grant-reason"
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Why is this license being granted manually?"
              />
            </Field>
          </div>
          {productId !== "" ? (
            <div style={{ marginTop: 16 }}>
              <h3 className="sm-card-title">Entitlements</h3>
              {featuresQuery.isPending ? (
                <p className="sm-hint">Loading product features…</p>
              ) : features.length === 0 ? (
                <p className="sm-hint">This product has no active features — the grant uses the product defaults.</p>
              ) : (
                <div className="sm-form-grid">
                  {features.map((f) => (
                    <Field
                      key={f.id}
                      label={f.name}
                      htmlFor={`grant-ent-${f.id}`}
                      hint={`${f.feature_key} · ${f.value_type}${f.unit ? ` (${f.unit})` : ""} — leave blank for the product default.`}
                    >
                      {f.value_type === "boolean" ? (
                        <Select
                          id={`grant-ent-${f.id}`}
                          name={`ent-${f.feature_key}`}
                          value={entValues[f.id] ?? ""}
                          onChange={(e) =>
                            setEntValues((v) => ({ ...v, [f.id]: e.target.value }))
                          }
                        >
                          <option value="">Default</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </Select>
                      ) : (
                        <Input
                          id={`grant-ent-${f.id}`}
                          name={`ent-${f.feature_key}`}
                          value={entValues[f.id] ?? ""}
                          onChange={(e) =>
                            setEntValues((v) => ({ ...v, [f.id]: e.target.value }))
                          }
                          placeholder={
                            f.default_value !== null && f.default_value !== undefined
                              ? String(f.default_value)
                              : ""
                          }
                        />
                      )}
                    </Field>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          <div className="sm-dialog-footer sm-dialog-footer-flush">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="accent" loading={mutation.isPending} onClick={submit}>
              Grant license
            </Button>
          </div>
        </form>
      )}
    </Dialog>
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
      <form onSubmit={(e) => void onSubmit(e)} noValidate autoComplete="off">
        <Field
          label="License key"
          required
          hint="Pasted key is sent in the request body only."
          {...(fieldErrors.licenseKey ? { error: fieldErrors.licenseKey } : {})}
          htmlFor="validate-license-key"
        >
          {/* F4 (2026-11-16): Chrome ignores autoComplete="off" on a
              password field and autofills saved credentials (masked key
              + email in Installation ID on first load). "new-password"
              tells it this is not a login form; the text fields carry
              non-autofillable names so no saved identity maps onto them. */}
          <Input
            id="validate-license-key"
            name="validate-license-key"
            type="password"
            autoComplete="new-password"
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
            name="validate-product-code"
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
            name="validate-installation-id"
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
        <Button variant="accent" type="submit" loading={checking} disabled={checking}>
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
  const [transferTarget, setTransferTarget] = useState<LicenseActivation | null>(null);
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

  // A-04: one key per section instance for each consequential POST.
  const lifecycleKey = useIdempotencyKey();
  const deactivateKey = useIdempotencyKey();
  const lifecycle = useAdminMutation<unknown, "suspend" | "resume" | "revoke">({
    mutationFn: (action) =>
      apiRequest(`/api/v1/admin/licenses/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ reason: `License ${action} by staff` }),
        idempotencyKey: lifecycleKey,
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
        { method: "POST", body: JSON.stringify({}), idempotencyKey: deactivateKey },
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
      warning:
        action === "revoke"
          ? "The license status becomes Revoked, the key stops validating permanently, and every active activation on this license is deactivated."
          : undefined,
    });
    if (ok) lifecycle.mutate(action);
  };

  const askDeactivate = async (activation: LicenseActivation) => {
    const ok = await confirm({
      title: "Deactivate activation?",
      body: `This deactivates the ${activation.environment} installation at ${activation.domain_normalized ?? "unknown domain"}. The seat is freed for another installation. The installation stops validating.`,
      confirmLabel: "Deactivate",
      danger: true,
      warning: `This deactivates the ${activation.environment} installation at ${activation.domain_normalized ?? "unknown domain"}.`,
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
        help="License detail, activations, and entitlement snapshots"
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
                variant="accent"
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
      <DetailLayout
        title="License"
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
      >

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
                        <DateTimeCell value={a.deactivated_at} />
                      </td>
                      <td>
                        {a.status === "active" ? (
                          <span style={{ display: "inline-flex", gap: 8 }}>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() => setTransferTarget(a)}
                            >
                              Transfer
                            </Button>
                            <Button
                              variant="danger-ghost"
                              size="sm"
                              disabled={busy}
                              loading={deactivate.isPending && deactivate.variables === a.id}
                              onClick={() => void askDeactivate(a)}
                            >
                              Deactivate
                            </Button>
                          </span>
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

        {transferTarget ? (
          <TransferActivationDialog
            licenseId={id}
            activation={transferTarget}
            onClose={() => setTransferTarget(null)}
          />
        ) : null}
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
      </DetailLayout>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Transfer activation — POST .../activations/:id/transfer (E-03)      */
/* Body shape is the assumed { new_installation_id,                    */
/* new_domain_normalized, reason } — no spec/docs body shape exists;   */
/* the API worker aligns the endpoint to this shape.                   */
/* ------------------------------------------------------------------ */
function TransferActivationDialog({
  licenseId,
  activation,
  onClose,
}: {
  licenseId: string;
  activation: LicenseActivation;
  onClose: () => void;
}) {
  const [installationId, setInstallationId] = useState("");
  const [domain, setDomain] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // A-04: one key per dialog instance — a retried transfer replays.
  const formKey = useIdempotencyKey();

  const mutation = useAdminMutation<unknown, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest(
        `/api/v1/admin/licenses/${licenseId}/activations/${activation.id}/transfer`,
        { method: "POST", body: JSON.stringify(body), idempotencyKey: formKey },
      ),
    invalidateKeys: [
      detailKey("licenses", licenseId),
      listKey("licenses"),
      listKey("license-activations"),
    ],
    successTitle: "Activation transferred",
    successMessage: "The seat now belongs to the new installation.",
    onSuccess: onClose,
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (installationId.trim().length < 6)
      next.new_installation_id = "New installation ID needs at least 6 characters.";
    else if (installationId.trim().length > 200)
      next.new_installation_id = "New installation ID must be at most 200 characters.";
    if (!domain.trim()) next.new_domain_normalized = "New domain is required.";
    else if (domain.trim().length > 253)
      next.new_domain_normalized = "New domain must be at most 253 characters.";
    if (reason.trim().length < 3) next.reason = "Reason needs at least 3 characters.";
    else if (reason.trim().length > 500)
      next.reason = "Reason must be at most 500 characters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    mutation.mutate(
      {
        new_installation_id: installationId.trim(),
        new_domain_normalized: domain.trim().toLowerCase(),
        reason: reason.trim(),
      },
      {
        onError: (err) => setFormError(err instanceof Error ? err.message : "Request failed"),
      },
    );
  };

  return (
    <Dialog open size="md" onClose={onClose} title="Transfer activation">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Alert variant="warning">
          The {activation.environment} installation
          {activation.domain_normalized ? ` at ${activation.domain_normalized}` : ""} stops
          validating and the seat moves to the new installation.
        </Alert>
        {formError ? (
          <div style={{ marginTop: 16 }}>
            <Alert variant="danger">{formError}</Alert>
          </div>
        ) : null}
        <div className="sm-form-grid" style={{ marginTop: 16 }}>
          <Field label="New installation ID" required htmlFor="transfer-installation" error={errors.new_installation_id ?? ""}>
            <Input
              id="transfer-installation"
              name="new_installation_id"
              value={installationId}
              onChange={(e) => setInstallationId(e.target.value)}
              maxLength={200}
              placeholder="e.g. site-installation-42"
              aria-invalid={Boolean(errors.new_installation_id) || undefined}
            />
          </Field>
          <Field label="New domain" required htmlFor="transfer-domain" error={errors.new_domain_normalized ?? ""}>
            <Input
              id="transfer-domain"
              name="new_domain_normalized"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              maxLength={253}
              placeholder="e.g. example.com"
              aria-invalid={Boolean(errors.new_domain_normalized) || undefined}
            />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label="Reason" required htmlFor="transfer-reason" error={errors.reason ?? ""}>
            <Textarea
              id="transfer-reason"
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Why is this activation moving?"
            />
          </Field>
        </div>
        <div className="sm-dialog-footer sm-dialog-footer-flush">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" loading={mutation.isPending} onClick={submit}>
            Transfer activation
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
