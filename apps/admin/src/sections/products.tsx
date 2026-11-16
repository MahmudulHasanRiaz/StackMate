/**
 * Products — list + detail (catalog).
 *
 * Routes (wired by the parent in router.tsx): /products,
 * /products/$productId. List search params (URL-backed): q, page,
 * pageSize, status.
 *
 * NOTE on routing: the typed `useSearch({ from: "/products" })` form
 * cannot typecheck until the parent wires the routes into router.tsx
 * (verified: TS2322 on the unwired path). Until then this file reads
 * the same location.search through `useRouterState` and updates it
 * with a search-updater `navigate()` — the runtime behaviour is
 * identical, and switching to the typed form is a one-line change
 * per section once the routes exist.
 *
 * Endpoints (verified in apps/api/src/app.ts + modules/catalog/service.ts):
 *  GET    /api/v1/admin/products                 products.read
 *  POST   /api/v1/admin/products                 products.create
 *  GET    /api/v1/admin/products/:id             products.read
 *  PATCH  /api/v1/admin/products/:id             products.update
 *  POST   /api/v1/admin/products/:id/publish     products.update
 *  POST   /api/v1/admin/products/:id/archive     products.update
 */
import { useState, type FormEvent } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Package, Pencil, Plus } from "lucide-react";
import {
  PRODUCT_TYPES,
  FULFILLMENT_TYPES,
  DISTRIBUTION_CHANNELS,
} from "../../../../packages/contracts/src/index.ts";
import { apiRequest } from "../lib/api-client";
import { detailKey, listKey } from "../lib/query";
import {
  apiErrorMessage,
  DetailLayout,
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
  Card,
  Checkbox,
  CopyButton,
  DateCell,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  StatusBadge,
  Textarea,
  useConfirm,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* DTOs (store records + embedded relations, see app.ts)               */
/* ------------------------------------------------------------------ */
export interface ProductListItem {
  id: string;
  code: string;
  slug: string;
  name: string;
  description: string | null;
  product_type: string;
  fulfillment_type: string;
  distribution_channels: string[];
  default_activation_limit: number;
  offline_grace_hours: number;
  status: "draft" | "active" | "archived";
  website_url: string | null;
  documentation_url: string | null;
  created_at: string;
  updated_at: string;
  features_count: number;
  packages_count: number;
}

export interface ProductFeatureSummary {
  id: string;
  product_id: string;
  feature_key: string;
  name: string;
  description: string | null;
  value_type: "boolean" | "limit" | "quota" | "metered";
  unit: string | null;
  default_value: unknown;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export interface ProductPackageSummary {
  id: string;
  product_id: string;
  package_key: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductDetailDto extends ProductListItem {
  features: ProductFeatureSummary[];
  packages: ProductPackageSummary[];
}

/* ------------------------------------------------------------------ */
/* Route search helpers (see header note)                              */
/* ------------------------------------------------------------------ */
function useRouteSearch() {
  const raw = useRouterState({ select: (s) => s.location.search }) as unknown as Record<
    string,
    unknown
  >;
  return { raw, list: parseListSearch(raw) };
}

function useSearchUpdater() {
  const navigate = useNavigate();
  return (patch: Record<string, unknown>) => {
    void navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
    } as never);
  };
}

function sentenceCase(value: string): string {
  const words = value.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ------------------------------------------------------------------ */
/* Create product form (CreateProductSchema, contracts/catalog.ts)      */
/* ------------------------------------------------------------------ */
const CODE_RE = /^[A-Z0-9_-]+$/;
const SLUG_RE = /^[a-z0-9-]+$/;

function CreateProductDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [productType, setProductType] = useState("");
  const [fulfillmentType, setFulfillmentType] = useState("software_license");
  const [channels, setChannels] = useState<string[]>([]);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [documentationUrl, setDocumentationUrl] = useState("");
  const [activationLimit, setActivationLimit] = useState("1");
  const [graceHours, setGraceHours] = useState("72");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const create = useAdminMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<ProductListItem>("/api/v1/admin/products", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("products")],
    successTitle: "Product created",
    onSuccess: (created) => {
      onClose();
      void navigate({ to: `/products/${created.id}` } as never);
    },
  });

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (code.trim().length < 2 || code.trim().length > 60 || !CODE_RE.test(code.trim())) {
      next.code = "2–60 chars, uppercase letters, digits, hyphens or underscores.";
    }
    if (slug.trim().length < 2 || slug.trim().length > 120 || !SLUG_RE.test(slug.trim())) {
      next.slug = "2–120 chars, lowercase kebab-case.";
    }
    if (name.trim().length < 2 || name.trim().length > 200) {
      next.name = "Name is required (2–200 chars).";
    }
    if (!productType) next.productType = "Choose a product type.";
    for (const [key, value] of [
      ["websiteUrl", websiteUrl],
      ["documentationUrl", documentationUrl],
    ] as const) {
      if (value.trim()) {
        try {
          const url = new URL(value.trim());
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("not http(s)");
          }
        } catch {
          next[key] = "Enter a valid http(s) URL.";
        }
      }
    }
    const limit = Number(activationLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
      next.activationLimit = "Whole number, 1–10000.";
    }
    const grace = Number(graceHours);
    if (!Number.isInteger(grace) || grace < 0 || grace > 720) {
      next.graceHours = "Whole number, 0–720.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function submitForm() {
    setSubmitError(null);
    if (!validate()) return;
    const body: Record<string, unknown> = {
      code: code.trim(),
      slug: slug.trim(),
      name: name.trim(),
      product_type: productType,
      fulfillment_type: fulfillmentType,
      default_activation_limit: Number(activationLimit),
      offline_grace_hours: Number(graceHours),
    };
    if (description.trim()) body.description = description.trim();
    if (channels.length > 0) body.distribution_channels = channels;
    if (websiteUrl.trim()) body.website_url = websiteUrl.trim();
    if (documentationUrl.trim()) body.documentation_url = documentationUrl.trim();
    create.mutate(body, {
      onError: (err) => setSubmitError(apiErrorMessage(err)),
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create product"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" loading={create.isPending} onClick={submitForm}>
            Create product
          </Button>
        </>
      }
    >
      {submitError ? (
        <Alert variant="danger" role="alert">
          {submitError}
        </Alert>
      ) : null}
      <form
        id="create-product-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submitForm();
        }}
      >
        <div className="sm-form-grid">
          <Field label="Code" required {...(errors.code ? { error: errors.code } : {})} htmlFor="cp-code">
            <Input
              id="cp-code"
              value={code}
              aria-invalid={errors.code ? true : undefined}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="MY_PLUGIN"
            />
          </Field>
          <Field label="Slug" required {...(errors.slug ? { error: errors.slug } : {})} htmlFor="cp-slug">
            <Input
              id="cp-slug"
              value={slug}
              aria-invalid={errors.slug ? true : undefined}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="my-plugin"
            />
          </Field>
          <Field label="Name" required {...(errors.name ? { error: errors.name } : {})} htmlFor="cp-name">
            <Input
              id="cp-name"
              value={name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => setName(e.target.value)}
              placeholder="Product name"
            />
          </Field>
          <Field
            label="Product type"
            required
            {...(errors.productType ? { error: errors.productType } : {})}
            htmlFor="cp-type"
          >
            <Select
              id="cp-type"
              value={productType}
              aria-invalid={errors.productType ? true : undefined}
              onChange={(e) => setProductType(e.target.value)}
            >
              <option value="">Select a type…</option>
              {PRODUCT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {sentenceCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fulfillment" htmlFor="cp-fulfillment">
            <Select
              id="cp-fulfillment"
              value={fulfillmentType}
              onChange={(e) => setFulfillmentType(e.target.value)}
            >
              {FULFILLMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {sentenceCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Activation limit"
            required
            hint="Default activations per license"
            {...(errors.activationLimit ? { error: errors.activationLimit } : {})}
            htmlFor="cp-limit"
          >
            <Input
              id="cp-limit"
              type="number"
              min={1}
              max={10000}
              value={activationLimit}
              aria-invalid={errors.activationLimit ? true : undefined}
              onChange={(e) => setActivationLimit(e.target.value)}
            />
          </Field>
          <Field
            label="Offline grace hours"
            required
            {...(errors.graceHours ? { error: errors.graceHours } : {})}
            htmlFor="cp-grace"
          >
            <Input
              id="cp-grace"
              type="number"
              min={0}
              max={720}
              value={graceHours}
              aria-invalid={errors.graceHours ? true : undefined}
              onChange={(e) => setGraceHours(e.target.value)}
            />
          </Field>
          <Field label="Website URL" {...(errors.websiteUrl ? { error: errors.websiteUrl } : {})} htmlFor="cp-website">
            <Input
              id="cp-website"
              type="url"
              value={websiteUrl}
              aria-invalid={errors.websiteUrl ? true : undefined}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </Field>
          <Field
            label="Documentation URL"
            {...(errors.documentationUrl ? { error: errors.documentationUrl } : {})}
            htmlFor="cp-docs"
          >
            <Input
              id="cp-docs"
              type="url"
              value={documentationUrl}
              aria-invalid={errors.documentationUrl ? true : undefined}
              onChange={(e) => setDocumentationUrl(e.target.value)}
              placeholder="https://docs.example.com"
            />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label="Description" htmlFor="cp-description">
            <Textarea
              id="cp-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this product is for"
            />
          </Field>
        </div>
        <fieldset className="sm-bordered-card" style={{ marginTop: 16 }}>
          <legend className="sm-label">Distribution channels</legend>
          <span className="sm-hint">Leave all unchecked to use the server default.</span>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              marginTop: 8,
            }}
          >
            {DISTRIBUTION_CHANNELS.map((c) => (
              <Checkbox
                key={c}
                label={sentenceCase(c)}
                checked={channels.includes(c)}
                onChange={(e) =>
                  setChannels((prev) =>
                    e.target.checked
                      ? [...prev, c]
                      : prev.filter((x) => x !== c),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Products list                                                       */
/* ------------------------------------------------------------------ */
const STATUS_FILTERS = ["all", "draft", "active", "archived"] as const;

export function ProductsSection() {
  const { raw, list } = useRouteSearch();
  const updateSearch = useSearchUpdater();
  const [createOpen, setCreateOpen] = useState(false);
  const query = useAdminList<ProductListItem>("products", "/api/v1/admin/products");

  const statusFilter =
    typeof raw.status === "string" &&
    (STATUS_FILTERS as readonly string[]).includes(raw.status)
      ? raw.status
      : "all";
  const search = list.q ?? "";
  const rows = (query.data ?? []).filter((p) =>
    statusFilter === "all" ? true : p.status === statusFilter,
  );

  const columns: ColumnDef<ProductListItem, unknown>[] = [
    {
      accessorKey: "code",
      header: "Code",
      cell: ({ row }) => (
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <span className="sm-mono">{row.original.code}</span>
          <CopyButton value={row.original.code} label={`Copy code ${row.original.code}`} />
        </span>
      ),
    },
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <a href={`/products/${row.original.id}`}>{row.original.name}</a>
      ),
    },
    {
      accessorKey: "product_type",
      header: "Type",
      cell: ({ row }) => sentenceCase(row.original.product_type),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "features_count",
      header: "Features",
      cell: ({ row }) => (
        <span className="sm-tabular">{row.original.features_count}</span>
      ),
    },
    {
      accessorKey: "packages_count",
      header: "Packages",
      cell: ({ row }) => (
        <span className="sm-tabular">{row.original.packages_count}</span>
      ),
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateCell value={row.original.created_at} />,
    },
  ];

  return (
    <section aria-labelledby="products-heading">
      <PageHeader
        breadcrumb={[{ label: "Products" }]}
        title="Products"
        subtitle="Catalog products, their features and packages"
        action={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Create product
          </Button>
        }
      />
      <ListTable
        columns={columns}
        data={rows}
        search={search}
        onSearchChange={(q) => updateSearch({ q: q || undefined, page: 1 })}
        page={list.page ?? 1}
        onPageChange={(page) => updateSearch({ page })}
        pageSize={list.pageSize ?? 25}
        onPageSizeChange={(pageSize) => updateSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={Package}
        emptyTitle="No products yet"
        emptyBody="Create your first product to add features and packages to it."
        emptyActionLabel="Create product"
        onEmptyAction={() => setCreateOpen(true)}
        getRowId={(row) => row.id}
        toolbar={
          <>
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                type="button"
                className="sm-chip"
                aria-pressed={statusFilter === s}
                onClick={() => updateSearch({ status: s === "all" ? undefined : s, page: 1 })}
              >
                {s === "all" ? "All" : sentenceCase(s)}
              </button>
            ))}
          </>
        }
      />
      <CreateProductDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Product detail                                                      */
/* ------------------------------------------------------------------ */
function EditProductDialog({
  open,
  onClose,
  product,
}: {
  open: boolean;
  onClose: () => void;
  product: ProductDetailDto;
}) {
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(product.website_url ?? "");
  const [documentationUrl, setDocumentationUrl] = useState(
    product.documentation_url ?? "",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const save = useAdminMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<ProductDetailDto>(`/api/v1/admin/products/${product.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [detailKey("products", product.id), listKey("products")],
    successTitle: "Product updated",
    onSuccess: () => onClose(),
  });

  function submitForm() {
    setSubmitError(null);
    const next: Record<string, string> = {};
    if (name.trim().length < 2 || name.trim().length > 200) {
      next.name = "Name is required (2–200 chars).";
    }
    for (const [key, value] of [
      ["websiteUrl", websiteUrl],
      ["documentationUrl", documentationUrl],
    ] as const) {
      if (value.trim()) {
        try {
          const url = new URL(value.trim());
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("not http(s)");
          }
        } catch {
          next[key] = "Enter a valid http(s) URL.";
        }
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate(
      {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        website_url: websiteUrl.trim() ? websiteUrl.trim() : null,
        documentation_url: documentationUrl.trim() ? documentationUrl.trim() : null,
      },
      { onError: (err) => setSubmitError(apiErrorMessage(err)) },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit product"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" loading={save.isPending} onClick={submitForm}>
            Save changes
          </Button>
        </>
      }
    >
      {submitError ? (
        <Alert variant="danger" role="alert">
          {submitError}
        </Alert>
      ) : null}
      <form
        id="edit-product-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submitForm();
        }}
      >
        <div className="sm-form-grid">
          <Field label="Name" required {...(errors.name ? { error: errors.name } : {})} htmlFor="ep-name">
            <Input
              id="ep-name"
              value={name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Website URL" {...(errors.websiteUrl ? { error: errors.websiteUrl } : {})} htmlFor="ep-website">
            <Input
              id="ep-website"
              type="url"
              value={websiteUrl}
              aria-invalid={errors.websiteUrl ? true : undefined}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </Field>
          <Field
            label="Documentation URL"
            {...(errors.documentationUrl ? { error: errors.documentationUrl } : {})}
            htmlFor="ep-docs"
          >
            <Input
              id="ep-docs"
              type="url"
              value={documentationUrl}
              aria-invalid={errors.documentationUrl ? true : undefined}
              onChange={(e) => setDocumentationUrl(e.target.value)}
              placeholder="https://docs.example.com"
            />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label="Description" htmlFor="ep-description">
            <Textarea
              id="ep-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <p className="sm-hint" style={{ marginTop: 16 }}>
          Code, slug, type and fulfillment cannot be changed after creation.
        </p>
      </form>
    </Dialog>
  );
}

export function ProductDetailSection({ id }: { id: string }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const query = useAdminDetail<ProductDetailDto>(
    "products",
    id,
    `/api/v1/admin/products/${id}`,
  );

  const setStatus = useAdminMutation({
    mutationFn: (action: "publish" | "archive") =>
      apiRequest<ProductDetailDto>(`/api/v1/admin/products/${id}/${action}`, {
        method: "POST",
      }),
    invalidateKeys: [detailKey("products", id), listKey("products")],
    successTitle: "Product updated",
  });

  if (query.isPending) {
    return (
      <section aria-labelledby="product-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Products", href: "/products" }, { label: "…" }]}
          title="Product"
        />
        <div className="sm-table-wrap sm-table-wrap-pad">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ height: 20, width: "40%" }} className="sm-skeleton" />
            <div style={{ height: 20, width: "70%" }} className="sm-skeleton" />
            <div style={{ height: 20, width: "55%" }} className="sm-skeleton" />
          </div>
        </div>
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section aria-labelledby="product-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Products", href: "/products" }, { label: "Product" }]}
          title="Product"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={apiErrorMessage(query.error)}
            onRetry={() => void query.refetch()}
          />
        </div>
      </section>
    );
  }

  const product = query.data;

  async function onArchive() {
    const ok = await confirm({
      title: "Archive product?",
      body: (
        <div>
          <p style={{ marginTop: 0 }}>
            “{product.name}” will move to Archived and stop being sold.
          </p>
          <p style={{ marginBottom: 0 }}>
            Its features and packages stay in the catalog and can be restored by
            publishing the product again.
          </p>
        </div>
      ),
      confirmLabel: "Archive",
      danger: true,
    });
    if (ok) setStatus.mutate("archive");
  }

  return (
    <section aria-labelledby="product-detail-heading">
      <PageHeader
        breadcrumb={[
          { label: "Products", href: "/products" },
          { label: product.name },
        ]}
        title={product.name}
        {...(product.description ? { subtitle: product.description } : {})}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="secondary"
              icon={Pencil}
              onClick={() => setEditOpen(true)}
            >
              Edit
            </Button>
            {product.status === "draft" ? (
              <Button
                variant="accent"
                loading={setStatus.isPending}
                onClick={() => setStatus.mutate("publish")}
              >
                Publish
              </Button>
            ) : null}
            {product.status === "archived" ? (
              <Button
                variant="accent"
                loading={setStatus.isPending}
                onClick={() => setStatus.mutate("publish")}
              >
                Restore
              </Button>
            ) : null}
            {product.status !== "archived" ? (
              <Button
                variant="danger-ghost"
                loading={setStatus.isPending}
                onClick={() => void onArchive()}
              >
                Archive
              </Button>
            ) : null}
          </div>
        }
      />
      <DetailLayout
        title="Product"
        facts={[
          {
            label: "Code",
            value: (
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <span className="sm-mono">{product.code}</span>
                <CopyButton value={product.code} label="Copy product code" />
              </span>
            ),
          },
          { label: "Slug", value: <span className="sm-mono">{product.slug}</span> },
          { label: "Type", value: sentenceCase(product.product_type) },
          {
            label: "Fulfillment",
            value: sentenceCase(product.fulfillment_type),
          },
          {
            label: "Status",
            value: <StatusBadge status={product.status} />,
          },
          {
            label: "Activation limit",
            value: <span className="sm-tabular">{product.default_activation_limit}</span>,
          },
          {
            label: "Offline grace",
            value: `${product.offline_grace_hours} hours`,
          },
          { label: "Created", value: <DateCell value={product.created_at} /> },
        ]}
      >

        <Card
          title={`Features (${product.features.length})`}
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon={Plus}
              onClick={() => {
                void navigate({
                  to: "/features",
                  search: { product: product.id },
                } as never);
              }}
            >
              Manage features
            </Button>
          }
        >
          {product.features.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No features yet"
              body="Features define what a package grants to a customer."
              actionLabel="Create feature"
              onAction={() => {
                void navigate({
                  to: "/features",
                  search: { product: product.id },
                } as never);
              }}
            />
          ) : (
            <div className="sm-table-wrap">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Name</th>
                    <th>Value type</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {product.features.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <span className="sm-mono">{f.feature_key}</span>
                      </td>
                      <td>
                        <a href={`/features/${f.id}?product=${product.id}`}>{f.name}</a>
                      </td>
                      <td>{f.value_type}</td>
                      <td>
                        <StatusBadge status={f.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div style={{ marginTop: 24 }}>
          <Card
            title={`Packages (${product.packages.length})`}
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon={Plus}
                onClick={() => {
                  void navigate({
                    to: "/packages",
                    search: { product: product.id },
                  } as never);
                }}
              >
                Manage packages
              </Button>
            }
          >
            {product.packages.length === 0 ? (
              <EmptyState
                icon={Package}
                title="No packages yet"
                body="Packages bundle features into something a customer can buy."
                actionLabel="Create package"
                onAction={() => {
                  void navigate({
                    to: "/packages",
                    search: { product: product.id },
                  } as never);
                }}
              />
            ) : (
              <div className="sm-table-wrap">
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Name</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {product.packages.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <span className="sm-mono">{p.package_key}</span>
                        </td>
                        <td>
                          <a href={`/packages/${p.id}`}>{p.name}</a>
                        </td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <EditProductDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          product={product}
        />
      </DetailLayout>
    </section>
  );
}
