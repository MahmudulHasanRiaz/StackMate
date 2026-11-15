/**
 * Websites & Credentials — Integrated Sites (design spec §4.1/§4.2).
 *
 * Routes (registered in router.tsx):
 *   /integrations, /integrations/$siteId
 *
 * Search is read with `useSearch({ strict: false })`: the route id is
 * "/_main/integrations" (the operational shell is a pathless `_main`
 * layout route), so a plain-path `from: "/integrations"` throws
 * "Invariant failed" at render (jsdom repro 2026-11-15).
 *
 * Endpoints used (all `integrations.manage`, except credential
 * create/rotate/revoke which are `integrations.rotate_credentials`):
 *   GET    /api/v1/admin/integrated-sites
 *   POST   /api/v1/admin/integrated-sites
 *   GET    /api/v1/admin/integrated-sites/:id
 *   PATCH  /api/v1/admin/integrated-sites/:id
 *   POST   /api/v1/admin/integrated-sites/:id/suspend
 *   POST   /api/v1/admin/integrated-sites/:id/revoke
 *   POST   /api/v1/admin/integrated-sites/:id/products
 *   DELETE /api/v1/admin/integrated-sites/:id/products/:productId
 *   GET    /api/v1/admin/integrated-sites/:id/credentials
 *   POST   /api/v1/admin/integrated-sites/:id/credentials
 *   POST   /api/v1/admin/integrated-sites/:id/credentials/:id/revoke
 *   POST   /api/v1/admin/integrated-sites/:id/credentials/:id/rotate
 *   POST   /api/v1/admin/integrated-sites/:id/domains
 *   POST   /api/v1/admin/integrated-sites/:id/domains/:id/verification-challenge
 *   POST   /api/v1/admin/integrated-sites/:id/domains/:id/verify
 *   DELETE /api/v1/admin/integrated-sites/:id/domains/:id
 *   GET    /api/v1/admin/products (product names for the Products tab)
 *
 * Secrets: a newly created / rotated credential (and the initial server
 * credential of a newly registered site) returns `raw_secret_once`.
 * It is shown ONCE in a warning banner with a copy button and is never
 * stored, never rendered from a list response, and never reconstructed.
 */
import { useState, type FormEvent } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Globe, KeyRound, Plus } from "lucide-react";
import { SITE_CAPABILITIES } from "../../../../packages/contracts/src/index.ts";
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
  Checkbox,
  CopyButton,
  DateCell,
  DateTimeCell,
  Dialog,
  ErrorState,
  Field,
  Input,
  Select,
  StatusBadge,
  TableSkeleton,
  Tabs,
  Textarea,
  Toolbar,
  useConfirm,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* Route helpers (see header note)                                     */
