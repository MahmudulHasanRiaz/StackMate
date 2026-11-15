/**
 * Features — list + detail (catalog, features live under products).
 *
 * Routes (wired by the parent in router.tsx): /features,
 * /features/$featureId. List search params (URL-backed): q, page,
 * pageSize, product (selected product id), status.
 *
 * NOTE on routing: see products.tsx header — the typed
 * `useSearch({ from: "/features" })` form cannot typecheck until the
 * parent wires the routes (verified TS2322). This file reads the same
 * location.search through `useRouterState` and updates it with a
 * search-updater `navigate()`.
 *
 * There is NO global features list endpoint and NO global feature
 * detail endpoint — every feature call is scoped to its product:
 *  GET    /api/v1/admin/products/:productId/features              products.read
 *  POST   /api/v1/admin/products/:productId/features              features.manage
 *  GET    /api/v1/admin/products/:productId/features/:featureId   products.read
 *  PATCH  /api/v1/admin/products/:productId/features/:featureId   features.manage
 *  POST   /api/v1/admin/products/:productId/features/:featureId/archive
 *                                                                 features.manage
 * Archive is refused with 409 while a published package version
 * references the feature (service message is surfaced verbatim).
 */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ListChecks, Plus } from "lucide-react";
import { FEATURE_VALUE_TYPES } from "../../../../packages/contracts/src/index.ts";
import { apiRequest } from "../lib/api-client";
import { detailKey } from "../lib/query";
import {
  apiErrorMessage,
  DetailFacts,
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminList,
  useAdminMutation,
} from "../lib/section-kit";
import {
  Alert,
  Button,
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
import type { ProductListItem } from "./products";

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */
export interface FeatureDto {
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

type FeatureValueType = FeatureDto["value_type"];

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

/** Human rendering of a stored typed entitlement value. */
export function formatEntitlement(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (o.unlimited === true) return "Unlimited";
    if (typeof o.value === "boolean") return o.value ? "Yes" : "No";
    if (typeof o.value === "number") {
      const unit = typeof o.unit === "string" && o.unit ? ` ${o.unit}` : "";
      const period =
        typeof o.period === "string" && o.period ? ` / ${o.period}` : "";
      return `${o.value}${unit}${period}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Entitlement value editor state. One input set per value type; the
 * composed object always matches validateFeatureEntitlementValue in
 * contracts/catalog.ts.
 */
interface EntitlementDraft {
  boolValue: boolean;
  numValue: string;
  unlimited: boolean;
  period: "day" | "month" | "year";
}

function emptyEntitlementDraft(valueType: FeatureValueType): EntitlementDraft {
  return { boolValue: true, numValue: "", unlimited: true, period: "month" };
}

function draftFromStored(
  valueType: FeatureValueType,
  stored: unknown,
): EntitlementDraft {
  const draft = emptyEntitlementDraft(valueType);
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return draft;
  }
  const o = stored as Record<string, unknown>;
  if (valueType === "boolean" && typeof o.value === "boolean") {
    draft.boolValue = o.value;
  }
  if (valueType !== "boolean") {
    if (o.unlimited === true) {
      draft.unlimited = true;
    } else if (typeof o.value === "number") {
      draft.unlimited = false;
      draft.numValue = String(o.value);
    }
    if (o.period === "day" || o.period === "month" || o.period === "year") {
      draft.period = o.period;
    }
  }
  return draft;
}

function composeEntitlement(
  valueType: FeatureValueType,
  draft: EntitlementDraft,
): { value: unknown; error?: string } {
  if (valueType === "boolean") {
    return { value: { value_type: "boolean", value: draft.boolValue } };
  }
  if (draft.unlimited) {
    const base: Record<string, unknown> = {
      value_type: valueType,
      value: null,
      unlimited: true,
    };
    if (valueType === "quota" || valueType === "metered") base.period = draft.period;
    if (valueType === "metered") base.overage_policy = "block";
    return { value: base };
  }
  const n = Number(draft.numValue);
  if (!Number.isInteger(n) || n < 0) {
    return { value: null, error: "Enter a whole number of 0 or more, or tick Unlimited." };
  }
  const base: Record<string, unknown> = { value_type: valueType, value: n };
  if (valueType === "quota" || valueType === "metered") base.period = draft.period;
  if (valueType === "metered") base.overage_policy = "block";
  return { value: base };
}

function EntitlementInputs({
  valueType,
  draft,
  onChange,
  error,
  idPrefix,
}: {
  valueType: FeatureValueType;
  draft: EntitlementDraft;
  onChange: (next: EntitlementDraft) => void;
  error?: string;
  idPrefix: string;
}) {
  if (valueType === "boolean") {
    return (
      <Checkbox
        label="Default: enabled"
        checked={draft.boolValue}
        onChange={(e) => onChange({ ...draft, boolValue: e.target.checked })}
      />
    );
  }
  return (
    <div>
      <div className="sm-form-grid">
        <Field label="Default value" {...(error ? { error } : {})} htmlFor={`${idPrefix}-num`}>
          <Input
            id={`${idPrefix}-num`}
            type="number"
            min={0}
            disabled={draft.unlimited}
            value={draft.numValue}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onChange({ ...draft, numValue: e.target.value })}
            placeholder="0"
          />
        </Field>
        {valueType === "quota" || valueType === "metered" ? (
          <Field label="Period" htmlFor={`${idPrefix}-period`}>
            <Select
              id={`${idPrefix}-period`}
              value={draft.period}
              onChange={(e) =>
                onChange({
                  ...draft,
                  period: e.target.value as EntitlementDraft["period"],
                })
              }
            >
              <option value="day">Day</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </Select>
          </Field>
        ) : null}
      </div>
      <div style={{ marginTop: 8 }}>
        <Checkbox
          label="Unlimited"
          checked={draft.unlimited}
          onChange={(e) => onChange({ ...draft, unlimited: e.target.checked })}
        />
      </div>
    </div>
  );
}

const FEATURE_KEY_RE = /^[a-z][a-z0-9_.]*$/;

/* ------------------------------------------------------------------ */
/* Create feature form (CreateProductFeatureSchema)                     */
/* ------------------------------------------------------------------ */
function CreateFeatureDialog({
  open,
  onClose,
  productId,
}: {
  open: boolean;
  onClose: () => void;
  productId: string;
}) {
  const [featureKey, setFeatureKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [valueType, setValueType] = useState<FeatureValueType>("boolean");
  const [unit, setUnit] = useState("");
  const [entitlement, setEntitlement] = useState<EntitlementDraft>(
    emptyEntitlementDraft("boolean"),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const create = useAdminMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<FeatureDto>(`/api/v1/admin/products/${productId}/features`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [
      ["admin", "features", "list", productId],
      detailKey("products", productId),
    ],
    successTitle: "Feature created",
    onSuccess: () => onClose(),
  });

  function submitForm() {
    setSubmitError(null);
    const next: Record<string, string> = {};
    const key = featureKey.trim().toLowerCase();
    if (key.length < 2 || key.length > 120 || !FEATURE_KEY_RE.test(key)) {
      next.featureKey =
        "snake_case, starts with a letter, e.g. b1_extra (no hyphens).";
    }
    if (name.trim().length < 2 || name.trim().length > 160) {
      next.name = "Name is required (2–160 chars).";
    }
    const composed = composeEntitlement(valueType, entitlement);
    if (composed.error) next.entitlement = composed.error;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body: Record<string, unknown> = {
      feature_key: key,
      name: name.trim(),
      value_type: valueType,
      default_value: composed.value,
    };
    if (description.trim()) body.description = description.trim();
    if (unit.trim()) body.unit = unit.trim();
    create.mutate(body, {
      onError: (err) => setSubmitError(apiErrorMessage(err)),
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create feature"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={submitForm}>
            Create feature
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
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submitForm();
        }}
      >
        <div className="sm-form-grid">
          <Field
            label="Feature key"
            required
            hint="snake_case, e.g. b1_extra"
            {...(errors.featureKey ? { error: errors.featureKey } : {})}
            htmlFor="cf-key"
          >
            <Input
              id="cf-key"
              value={featureKey}
              aria-invalid={errors.featureKey ? true : undefined}
              onChange={(e) => setFeatureKey(e.target.value.toLowerCase())}
              placeholder="b1_extra"
            />
          </Field>
          <Field label="Name" required {...(errors.name ? { error: errors.name } : {})} htmlFor="cf-name">
            <Input
              id="cf-name"
              value={name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => setName(e.target.value)}
              placeholder="Feature name"
            />
          </Field>
          <Field label="Value type" required htmlFor="cf-type">
            <Select
              id="cf-type"
              value={valueType}
              onChange={(e) => {
                const next = e.target.value as FeatureValueType;
                setValueType(next);
                setEntitlement(emptyEntitlementDraft(next));
              }}
            >
              {FEATURE_VALUE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {sentenceCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit" hint="e.g. seats, GB" htmlFor="cf-unit">
            <Input
              id="cf-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="seats"
            />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field
            label="Default value"
            hint="Used when a package does not set its own value"
            {...(errors.entitlement ? { error: errors.entitlement } : {})}
          >
            <EntitlementInputs
              valueType={valueType}
              draft={entitlement}
              onChange={setEntitlement}
              {...(errors.entitlement ? { error: errors.entitlement } : {})}
              idPrefix="cf-default"
            />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label="Description" htmlFor="cf-description">
            <Textarea
              id="cf-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Features list (per product — no global list endpoint exists)        */
/* ------------------------------------------------------------------ */
const STATUS_FILTERS = ["all", "active", "archived"] as const;

export function FeaturesSection() {
  const { raw, list } = useRouteSearch();
  const updateSearch = useSearchUpdater();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const confirm = useConfirm();

  const productsQuery = useAdminList<ProductListItem>(
    "products",
    "/api/v1/admin/products",
  );
  const products = productsQuery.data ?? [];

  const productParam =
    typeof raw.product === "string" && raw.product.length > 0
      ? raw.product
      : undefined;

  // Default to the first product so the page is never a dead end; the
  // choice is written back to the URL (product=…).
  useEffect(() => {
    if (!productParam && products.length > 0) {
      const first = products[0];
      if (first) updateSearch({ product: first.id });
    }
    // Run only when the product list first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.length === 0, productParam]);

  const productId = productParam ?? products[0]?.id;
  const selectedProduct = products.find((p) => p.id === productId);

  const featuresQuery = useQuery({
    queryKey: ["admin", "features", "list", productId ?? "none"],
    queryFn: async () => {
      const res = await apiRequest<{ items: FeatureDto[] }>(
        `/api/v1/admin/products/${productId}/features`,
      );
      return res.items;
    },
    enabled: Boolean(productId),
  });

  const archive = useAdminMutation({
    mutationFn: (feature: FeatureDto) =>
      apiRequest<FeatureDto>(
        `/api/v1/admin/products/${feature.product_id}/features/${feature.id}/archive`,
        { method: "POST" },
      ),
    invalidateKeys: [
      ["admin", "features", "list", productId ?? "none"],
      detailKey("products", productId ?? ""),
    ],
    successTitle: "Feature archived",
  });

  const statusFilter =
    typeof raw.status === "string" &&
    (STATUS_FILTERS as readonly string[]).includes(raw.status)
      ? raw.status
      : "all";
  const search = list.q ?? "";
  const rows = (featuresQuery.data ?? []).filter((f) =>
    statusFilter === "all" ? true : f.status === statusFilter,
  );

  async function onArchive(feature: FeatureDto) {
    const ok = await confirm({
      title: "Archive feature?",
      body: (
        <div>
          <p style={{ marginTop: 0 }}>
            “{feature.name}” ({feature.feature_key}) will move to Archived.
          </p>
          <p style={{ marginBottom: 0 }}>
            Archiving is refused while a published package version references
            this feature — retire that version first. Existing grants keep
            working until then.
          </p>
        </div>
      ),
      confirmLabel: "Archive",
      danger: true,
    });
    if (ok) archive.mutate(feature);
  }

  const columns: ColumnDef<FeatureDto, unknown>[] = [
    {
      accessorKey: "feature_key",
      header: "Key",
      cell: ({ row }) => (
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <span className="sm-mono">{row.original.feature_key}</span>
          <CopyButton
            value={row.original.feature_key}
            label={`Copy key ${row.original.feature_key}`}
          />
        </span>
      ),
    },
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <a
          href={`/features/${row.original.id}?product=${row.original.product_id}`}
        >
          {row.original.name}
        </a>
      ),
    },
    {
      accessorKey: "value_type",
      header: "Value type",
      cell: ({ row }) => row.original.value_type,
    },
    {
      accessorKey: "unit",
      header: "Unit",
      cell: ({ row }) => row.original.unit ?? "—",
    },
    {
      accessorKey: "default_value",
      header: "Default",
      cell: ({ row }) => formatEntitlement(row.original.default_value),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateCell value={row.original.created_at} />,
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) =>
        row.original.status === "active" ? (
          <Button
            variant="danger-ghost"
            size="sm"
            loading={archive.isPending}
            onClick={() => void onArchive(row.original)}
          >
            Archive
          </Button>
        ) : null,
    },
  ];

  return (
    <section aria-labelledby="features-heading">
      <PageHeader
        breadcrumb={[{ label: "Features" }]}
        title="Features"
        subtitle={
          selectedProduct
            ? `Features of ${selectedProduct.name}`
            : "Features live under a product — pick one"
        }
        action={
          <Button
            variant="primary"
            icon={Plus}
            disabled={!productId}
            onClick={() => setCreateOpen(true)}
          >
            Create feature
          </Button>
        }
      />
      {productsQuery.isPending ? (
        <div className="sm-table-wrap" style={{ padding: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ height: 20, width: "40%" }} className="sm-skeleton" />
            <div style={{ height: 20, width: "70%" }} className="sm-skeleton" />
            <div style={{ height: 20, width: "55%" }} className="sm-skeleton" />
          </div>
        </div>
      ) : productsQuery.isError ? (
        <div className="sm-table-wrap">
          <ErrorState
            message={apiErrorMessage(productsQuery.error)}
            onRetry={() => void productsQuery.refetch()}
          />
        </div>
      ) : products.length === 0 ? (
        <div className="sm-table-wrap">
          <EmptyState
            icon={ListChecks}
            title="No products yet"
            body="Create a product first — features belong to a product."
            actionLabel="Go to products"
            onAction={() => {
              void navigate({ to: "/products" } as never);
            }}
          />
        </div>
      ) : (
        <ListTable
          columns={columns}
          data={rows}
          search={search}
          onSearchChange={(q) => updateSearch({ q: q || undefined, page: 1 })}
          page={list.page ?? 1}
          onPageChange={(page) => updateSearch({ page })}
          pageSize={list.pageSize ?? 25}
          onPageSizeChange={(pageSize) => updateSearch({ pageSize, page: 1 })}
          isLoading={featuresQuery.isPending}
          isError={featuresQuery.isError}
          error={featuresQuery.error}
          onRetry={() => void featuresQuery.refetch()}
          emptyIcon={ListChecks}
          emptyTitle="No features yet"
          emptyBody={`This product has no features yet. Create the first one.`}
          emptyActionLabel="Create feature"
          onEmptyAction={() => setCreateOpen(true)}
          getRowId={(row) => row.id}
          toolbar={
            <>
              <Select
                value={productId ?? ""}
                aria-label="Product"
                style={{ width: "auto", minWidth: 200 }}
                onChange={(e) =>
                  updateSearch({ product: e.target.value, page: 1 })
                }
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="sm-chip"
                  aria-pressed={statusFilter === s}
                  onClick={() =>
                    updateSearch({ status: s === "all" ? undefined : s, page: 1 })
                  }
                >
                  {s === "all" ? "All" : sentenceCase(s)}
                </button>
              ))}
            </>
          }
        />
      )}
      {productId ? (
        <CreateFeatureDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          productId={productId}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Feature detail                                                      */
/* ------------------------------------------------------------------ */
function EditFeatureDialog({
  open,
  onClose,
  feature,
}: {
  open: boolean;
  onClose: () => void;
  feature: FeatureDto;
}) {
  const [name, setName] = useState(feature.name);
  const [description, setDescription] = useState(feature.description ?? "");
  const [unit, setUnit] = useState(feature.unit ?? "");
  const [entitlement, setEntitlement] = useState<EntitlementDraft>(
    draftFromStored(feature.value_type, feature.default_value),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const save = useAdminMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<FeatureDto>(
        `/api/v1/admin/products/${feature.product_id}/features/${feature.id}`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    invalidateKeys: [
      detailKey("features", feature.id),
      ["admin", "features", "list", feature.product_id],
    ],
    successTitle: "Feature updated",
    onSuccess: () => onClose(),
  });

  function submitForm() {
    setSubmitError(null);
    const next: Record<string, string> = {};
    if (name.trim().length < 2 || name.trim().length > 160) {
      next.name = "Name is required (2–160 chars).";
    }
    const composed = composeEntitlement(feature.value_type, entitlement);
    if (composed.error) next.entitlement = composed.error;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate(
      {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        unit: unit.trim() ? unit.trim() : null,
        default_value: composed.value,
      },
      { onError: (err) => setSubmitError(apiErrorMessage(err)) },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit feature"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submitForm}>
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
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submitForm();
        }}
      >
        <div className="sm-form-grid">
          <Field label="Name" required {...(errors.name ? { error: errors.name } : {})} htmlFor="ef-name">
            <Input
              id="ef-name"
              value={name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Unit" htmlFor="ef-unit">
            <Input
              id="ef-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="seats"
            />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field
            label="Default value"
            hint="Key and value type cannot be changed"
            {...(errors.entitlement ? { error: errors.entitlement } : {})}
          >
            <EntitlementInputs
              valueType={feature.value_type}
              draft={entitlement}
              onChange={setEntitlement}
              {...(errors.entitlement ? { error: errors.entitlement } : {})}
              idPrefix="ef-default"
            />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label="Description" htmlFor="ef-description">
            <Textarea
              id="ef-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

export function FeatureDetailSection({ id }: { id: string }) {
  const { raw } = useRouteSearch();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);

  // The detail endpoint is product-scoped; the list links here with
  // ?product=<productId>. If a deep link arrives without it, resolve
  // the owning product by scanning each product's feature list.
  const productParam =
    typeof raw.product === "string" && raw.product.length > 0
      ? raw.product
      : undefined;
  const resolveQuery = useQuery({
    queryKey: ["admin", "features", "resolve-product", id],
    queryFn: async () => {
      const { items: products } = await apiRequest<{ items: ProductListItem[] }>(
        "/api/v1/admin/products",
      );
      for (const p of products) {
        const { items } = await apiRequest<{ items: FeatureDto[] }>(
          `/api/v1/admin/products/${p.id}/features`,
        );
        if (items.some((f) => f.id === id)) return p.id;
      }
      return null;
    },
    enabled: !productParam,
  });
  const productId = productParam ?? resolveQuery.data ?? undefined;

  // Only fetch once the owning product is known (the endpoint is
  // product-scoped, so there is no product-less detail call).
  const detailQuery = useQuery({
    queryKey: detailKey("features", id),
    queryFn: () =>
      apiRequest<FeatureDto>(
        `/api/v1/admin/products/${productId}/features/${id}`,
      ),
    enabled: Boolean(productId),
  });

  const archive = useAdminMutation({
    mutationFn: (_: void) =>
      apiRequest<FeatureDto>(
        `/api/v1/admin/products/${productId}/features/${id}/archive`,
        { method: "POST" },
      ),
    invalidateKeys: [
      detailKey("features", id),
      ["admin", "features", "list", productId ?? ""],
    ],
    successTitle: "Feature archived",
    onSuccess: () => {
      void navigate({ to: "/features", search: { product: productId } } as never);
    },
  });

  if (!productId) {
    if (resolveQuery.isPending) {
      return (
        <section aria-labelledby="feature-detail-heading">
          <PageHeader
            breadcrumb={[{ label: "Features", href: "/features" }, { label: "…" }]}
            title="Feature"
          />
          <div className="sm-table-wrap" style={{ padding: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ height: 20, width: "40%" }} className="sm-skeleton" />
              <div style={{ height: 20, width: "70%" }} className="sm-skeleton" />
            </div>
          </div>
        </section>
      );
    }
    return (
      <section aria-labelledby="feature-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Features", href: "/features" }, { label: "Feature" }]}
          title="Feature"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message="This feature could not be found under any product."
            onRetry={() => void resolveQuery.refetch()}
          />
        </div>
      </section>
    );
  }

  if (detailQuery.isPending) {
    return (
      <section aria-labelledby="feature-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Features", href: "/features" }, { label: "…" }]}
          title="Feature"
        />
        <div className="sm-table-wrap" style={{ padding: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ height: 20, width: "40%" }} className="sm-skeleton" />
            <div style={{ height: 20, width: "70%" }} className="sm-skeleton" />
            <div style={{ height: 20, width: "55%" }} className="sm-skeleton" />
          </div>
        </div>
      </section>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <section aria-labelledby="feature-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Features", href: "/features" }, { label: "Feature" }]}
          title="Feature"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={apiErrorMessage(detailQuery.error)}
            onRetry={() => void detailQuery.refetch()}
          />
        </div>
      </section>
    );
  }

  const feature = detailQuery.data;

  async function onArchive() {
    const ok = await confirm({
      title: "Archive feature?",
      body: (
        <div>
          <p style={{ marginTop: 0 }}>
            “{feature.name}” ({feature.feature_key}) will move to Archived.
          </p>
          <p style={{ marginBottom: 0 }}>
            Archiving is refused while a published package version references
            this feature — retire that version first.
          </p>
        </div>
      ),
      confirmLabel: "Archive",
      danger: true,
    });
    if (ok) archive.mutate();
  }

  return (
    <section aria-labelledby="feature-detail-heading">
      <PageHeader
        breadcrumb={[
          { label: "Features", href: "/features" },
          { label: feature.name },
        ]}
        title={feature.name}
        {...(feature.description ? { subtitle: feature.description } : {})}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            {feature.status === "active" ? (
              <Button
                variant="danger-ghost"
                loading={archive.isPending}
                onClick={() => void onArchive()}
              >
                Archive
              </Button>
            ) : null}
          </div>
        }
      />
      <DetailFacts
        facts={[
          {
            label: "Key",
            value: (
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <span className="sm-mono">{feature.feature_key}</span>
                <CopyButton value={feature.feature_key} label="Copy feature key" />
              </span>
            ),
          },
          {
            label: "Product",
            value: (
              <a href={`/products/${feature.product_id}`}>View product</a>
            ),
          },
          { label: "Value type", value: feature.value_type },
          { label: "Unit", value: feature.unit ?? "—" },
          {
            label: "Default value",
            value: formatEntitlement(feature.default_value),
          },
          {
            label: "Status",
            value: <StatusBadge status={feature.status} />,
          },
          { label: "Created", value: <DateCell value={feature.created_at} /> },
          { label: "Updated", value: <DateCell value={feature.updated_at} /> },
        ]}
      />
      <EditFeatureDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        feature={feature}
      />
    </section>
  );
}