/* ------------------------------------------------------------------ */
function useRouteSearch() {
  // No `from`: the route id is "/_main/integrations" (pathless `_main`
  // layout parent), so a plain-path `from: "/integrations"` throws
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
export interface SiteDomain {
  id: string;
  domain: string;
  verification_method: "dns_txt" | "http_file" | "manual_review";
  verification_challenge: string;
  verification_status: "pending" | "verified" | "failed";
  verified_at: string | null;
  is_primary: boolean;
}

export interface SiteCredential {
  id: string;
  integrated_site_id: string;
  key_id: string;
  credential_type:
    | "public_key"
    | "bearer_secret"
    | "hmac_shared_secret"
    | "public_signing_key";
  scopes: string[];
  status: "active" | "rotated" | "revoked" | "expired";
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface TrackingConfig {
  id: string;
  integrated_site_id: string;
  provider: "meta";
  pixel_id: string;
  test_event_code: string | null;
  enabled_events: string[];
  status: "enabled" | "disabled";
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
}

export interface IntegratedSite {
  id: string;
  site_key: string;
  name: string;
  environment: "production" | "staging" | "development";
  status: "pending_verification" | "active" | "suspended" | "revoked";
  api_version: string;
  allowed_capabilities: string[];
  product_ids: string[];
  domains: SiteDomain[];
  created_at: string;
  updated_at: string;
  credentials?: SiteCredential[];
  tracking?: TrackingConfig[];
}

interface Product {
  id: string;
  code: string;
  name: string;
  status: string;
}

interface CreatedCredential {
  credential: SiteCredential;
  raw_secret_once: string | null;
}

interface RotatedCredential {
  revoked_credential_id: string;
  new_credential: SiteCredential;
  raw_secret_once: string;
}

interface RegisteredSite {
  site: IntegratedSite;
  initial_server_credential: { key_id: string; raw_secret_once: string };
}

const SITE_ENVIRONMENTS = ["production", "staging", "development"] as const;

/** One-time secret banner: shown once, copyable, dismissible. */
function OneTimeSecret({
  label,
  keyId,
  secret,
  onDismiss,
}: {
  label: string;
  keyId: string;
  secret: string;
  onDismiss: () => void;
}) {
  return (
    <Alert variant="warning" onDismiss={onDismiss}>
      <div>
        <strong>{label}</strong> — copy it now. It will not be shown again.
        <div className="sm-mono">
          {keyId} · {secret}
        </div>
      </div>
      <CopyButton value={secret} label="Copy secret" />
    </Alert>
  );
}

/* ------------------------------------------------------------------ */
/* List: /integrations                                                 */
/* ------------------------------------------------------------------ */
export function IntegrationsSection() {
  const rawSearch = useRouteSearch();
  const search = parseListSearch(rawSearch);
  const navigate = useRouteNavigate();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [newSiteSecret, setNewSiteSecret] = useState<{
    keyId: string;
    secret: string;
  } | null>(null);

  const query = useAdminList<IntegratedSite>(
    "integrated-sites",
    "/api/v1/admin/integrated-sites",
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
    navigate({ to: "/integrations", search: next });
  };

  const columns: ColumnDef<IntegratedSite, unknown>[] = [
    {
      header: "Site",
      accessorKey: "name",
      cell: ({ row }) => <strong>{row.original.name}</strong>,
    },
    {
      header: "Site key",
      accessorKey: "site_key",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="sm-mono">
          {row.original.site_key}
          <CopyButton value={row.original.site_key} label="Copy site key" />
        </span>
      ),
    },
    {
      header: "Environment",
      accessorKey: "environment",
      cell: ({ row }) => row.original.environment,
    },
    {
      header: "Status",
      accessorKey: "status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      header: "Primary domain",
      accessorKey: "domains",
      enableSorting: false,
      cell: ({ row }) => {
        const primary =
          row.original.domains.find((d) => d.is_primary) ?? row.original.domains[0];
        return primary ? primary.domain : "—";
      },
    },
    {
      header: "Products",
      accessorKey: "product_ids",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="sm-tabular">{row.original.product_ids.length}</span>
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
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          icon={Eye}
          onClick={() =>
            navigate({
              to: "/integrations/$siteId",
              params: { siteId: row.original.id },
            })
          }
        >
          View
        </Button>
      ),
    },
  ];

  return (
    <section aria-labelledby="integrations-heading">
      <PageHeader
        breadcrumb={[{ label: "Integrations" }, { label: "Websites & Credentials" }]}
        title="Websites & Credentials"
        subtitle="Integrated sites, their credentials and domains"
        action={
          <Button variant="primary" icon={Plus} onClick={() => setRegisterOpen(true)}>
            Register site
          </Button>
        }
      />
      {newSiteSecret ? (
        <OneTimeSecret
          label={`Initial server credential ${newSiteSecret.keyId} created`}
          keyId={newSiteSecret.keyId}
          secret={newSiteSecret.secret}
          onDismiss={() => setNewSiteSecret(null)}
        />
      ) : null}
      <ListTable<IntegratedSite>
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
        emptyIcon={Globe}
        emptyTitle="No integrated sites yet"
        emptyBody="Register a site to connect an external website."
        emptyActionLabel="Register site"
        onEmptyAction={() => setRegisterOpen(true)}
        getRowId={(row) => row.id}
      />
      <RegisterSiteDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onCreated={(secret) => {
          setNewSiteSecret(secret);
          setRegisterOpen(false);
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Register site dialog                                                */
/* ------------------------------------------------------------------ */
function RegisterSiteDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (secret: { keyId: string; secret: string }) => void;
}) {
  const [name, setName] = useState("");
  const [environment, setEnvironment] =
    useState<(typeof SITE_ENVIRONMENTS)[number]>("production");
  const [primaryDomain, setPrimaryDomain] = useState("");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([
    "catalog.read",
    "checkout.create",
    "tracking.events.write",
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const productsQuery = useAdminList<Product>("products", "/api/v1/admin/products");

  const create = useAdminMutation<RegisteredSite, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<RegisteredSite>("/api/v1/admin/integrated-sites", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("integrated-sites")],
    successTitle: "Site registered",
    onSuccess: (data) =>
      onCreated({
        keyId: data.initial_server_credential.key_id,
        secret: data.initial_server_credential.raw_secret_once,
      }),
  });

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const doSubmit = () => {
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next.name = "Name must be at least 2 characters.";
    if (primaryDomain.trim().length < 3)
      next.primary_domain = "Enter the site's primary domain.";
    if (productIds.length === 0)
      next.product_ids = "Assign at least one product.";
    if (capabilities.length === 0)
      next.capabilities = "Select at least one capability.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    create.mutate({
      name: name.trim(),
      environment,
      primary_domain: primaryDomain.trim(),
      product_ids: productIds,
      allowed_capabilities: capabilities,
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Register site"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={doSubmit}>
            Register site
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <div className="sm-form-grid">
          <Field label="Name" required error={errors.name ?? ""} htmlFor="site-name">
            <Input
              id="site-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={Boolean(errors.name) || undefined}
            />
          </Field>
          <Field label="Environment" required htmlFor="site-env">
            <Select
              id="site-env"
              value={environment}
              onChange={(e) =>
                setEnvironment(e.target.value as (typeof SITE_ENVIRONMENTS)[number])
              }
            >
              {SITE_ENVIRONMENTS.map((env) => (
                <option key={env} value={env}>
                  {env}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Primary domain"
          required
          hint="The domain the site runs on."
          error={errors.primary_domain ?? ""}
          htmlFor="site-domain"
        >
          <Input
            id="site-domain"
            value={primaryDomain}
            onChange={(e) => setPrimaryDomain(e.target.value)}
            placeholder="example.com"
            aria-invalid={Boolean(errors.primary_domain) || undefined}
          />
        </Field>
        <Field
          label="Products"
          required
          hint="Products this site may sell."
          error={errors.product_ids ?? ""}
        >
          {productsQuery.isPending ? (
            <span className="sm-hint">Loading products…</span>
          ) : productsQuery.isError ? (
            <Alert variant="danger">Could not load products — try again later.</Alert>
          ) : (productsQuery.data ?? []).length === 0 ? (
            <span className="sm-hint">No products exist yet.</span>
          ) : (
            <div className="sm-form-grid">
              {(productsQuery.data ?? []).map((p) => (
                <Checkbox
                  key={p.id}
                  label={`${p.name} (${p.code})`}
                  checked={productIds.includes(p.id)}
                  onChange={() => setProductIds((prev) => toggle(prev, p.id))}
                />
              ))}
            </div>
          )}
        </Field>
        <Field
          label="Capabilities"
          required
          error={errors.capabilities ?? ""}
        >
          <div className="sm-form-grid">
            {SITE_CAPABILITIES.map((cap) => (
              <Checkbox
                key={cap}
                label={cap}
                checked={capabilities.includes(cap)}
                onChange={() => setCapabilities((prev) => toggle(prev, cap))}
              />
            ))}
          </div>
        </Field>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Detail: /integrations/$siteId — tabs: Products, Credentials,       */
/* Domains                                                             */
/* ------------------------------------------------------------------ */
export function IntegratedSiteDetailSection({ id }: { id: string }) {
  const [tab, setTab] = useState("products");
  const [editOpen, setEditOpen] = useState(false);
  const confirm = useConfirm();
  const navigate = useRouteNavigate();

  const query = useAdminDetail<IntegratedSite>(
    "integrated-sites",
    id,
    `/api/v1/admin/integrated-sites/${id}`,
  );
  const site = query.data;

  const suspend = useAdminMutation<IntegratedSite, void>({
    mutationFn: () =>
      apiRequest<IntegratedSite>(`/api/v1/admin/integrated-sites/${id}/suspend`, {
        method: "POST",
      }),
    invalidateKeys: [detailKey("integrated-sites", id), listKey("integrated-sites")],
    successTitle: "Site suspended",
  });

  const revoke = useAdminMutation<IntegratedSite, void>({
    mutationFn: () =>
      apiRequest<IntegratedSite>(`/api/v1/admin/integrated-sites/${id}/revoke`, {
        method: "POST",
      }),
    invalidateKeys: [detailKey("integrated-sites", id), listKey("integrated-sites")],
    successTitle: "Site revoked",
  });

  const askSuspend = async () => {
    const ok = await confirm({
      title: "Suspend site?",
      body: (
        <div>
          <p>
            {site?.name} will stop authenticating. Existing credentials stop
            working until the site is active again.
          </p>
          <p>Products, domains and credentials are kept.</p>
        </div>
      ),
      confirmLabel: "Suspend",
      danger: true,
    });
    if (ok) suspend.mutate();
  };

  const askRevoke = async () => {
    const ok = await confirm({
      title: "Revoke site?",
      body: (
        <div>
          <p>
            {site?.name} will be permanently revoked. All of its active
            credentials are revoked at the same time and the site can never
            authenticate again.
          </p>
          <p>This cannot be undone.</p>
        </div>
      ),
      confirmLabel: "Revoke",
      danger: true,
    });
    if (ok) revoke.mutate();
  };

  if (query.isPending) {
    return (
      <section aria-labelledby="site-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Integrations" }, { label: "Websites & Credentials" }]}
          title="Integrated site"
        />
        <TableSkeleton rows={4} />
      </section>
    );
  }

  if (query.isError || !site) {
    return (
      <section aria-labelledby="site-detail-heading">
        <PageHeader
          breadcrumb={[
            { label: "Integrations" },
            { label: "Websites & Credentials", href: "/integrations" },
          ]}
          title="Integrated site"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={
              query.error instanceof Error
                ? query.error.message
                : "Integrated site not found."
            }
            onRetry={() => void query.refetch()}
          />
        </div>
      </section>
    );
  }

  const primaryDomain =
    site.domains.find((d) => d.is_primary) ?? site.domains[0];

  return (
    <section aria-labelledby="site-detail-heading">
      <PageHeader
        breadcrumb={[
          { label: "Integrations" },
          { label: "Websites & Credentials", href: "/integrations" },
          { label: site.name },
        ]}
        title={site.name}
        subtitle={primaryDomain?.domain ?? ""}
        action={
          <Button variant="primary" onClick={() => setEditOpen(true)}>
            Edit site
          </Button>
        }
      />
      <Toolbar>
        <StatusBadge status={site.status} />
        <span className="sm-mono">
          {site.site_key}
          <CopyButton value={site.site_key} label="Copy site key" />
        </span>
        <span className="sm-toolbar-spacer" />
        <Button
          variant="secondary"
          size="sm"
          disabled={site.status === "suspended" || site.status === "revoked"}
          loading={suspend.isPending}
          onClick={() => void askSuspend()}
        >
          Suspend site
        </Button>
        <Button
          variant="danger-ghost"
          size="sm"
          disabled={site.status === "revoked"}
          loading={revoke.isPending}
          onClick={() => void askRevoke()}
        >
          Revoke site
        </Button>
      </Toolbar>
      <DetailFacts
        facts={[
          { label: "Environment", value: site.environment },
          { label: "API version", value: site.api_version },
          {
            label: "Capabilities",
            value: site.allowed_capabilities.join(", ") || "—",
          },
          { label: "Products", value: String(site.product_ids.length) },
          { label: "Created", value: <DateCell value={site.created_at} /> },
          { label: "Updated", value: <DateCell value={site.updated_at} /> },
        ]}
      />
      <Tabs
        tabs={[
          { key: "products", label: `Products (${site.product_ids.length})` },
          {
            key: "credentials",
            label: `Credentials (${(site.credentials ?? []).length})`,
          },
          { key: "domains", label: `Domains (${site.domains.length})` },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === "products" ? (
        <SiteProductsTab site={site} />
      ) : tab === "credentials" ? (
        <SiteCredentialsTab siteId={site.id} />
      ) : (
        <SiteDomainsTab site={site} />
      )}
      <EditSiteDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        site={site}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate({ to: "/integrations" })}
      >
        ← Back to sites
      </Button>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Edit site dialog (PATCH name / environment / api_version /          */
/* allowed_capabilities)                                               */
/* ------------------------------------------------------------------ */
function EditSiteDialog({
  open,
  onClose,
  site,
}: {
  open: boolean;
  onClose: () => void;
  site: IntegratedSite;
}) {
  const [name, setName] = useState(site.name);
  const [environment, setEnvironment] = useState(site.environment);
  const [apiVersion, setApiVersion] = useState(site.api_version);
  const [capabilities, setCapabilities] = useState<string[]>([
    ...site.allowed_capabilities,
  ]);
  const [error, setError] = useState("");

  const save = useAdminMutation<IntegratedSite, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<IntegratedSite>(`/api/v1/admin/integrated-sites/${site.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [
      detailKey("integrated-sites", site.id),
      listKey("integrated-sites"),
    ],
    successTitle: "Site updated",
    onSuccess: () => onClose(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const doSubmit = () => {
    if (name.trim().length < 2) {
      setError("Name must be at least 2 characters.");
      return;
    }
    setError("");
    save.mutate({
      name: name.trim(),
      environment,
      api_version: apiVersion.trim() || undefined,
      allowed_capabilities: capabilities,
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit site"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={doSubmit}>
            Save changes
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <div className="sm-form-grid">
          <Field label="Name" required error={error || ""} htmlFor="edit-name">
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={Boolean(error) || undefined}
            />
          </Field>
          <Field label="Environment" required htmlFor="edit-env">
            <Select
              id="edit-env"
              value={environment}
              onChange={(e) =>
                setEnvironment(
                  e.target.value as (typeof SITE_ENVIRONMENTS)[number],
                )
              }
            >
              {SITE_ENVIRONMENTS.map((env) => (
                <option key={env} value={env}>
                  {env}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="API version" htmlFor="edit-api-version">
            <Input
              id="edit-api-version"
              value={apiVersion}
              onChange={(e) => setApiVersion(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Capabilities">
          <div className="sm-form-grid">
            {SITE_CAPABILITIES.map((cap) => (
              <Checkbox
                key={cap}
                label={cap}
                checked={capabilities.includes(cap)}
                onChange={() =>
                  setCapabilities((prev) =>
                    prev.includes(cap)
                      ? prev.filter((v) => v !== cap)
                      : [...prev, cap],
                  )
                }
              />
            ))}
          </div>
        </Field>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Products tab                                                        */
/* ------------------------------------------------------------------ */
function SiteProductsTab({ site }: { site: IntegratedSite }) {
  const [assignOpen, setAssignOpen] = useState(false);
  const confirm = useConfirm();
  const productsQuery = useAdminList<Product>("products", "/api/v1/admin/products");
  const products = productsQuery.data ?? [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const remove = useAdminMutation<IntegratedSite, string>({
    mutationFn: (productId) =>
      apiRequest<IntegratedSite>(
        `/api/v1/admin/integrated-sites/${site.id}/products/${productId}`,
        { method: "DELETE" },
      ),
    invalidateKeys: [
      detailKey("integrated-sites", site.id),
      listKey("integrated-sites"),
    ],
    successTitle: "Product removed",
  });

  const rows = site.product_ids.map((pid) => ({
    id: pid,
    product: byId.get(pid),
  }));

  if (productsQuery.isPending) {
    return <TableSkeleton rows={3} />;
  }

  return (
    <div>
      <Toolbar>
        <Button variant="secondary" icon={Plus} onClick={() => setAssignOpen(true)}>
          Assign product
        </Button>
        <span className="sm-hint">
          {rows.length} of {products.length} products assigned
        </span>
      </Toolbar>
      {productsQuery.isError ? (
        <Alert variant="danger">
          Could not load product names — product IDs are shown instead.
        </Alert>
      ) : null}
      {rows.length === 0 ? (
        <div className="sm-table-wrap">
          <div className="sm-empty">
            <Globe size={18} strokeWidth={2} className="sm-empty-icon" />
            <div className="sm-empty-title">No products assigned</div>
            <p>Assign a product so this site can sell it.</p>
            <Button variant="primary" onClick={() => setAssignOpen(true)}>
              Assign product
            </Button>
          </div>
        </div>
      ) : (
        <div className="sm-table-wrap">
          <table className="sm-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.product
                      ? `${r.product.name} (${r.product.code})`
                      : r.id}
                  </td>
                  <td>
                    {r.product ? <StatusBadge status={r.product.status} /> : "—"}
                  </td>
                  <td>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      onClick={() =>
                        void (async () => {
                          const label = r.product
                            ? `${r.product.name} (${r.product.code})`
                            : r.id;
                          const ok = await confirm({
                            title: "Remove product?",
                            body: (
                              <p>
                                {label} will no longer be sold through{" "}
                                {site.name}. Orders already placed are not
                                affected.
                              </p>
                            ),
                            confirmLabel: "Remove",
                            danger: true,
                          });
                          if (ok) remove.mutate(r.id);
                        })()
                      }
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AssignProductDialog
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        site={site}
        products={products.filter((p) => !site.product_ids.includes(p.id))}
      />
    </div>
  );
}

function AssignProductDialog({
  open,
  onClose,
  site,
  products,
}: {
  open: boolean;
  onClose: () => void;
  site: IntegratedSite;
  products: Product[];
}) {
  const [productId, setProductId] = useState("");
  const [error, setError] = useState("");

  const assign = useAdminMutation<IntegratedSite, string>({
    mutationFn: (pid) =>
      apiRequest<IntegratedSite>(
        `/api/v1/admin/integrated-sites/${site.id}/products`,
        { method: "POST", body: JSON.stringify({ product_id: pid }) },
      ),
    invalidateKeys: [
      detailKey("integrated-sites", site.id),
      listKey("integrated-sites"),
    ],
    successTitle: "Product assigned",
    onSuccess: () => onClose(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const doSubmit = () => {
    if (!productId) {
      setError("Select a product.");
      return;
    }
    setError("");
    assign.mutate(productId);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Assign product"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={assign.isPending} onClick={doSubmit}>
            Assign product
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="Product" required error={error || ""} htmlFor="assign-product">
          <Select
            id="assign-product"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            aria-invalid={Boolean(error) || undefined}
          >
            <option value="">Select a product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.code})
              </option>
            ))}
          </Select>
        </Field>
        {products.length === 0 ? (
          <p className="sm-hint">All products are already assigned to this site.</p>
        ) : null}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Credentials tab                                                     */
/* ------------------------------------------------------------------ */
function SiteCredentialsTab({ siteId }: { siteId: string }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [createOpen, setCreateOpen] = useState(false);
  const [oneTime, setOneTime] = useState<{
    keyId: string;
    secret: string;
    label: string;
  } | null>(null);
  const confirm = useConfirm();

  const query = useAdminList<SiteCredential>(
    "site-credentials",
    `/api/v1/admin/integrated-sites/${siteId}/credentials`,
  );

  const revoke = useAdminMutation<SiteCredential, string>({
    mutationFn: (credId) =>
      apiRequest<SiteCredential>(
        `/api/v1/admin/integrated-sites/${siteId}/credentials/${credId}/revoke`,
        { method: "POST" },
      ),
    invalidateKeys: [
      listKey("site-credentials"),
      detailKey("integrated-sites", siteId),
      listKey("integrated-sites"),
    ],
    successTitle: "Credential revoked",
  });

  const rotate = useAdminMutation<RotatedCredential, string>({
    mutationFn: (credId) =>
      apiRequest<RotatedCredential>(
        `/api/v1/admin/integrated-sites/${siteId}/credentials/${credId}/rotate`,
        { method: "POST" },
      ),
    invalidateKeys: [
      listKey("site-credentials"),
      detailKey("integrated-sites", siteId),
      listKey("integrated-sites"),
    ],
    successTitle: "Credential rotated",
    onSuccess: (data) =>
      setOneTime({
        keyId: data.new_credential.key_id,
        secret: data.raw_secret_once,
        label: `New credential ${data.new_credential.key_id} created`,
      }),
  });

  const columns: ColumnDef<SiteCredential, unknown>[] = [
    {
      header: "Key ID",
      accessorKey: "key_id",
      cell: ({ row }) => (
        <span className="sm-mono">
          {row.original.key_id}
          <CopyButton value={row.original.key_id} label="Copy key ID" />
        </span>
      ),
    },
    {
      header: "Type",
      accessorKey: "credential_type",
      cell: ({ row }) => row.original.credential_type,
    },
    {
      header: "Scopes",
      accessorKey: "scopes",
      enableSorting: false,
      cell: ({ row }) => row.original.scopes.join(", "),
    },
    {
      header: "Status",
      accessorKey: "status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      header: "Last used",
      accessorKey: "last_used_at",
      cell: ({ row }) => <DateTimeCell value={row.original.last_used_at} />,
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
        const cred = row.original;
        const active = cred.status === "active";
        return (
          <span>
            <Button
              variant="secondary"
              size="sm"
              disabled={!active}
              loading={rotate.isPending && rotate.variables === cred.id}
              onClick={() =>
                void (async () => {
                  const ok = await confirm({
                    title: "Rotate credential?",
                    body: (
                      <div>
                        <p>
                          {cred.key_id} is revoked and a new credential of
                          the same type is issued. The old secret stops
                          working immediately.
                        </p>
                        <p>The new secret is shown once — copy it now.</p>
                      </div>
                    ),
                    confirmLabel: "Rotate",
                    danger: true,
                  });
                  if (ok) rotate.mutate(cred.id);
                })()
              }
            >
              Rotate
            </Button>{" "}
            <Button
              variant="danger-ghost"
              size="sm"
              disabled={!active}
              loading={revoke.isPending && revoke.variables === cred.id}
              onClick={() =>
                void (async () => {
                  const ok = await confirm({
                    title: "Revoke credential?",
                    body: (
                      <p>
                        {cred.key_id} stops authenticating immediately. Any
                        integration using it will fail until it switches to
                        another credential.
                      </p>
                    ),
                    confirmLabel: "Revoke",
                    danger: true,
                  });
                  if (ok) revoke.mutate(cred.id);
                })()
              }
            >
              Revoke
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <div>
      {oneTime ? (
        <OneTimeSecret
          label={oneTime.label}
          keyId={oneTime.keyId}
          secret={oneTime.secret}
          onDismiss={() => setOneTime(null)}
        />
      ) : null}
      <Alert variant="info">
        Secrets are never shown in this list. A new secret is shown once,
        when it is created or rotated.
      </Alert>
      <ListTable<SiteCredential>
        columns={columns}
        data={query.data}
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
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={KeyRound}
        emptyTitle="No credentials yet"
        emptyBody="Create a credential so this site can authenticate."
        emptyActionLabel="Create credential"
        onEmptyAction={() => setCreateOpen(true)}
        toolbar={
          <Button variant="secondary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Create credential
          </Button>
        }
        getRowId={(row) => row.id}
      />
      <CreateCredentialDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        siteId={siteId}
        onCreated={(data) => {
          if (data.raw_secret_once) {
            setOneTime({
              keyId: data.credential.key_id,
              secret: data.raw_secret_once,
              label: `Credential ${data.credential.key_id} created`,
            });
          }
          setCreateOpen(false);
        }}
      />
    </div>
  );
}

function CreateCredentialDialog({
  open,
  onClose,
  siteId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  onCreated: (data: CreatedCredential) => void;
}) {
  const [type, setType] = useState<"bearer_secret" | "hmac_shared_secret">(
    "hmac_shared_secret",
  );
  const [scopes, setScopes] = useState("catalog.read, checkout.create");
  const [error, setError] = useState("");

  const create = useAdminMutation<CreatedCredential, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<CreatedCredential>(
        `/api/v1/admin/integrated-sites/${siteId}/credentials`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    invalidateKeys: [
      listKey("site-credentials"),
      detailKey("integrated-sites", siteId),
      listKey("integrated-sites"),
    ],
    successTitle: "Credential created",
    onSuccess: (data) => onCreated(data),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const doSubmit = () => {
    const parsed = scopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length === 0) {
      setError("Enter at least one scope.");
      return;
    }
    setError("");
    create.mutate({ credential_type: type, scopes: parsed });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create credential"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={doSubmit}>
            Create credential
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="Type" required htmlFor="cred-type">
          <Select
            id="cred-type"
            value={type}
            onChange={(e) =>
              setType(e.target.value as "bearer_secret" | "hmac_shared_secret")
            }
          >
            <option value="hmac_shared_secret">hmac_shared_secret</option>
            <option value="bearer_secret">bearer_secret</option>
          </Select>
        </Field>
        <Field
          label="Scopes"
          required
          hint="Comma-separated. Public-key types are not supported here (422)."
          error={error || ""}
          htmlFor="cred-scopes"
        >
          <Input
            id="cred-scopes"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            aria-invalid={Boolean(error) || undefined}
          />
        </Field>
        <p className="sm-hint">
          The secret is shown once after creation. Copy it before closing.
        </p>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Domains tab (nested in the site record)                             */
/* ------------------------------------------------------------------ */
function SiteDomainsTab({ site }: { site: IntegratedSite }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [addOpen, setAddOpen] = useState(false);
  const [verifyTarget, setVerifyTarget] = useState<SiteDomain | null>(null);
  const confirm = useConfirm();

  const challenge = useAdminMutation<IntegratedSite, string>({
    mutationFn: (domainId) =>
      apiRequest<IntegratedSite>(
        `/api/v1/admin/integrated-sites/${site.id}/domains/${domainId}/verification-challenge`,
        { method: "POST" },
      ),
    invalidateKeys: [
      detailKey("integrated-sites", site.id),
      listKey("integrated-sites"),
    ],
    successTitle: "Challenge regenerated",
  });

  const remove = useAdminMutation<IntegratedSite, string>({
    mutationFn: (domainId) =>
      apiRequest<IntegratedSite>(
        `/api/v1/admin/integrated-sites/${site.id}/domains/${domainId}`,
        { method: "DELETE" },
      ),
    invalidateKeys: [
      detailKey("integrated-sites", site.id),
      listKey("integrated-sites"),
    ],
    successTitle: "Domain deleted",
  });

  const columns: ColumnDef<SiteDomain, unknown>[] = [
    {
      header: "Domain",
      accessorKey: "domain",
      cell: ({ row }) => (
        <span>
          {row.original.domain}
          {row.original.is_primary ? " (primary)" : ""}
        </span>
      ),
    },
    {
      header: "Method",
      accessorKey: "verification_method",
      cell: ({ row }) => row.original.verification_method,
    },
    {
      header: "Status",
      accessorKey: "verification_status",
      cell: ({ row }) => (
        <StatusBadge status={row.original.verification_status} />
      ),
    },
    {
      header: "Verified at",
      accessorKey: "verified_at",
      cell: ({ row }) => <DateTimeCell value={row.original.verified_at} />,
    },
    {
      header: "Challenge",
      accessorKey: "verification_challenge",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="sm-mono">
          {row.original.verification_challenge}
          <CopyButton
            value={row.original.verification_challenge}
            label="Copy verification challenge"
          />
        </span>
      ),
    },
    {
      header: "Actions",
      id: "actions",
      enableSorting: false,
      cell: ({ row }) => {
        const domain = row.original;
        const verified = domain.verification_status === "verified";
        return (
          <span>
            <Button
              variant="secondary"
              size="sm"
              loading={
                challenge.isPending && challenge.variables === domain.id
              }
              onClick={() => challenge.mutate(domain.id)}
            >
              New challenge
            </Button>{" "}
            <Button
              variant="secondary"
              size="sm"
              disabled={verified}
              onClick={() => setVerifyTarget(domain)}
            >
              Verify
            </Button>{" "}
            <Button
              variant="danger-ghost"
              size="sm"
              disabled={site.domains.length <= 1}
              loading={remove.isPending && remove.variables === domain.id}
              onClick={() =>
                void (async () => {
                  const ok = await confirm({
                    title: "Delete domain?",
                    body: (
                      <div>
                        <p>
                          {domain.domain} will be removed from {site.name}.
                        </p>
                        {domain.is_primary ? (
                          <p>
                            It is the primary domain — the first remaining
                            domain becomes primary.
                          </p>
                        ) : null}
                      </div>
                    ),
                    confirmLabel: "Delete",
                    danger: true,
                  });
                  if (ok) remove.mutate(domain.id);
                })()
              }
            >
              Delete
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <Alert variant="info">
        New domains start pending and are never auto-verified. Only a manual
        review verifies a domain — automated DNS/HTTP checks are Batch 2.
      </Alert>
      <ListTable<SiteDomain>
        columns={columns}
        data={site.domains}
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
        isLoading={false}
        isError={false}
        error={null}
        onRetry={() => undefined}
        emptyIcon={Globe}
        emptyTitle="No domains"
        emptyBody="Add a domain for this site."
        emptyActionLabel="Add domain"
        onEmptyAction={() => setAddOpen(true)}
        toolbar={
          <Button variant="secondary" icon={Plus} onClick={() => setAddOpen(true)}>
            Add domain
          </Button>
        }
        getRowId={(row) => row.id}
      />
      <AddDomainDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        site={site}
      />
      <VerifyDomainDialog
        domain={verifyTarget}
        siteId={site.id}
        onClose={() => setVerifyTarget(null)}
      />
    </div>
  );
}

function AddDomainDialog({
  open,
  onClose,
  site,
}: {
  open: boolean;
  onClose: () => void;
  site: IntegratedSite;
}) {
  const [domain, setDomain] = useState("");
  const [method, setMethod] = useState<"dns_txt" | "http_file" | "manual_review">(
    "dns_txt",
  );
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState("");

  const add = useAdminMutation<IntegratedSite, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<IntegratedSite>(
        `/api/v1/admin/integrated-sites/${site.id}/domains`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    invalidateKeys: [
      detailKey("integrated-sites", site.id),
      listKey("integrated-sites"),
    ],
    successTitle: "Domain added",
    successMessage: "The domain starts pending — it is not auto-verified.",
    onSuccess: () => onClose(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const doSubmit = () => {
    if (domain.trim().length < 3) {
      setError("Enter a domain.");
      return;
    }
    setError("");
    add.mutate({
      domain: domain.trim(),
      verification_method: method,
      is_primary: isPrimary,
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add domain"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} onClick={doSubmit}>
            Add domain
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="Domain" required error={error || ""} htmlFor="add-domain">
          <Input
            id="add-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="shop.example.com"
            aria-invalid={Boolean(error) || undefined}
          />
        </Field>
        <Field label="Verification method" required htmlFor="add-method">
          <Select
            id="add-method"
            value={method}
            onChange={(e) =>
              setMethod(
                e.target.value as "dns_txt" | "http_file" | "manual_review",
              )
            }
          >
            <option value="dns_txt">dns_txt</option>
            <option value="http_file">http_file</option>
            <option value="manual_review">manual_review</option>
          </Select>
        </Field>
        <Checkbox
          label="Make this the primary domain"
          checked={isPrimary}
          onChange={(e) => setIsPrimary(e.target.checked)}
        />
        <p className="sm-hint">
          The challenge is stackmate-site-verification=&lt;token&gt;. New
          domains start pending.
        </p>
      </form>
    </Dialog>
  );
}

function VerifyDomainDialog({
  domain,
  siteId,
  onClose,
}: {
  domain: SiteDomain | null;
  siteId: string;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const verify = useAdminMutation<IntegratedSite, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<IntegratedSite>(
        `/api/v1/admin/integrated-sites/${siteId}/domains/${domain?.id}/verify`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    invalidateKeys: [
      detailKey("integrated-sites", siteId),
      listKey("integrated-sites"),
    ],
    successTitle: "Domain verified",
    onSuccess: () => onClose(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const doSubmit = () => {
    if (!domain) return;
    if (note.trim().length < 2) {
      setError("A reviewer note is required for manual verification.");
      return;
    }
    setError("");
    verify.mutate({ method: "manual_review", reviewer_note: note.trim() });
  };

  return (
    <Dialog
      open={domain !== null}
      onClose={onClose}
      title={`Verify ${domain?.domain ?? ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={verify.isPending} onClick={doSubmit}>
            Verify domain
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <p className="sm-hint">
          Only manual review verifies a domain right now. Automated dns_txt /
          http_file checks are not implemented (Batch 2) and return 409.
        </p>
        <Field
          label="Reviewer note"
          required
          hint="What was checked before marking this domain verified."
          error={error || ""}
          htmlFor="verify-note"
        >
          <Textarea
            id="verify-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={Boolean(error) || undefined}
          />
        </Field>
      </form>
    </Dialog>
  );
}
