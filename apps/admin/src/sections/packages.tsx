/**
 * Packages & Pricing — list + detail (catalog).
 *
 * Routes (wired by the parent in router.tsx): /packages,
 * /packages/$packageId. List search params (URL-backed): q, page,
 * pageSize, product (selected product id), status.
 *
 * NOTE on routing: see products.tsx header — the typed
 * `useSearch({ from: "/packages" })` form cannot typecheck until the
 * parent wires the routes (verified TS2322). This file reads the same
 * location.search through `useRouterState` and updates it with a
 * search-updater `navigate()`.
 *
 * There is NO global packages list endpoint — packages are listed
 * per product. Verified endpoints (apps/api/src/app.ts +
 * modules/catalog/service.ts):
 *  GET    /api/v1/admin/products/:productId/packages           products.read
 *  POST   /api/v1/admin/products/:productId/packages           packages.manage
 *         (creates the package AND its draft v1)
 *  GET    /api/v1/admin/packages/:packageId                    products.read
 *  PATCH  /api/v1/admin/packages/:packageId                    packages.manage
 *  POST   /api/v1/admin/packages/:packageId/versions           packages.manage
 *  POST   /api/v1/admin/package-versions/:versionId/publish    packages.publish
 *  POST   /api/v1/admin/package-versions/:versionId/retire     packages.publish
 *         (published-only; 409 on draft — surfaced verbatim)
 *  GET    /api/v1/admin/package-versions/:versionId/prices     products.read
 *  POST   /api/v1/admin/package-versions/:versionId/prices     packages.manage
 *  GET    /api/v1/admin/prices/:priceId                        products.read
 *  PATCH  /api/v1/admin/prices/:priceId                        packages.manage
 *         (409 if used_in_orders — surfaced verbatim)
 *  POST   /api/v1/admin/prices/:priceId/disable                packages.manage
 * Price status vocabulary: active | inactive | retired.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Tags } from "lucide-react";
import { PRICE_KINDS, INTERVAL_UNITS } from "../../../../packages/contracts/src/index.ts";
import { apiRequest } from "../lib/api-client";
import { detailKey } from "../lib/query";
import {
  apiErrorMessage,
  DetailFacts,
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
  MoneyCell,
  Select,
  StatusBadge,
  Tabs,
  Textarea,
  useConfirm,
} from "../components/primitives";
import type { ProductListItem } from "./products";
import type { FeatureDto } from "./features";

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */
export interface PackageVersionGrant {
  id: string;
  package_version_id: string;
  product_id: string;
  product_feature_id: string;
  feature_key_snapshot: string;
  value_type_snapshot: "boolean" | "limit" | "quota" | "metered";
  entitlement_value: unknown;
  unit_snapshot: string | null;
}

export interface PackagePriceDto {
  id: string;
  package_version_id: string;
  price_key: string;
  price_kind: "free" | "one_time" | "recurring" | "lifetime";
  amount_minor: number;
  currency_code: string;
  interval_unit: "day" | "week" | "month" | "year" | null;
  interval_count: number | null;
  trial_days: number;
  setup_fee_minor: number;
  status: "active" | "inactive" | "retired";
  used_in_orders: boolean;
  created_at: string;
}

export interface PackageVersionDto {
  id: string;
  package_id: string;
  product_id: string;
  version_number: number;
  status: "draft" | "published" | "retired";
  change_summary: string | null;
  features: PackageVersionGrant[];
  published_at: string | null;
  created_at: string;
  prices?: PackagePriceDto[];
}

export interface PackageDto {
  id: string;
  product_id: string;
  package_key: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  versions: PackageVersionDto[];
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

function formatEntitlement(value: unknown): string {
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

function formatInterval(price: PackagePriceDto): string {
  if (price.price_kind !== "recurring") return "—";
  const unit = price.interval_unit ?? "month";
  const count = price.interval_count ?? 1;
  return `Every ${count} ${unit}${count > 1 ? "s" : ""}`;
}

/** Major units (e.g. BDT) → integer minor units. */
function toMinor(input: string): { minor: number; error?: string } {
  const n = Number(input);
  if (input.trim() === "" || !Number.isFinite(n) || n < 0) {
    return { minor: 0, error: "Enter an amount of 0 or more." };
  }
  return { minor: Math.round(n * 100) };
}

/* ------------------------------------------------------------------ */
/* Feature grants editor (package create + new version)                */
/* ------------------------------------------------------------------ */
interface GrantDraft {
  included: boolean;
  boolValue: boolean;
  numValue: string;
  unlimited: boolean;
  period: "day" | "month" | "year";
}

function grantDraftFromFeature(feature: FeatureDto): GrantDraft {
  const draft: GrantDraft = {
    included: false,
    boolValue: true,
    numValue: "",
    unlimited: true,
    period: "month",
  };
  const stored = feature.default_value;
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    const o = stored as Record<string, unknown>;
    if (feature.value_type === "boolean" && typeof o.value === "boolean") {
      draft.boolValue = o.value;
    }
    if (feature.value_type !== "boolean") {
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
  }
  return draft;
}

function composeGrant(
  feature: FeatureDto,
  draft: GrantDraft,
): { grant: { product_feature_id: string; entitlement_value: unknown }; error?: string } {
  const base = { product_feature_id: feature.id };
  if (feature.value_type === "boolean") {
    return {
      grant: {
        ...base,
        entitlement_value: { value_type: "boolean", value: draft.boolValue },
      },
    };
  }
  if (draft.unlimited) {
    const value: Record<string, unknown> = {
      value_type: feature.value_type,
      value: null,
      unlimited: true,
    };
    if (feature.value_type === "quota" || feature.value_type === "metered") {
      value.period = draft.period;
    }
    if (feature.value_type === "metered") value.overage_policy = "block";
    return { grant: { ...base, entitlement_value: value } };
  }
  const n = Number(draft.numValue);
  if (!Number.isInteger(n) || n < 0) {
    return {
      grant: { ...base, entitlement_value: null },
      error: `“${feature.feature_key}” needs a whole number of 0 or more, or Unlimited.`,
    };
  }
  const value: Record<string, unknown> = {
    value_type: feature.value_type,
    value: n,
  };
  if (feature.value_type === "quota" || feature.value_type === "metered") {
    value.period = draft.period;
  }
  if (feature.value_type === "metered") value.overage_policy = "block";
  return { grant: { ...base, entitlement_value: value } };
}

function FeatureGrantsEditor({
  features,
  drafts,
  onChange,
  error,
}: {
  features: FeatureDto[];
  drafts: Record<string, GrantDraft>;
  onChange: (next: Record<string, GrantDraft>) => void;
  error?: string;
}) {
  if (features.length === 0) {
    return (
      <p className="sm-hint">
        No features on this product yet — the package can still be created with
        no grants, and features can be added in a later version.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {error ? (
        <Alert variant="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {features.map((f) => {
        const draft = drafts[f.id] ?? grantDraftFromFeature(f);
        return (
          <div key={f.id} className="sm-bordered-card">
            <Checkbox
              label={`${f.name} (${f.feature_key})`}
              checked={draft.included}
              onChange={(e) =>
                onChange({
                  ...drafts,
                  [f.id]: { ...draft, included: e.target.checked },
                })
              }
            />
            {draft.included && f.value_type === "boolean" ? (
              <div style={{ marginTop: 8, paddingLeft: 24 }}>
                <Checkbox
                  label="Granted"
                  checked={draft.boolValue}
                  onChange={(e) =>
                    onChange({
                      ...drafts,
                      [f.id]: { ...draft, boolValue: e.target.checked },
                    })
                  }
                />
              </div>
            ) : null}
            {draft.included && f.value_type !== "boolean" ? (
              <div
                style={{
                  marginTop: 8,
                  paddingLeft: 24,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 12,
                  alignItems: "flex-end",
                }}
              >
                <div>
                  <label className="sm-label" htmlFor={`grant-${f.id}-num`}>
                    Value{f.unit ? ` (${f.unit})` : ""}
                  </label>
                  <Input
                    id={`grant-${f.id}-num`}
                    type="number"
                    min={0}
                    disabled={draft.unlimited}
                    value={draft.numValue}
                    onChange={(e) =>
                      onChange({
                        ...drafts,
                        [f.id]: { ...draft, numValue: e.target.value },
                      })
                    }
                    placeholder="0"
                  />
                </div>
                {f.value_type === "quota" || f.value_type === "metered" ? (
                  <div>
                    <label className="sm-label" htmlFor={`grant-${f.id}-period`}>
                      Period
                    </label>
                    <Select
                      id={`grant-${f.id}-period`}
                      value={draft.period}
                      onChange={(e) =>
                        onChange({
                          ...drafts,
                          [f.id]: {
                            ...draft,
                            period: e.target.value as GrantDraft["period"],
                          },
                        })
                      }
                    >
                      <option value="day">Day</option>
                      <option value="month">Month</option>
                      <option value="year">Year</option>
                    </Select>
                  </div>
                ) : null}
                <Checkbox
                  label="Unlimited"
                  checked={draft.unlimited}
                  onChange={(e) =>
                    onChange({
                      ...drafts,
                      [f.id]: { ...draft, unlimited: e.target.checked },
                    })
                  }
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create package (CreateProductPackageSchema — creates draft v1)      */
/* ------------------------------------------------------------------ */
const PACKAGE_KEY_RE = /^[a-z0-9_-]+$/;

/* ------------------------------------------------------------------ */
/* Create package — stepped builder (F2): product → details →         */
/* features → review. Creates a DRAFT (v1 draft); publishing stays a  */
/* separate explicit action on the package detail page.               */
/* ------------------------------------------------------------------ */
const WIZARD_STEPS = [
  { key: "product", label: "1 · Product" },
  { key: "details", label: "2 · Details" },
  { key: "features", label: "3 · Features" },
  { key: "review", label: "4 · Review" },
] as const;

type WizardStep = (typeof WIZARD_STEPS)[number]["key"];

function CreatePackageDialog({
  open,
  onClose,
  productId,
  products,
}: {
  open: boolean;
  onClose: () => void;
  productId: string;
  products: ProductListItem[];
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>("product");
  const [maxStep, setMaxStep] = useState(0);
  const [wizardProductId, setWizardProductId] = useState(productId);
  const [packageKey, setPackageKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [drafts, setDrafts] = useState<Record<string, GrantDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Fresh wizard on every open, pre-filled with the product the user
  // came from (list picker or product detail).
  useEffect(() => {
    if (!open) return;
    setStep("product");
    setMaxStep(0);
    setWizardProductId(productId);
    setPackageKey("");
    setName("");
    setDescription("");
    setChangeSummary("");
    setDrafts({});
    setErrors({});
    setSubmitError(null);
  }, [open, productId]);

  const wizardProduct = products.find((p) => p.id === wizardProductId);

  const featuresQuery = useQuery({
    queryKey: ["admin", "features", "list", wizardProductId],
    queryFn: async () => {
      const res = await apiRequest<{ items: FeatureDto[] }>(
        `/api/v1/admin/products/${wizardProductId}/features`,
      );
      return res.items;
    },
    enabled: open,
  });
  const features = (featuresQuery.data ?? []).filter(
    (f) => f.status === "active",
  );

  const create = useAdminMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<{ package: PackageDto }>(
        `/api/v1/admin/products/${wizardProductId}/packages`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    invalidateKeys: [
      ["admin", "packages", "list", wizardProductId],
      detailKey("products", wizardProductId),
      ["admin", "products", "list"],
    ],
    successTitle: "Package created",
    onSuccess: (created) => {
      onClose();
      void navigate({ to: `/packages/${created.package.id}` } as never);
    },
  });

  function validateDetails(): Record<string, string> {
    const next: Record<string, string> = {};
    const key = packageKey.trim().toLowerCase();
    if (key.length < 2 || key.length > 100 || !PACKAGE_KEY_RE.test(key)) {
      next.packageKey = "2–100 chars, lowercase letters, digits, hyphens or underscores.";
    }
    if (name.trim().length < 2 || name.trim().length > 160) {
      next.name = "Name is required (2–160 chars).";
    }
    return next;
  }

  function composeGrants(): {
    grants: Array<{ product_feature_id: string; entitlement_value: unknown }>;
    error?: string;
  } {
    const grants: Array<{ product_feature_id: string; entitlement_value: unknown }> = [];
    for (const f of features) {
      const draft = drafts[f.id];
      if (!draft?.included) continue;
      const composed = composeGrant(f, draft);
      if (composed.error) return { grants, error: composed.error };
      grants.push(composed.grant);
    }
    return { grants };
  }

  function advance(next: WizardStep) {
    const idx = WIZARD_STEPS.findIndex((s) => s.key === next);
    setMaxStep((m) => Math.max(m, idx));
    setStep(next);
  }

  /** Step tabs: back to any step already reached, never forward past it. */
  function goStep(key: string) {
    const idx = WIZARD_STEPS.findIndex((s) => s.key === key);
    if (idx <= maxStep) setStep(key as WizardStep);
  }

  function goNext() {
    if (step === "product") {
      if (!wizardProductId) return;
      advance("details");
      return;
    }
    if (step === "details") {
      const next = validateDetails();
      setErrors(next);
      if (Object.keys(next).length > 0) return;
      advance("features");
      return;
    }
    if (step === "features") {
      const { error } = composeGrants();
      if (error) {
        setErrors({ grants: error });
        return;
      }
      setErrors({});
      advance("review");
    }
  }

  function goBack() {
    const idx = WIZARD_STEPS.findIndex((s) => s.key === step);
    const prev = WIZARD_STEPS[idx - 1];
    if (prev) setStep(prev.key);
  }

  function submitForm() {
    setSubmitError(null);
    const next = validateDetails();
    const { grants, error } = composeGrants();
    if (error) next.grants = error;
    setErrors(next);
    if (Object.keys(next).length > 0) {
      // Should not happen (each step validates on entry), but never
      // create from the review step with a bad value — go back to it.
      if (next.packageKey || next.name) setStep("details");
      else if (next.grants) setStep("features");
      return;
    }
    const body: Record<string, unknown> = {
      package_key: packageKey.trim().toLowerCase(),
      name: name.trim(),
      features: grants,
    };
    if (description.trim()) body.description = description.trim();
    if (changeSummary.trim()) body.change_summary = changeSummary.trim();
    create.mutate(body, {
      onError: (err) => setSubmitError(apiErrorMessage(err)),
    });
  }

  const includedGrants = features.filter((f) => drafts[f.id]?.included);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        step === "product" || !wizardProduct
          ? "Create package"
          : `Create package — ${wizardProduct.name}`
      }
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {step !== "product" ? (
            <Button variant="secondary" onClick={goBack}>
              Back
            </Button>
          ) : null}
          {step !== "review" ? (
            <Button variant="accent" onClick={goNext}>
              Next
            </Button>
          ) : (
            <Button variant="accent" loading={create.isPending} onClick={submitForm}>
              Create package
            </Button>
          )}
        </>
      }
    >
      <Tabs
        tabs={WIZARD_STEPS.map((s) => ({ key: s.key, label: s.label }))}
        active={step}
        onChange={goStep}
      />
      {submitError ? (
        <Alert variant="danger" role="alert">
          {submitError}
        </Alert>
      ) : null}
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (step === "review") submitForm();
          else goNext();
        }}
      >
        {step === "product" ? (
          <Field
            label="Product"
            required
            hint="Packages belong to one product — the features in step 3 come from this product only."
            htmlFor="cpk-product"
          >
            <Select
              id="cpk-product"
              value={wizardProductId}
              onChange={(e) => {
                setWizardProductId(e.target.value);
                setDrafts({});
                setErrors({});
              }}
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {step === "details" ? (
          <>
            <div className="sm-form-grid">
              <Field
                label="Package key"
                required
                {...(errors.packageKey ? { error: errors.packageKey } : {})}
                htmlFor="cpk-key"
              >
                <Input
                  id="cpk-key"
                  value={packageKey}
                  aria-invalid={errors.packageKey ? true : undefined}
                  onChange={(e) => setPackageKey(e.target.value.toLowerCase())}
                  placeholder="starter"
                />
              </Field>
              <Field label="Name" required {...(errors.name ? { error: errors.name } : {})} htmlFor="cpk-name">
                <Input
                  id="cpk-name"
                  value={name}
                  aria-invalid={errors.name ? true : undefined}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Starter"
                />
              </Field>
              <Field label="Change summary" htmlFor="cpk-summary">
                <Input
                  id="cpk-summary"
                  value={changeSummary}
                  onChange={(e) => setChangeSummary(e.target.value)}
                  placeholder="Initial version"
                />
              </Field>
            </div>
            <div style={{ marginTop: 16 }}>
              <Field label="Description" htmlFor="cpk-description">
                <Textarea
                  id="cpk-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </div>
          </>
        ) : null}
        {step === "features" ? (
          <Field
            label="Features in version 1"
            hint={`Features of ${wizardProduct?.name ?? "this product"} — tick the ones version 1 grants.`}
            {...(errors.grants ? { error: errors.grants } : {})}
          >
            {featuresQuery.isPending ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ height: 20, width: "60%" }} className="sm-skeleton" />
                <div style={{ height: 20, width: "45%" }} className="sm-skeleton" />
              </div>
            ) : (
              <FeatureGrantsEditor
                features={features}
                drafts={drafts}
                onChange={setDrafts}
                {...(errors.grants ? { error: errors.grants } : {})}
              />
            )}
          </Field>
        ) : null}
        {step === "review" ? (
          <>
            <DetailFacts
              facts={[
                { label: "Product", value: wizardProduct?.name ?? "—" },
                {
                  label: "Package key",
                  value: (
                    <span className="sm-mono">{packageKey.trim().toLowerCase()}</span>
                  ),
                },
                { label: "Name", value: name.trim() },
                { label: "Description", value: description.trim() || "—" },
                {
                  label: "Change summary",
                  value: changeSummary.trim() || "Initial version",
                },
                {
                  label: "Features",
                  value:
                    includedGrants.length === 0
                      ? "None — version 1 grants nothing"
                      : includedGrants
                          .map((f) => {
                            const draft = drafts[f.id]!;
                            const composed = composeGrant(f, draft);
                            return `${f.name} (${f.feature_key}) — ${formatEntitlement(composed.grant.entitlement_value)}`;
                          })
                          .join(", "),
                },
              ]}
            />
            <p className="sm-hint">
              Creates as a draft — publishing is a separate step on the package page.
            </p>
          </>
        ) : null}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Packages list (per product — no global list endpoint exists)        */
/* ------------------------------------------------------------------ */
const STATUS_FILTERS = ["all", "draft", "active", "archived"] as const;

export function PackagesSection() {
  const { raw, list } = useRouteSearch();
  const updateSearch = useSearchUpdater();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  const productsQuery = useAdminList<ProductListItem>(
    "products",
    "/api/v1/admin/products",
  );
  const products = productsQuery.data ?? [];

  const productParam =
    typeof raw.product === "string" && raw.product.length > 0
      ? raw.product
      : undefined;

  // Explicit product-first: no silent default. Landing here without a
  // product in the URL shows the picker below; a product=… that names
  // nothing is treated the same way.
  const productId = productParam;
  const selectedProduct = products.find((p) => p.id === productId);

  const packagesQuery = useQuery({
    queryKey: ["admin", "packages", "list", productId ?? "none"],
    queryFn: async () => {
      const res = await apiRequest<{ items: PackageDto[] }>(
        `/api/v1/admin/products/${productId}/packages`,
      );
      return res.items;
    },
    enabled: Boolean(productId),
  });

  const statusFilter =
    typeof raw.status === "string" &&
    (STATUS_FILTERS as readonly string[]).includes(raw.status)
      ? raw.status
      : "all";
  const search = list.q ?? "";
  const rows = (packagesQuery.data ?? []).filter((p) =>
    statusFilter === "all" ? true : p.status === statusFilter,
  );

  const columns: ColumnDef<PackageDto, unknown>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <a href={`/packages/${row.original.id}`}>{row.original.name}</a>
      ),
    },
    {
      accessorKey: "package_key",
      header: "Key",
      cell: ({ row }) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span className="sm-mono">{row.original.package_key}</span>
          <CopyButton
            value={row.original.package_key}
            label={`Copy key ${row.original.package_key}`}
          />
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "current_version_id",
      header: "Current version",
      cell: ({ row }) => {
        const current = row.original.versions.find(
          (v) => v.id === row.original.current_version_id,
        );
        return current ? `v${current.version_number}` : "—";
      },
    },
    {
      accessorKey: "versions",
      header: "Versions",
      cell: ({ row }) => (
        <span className="sm-tabular">{row.original.versions.length}</span>
      ),
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateCell value={row.original.created_at} />,
    },
  ];

  return (
    <section aria-labelledby="packages-heading">
      <PageHeader
        breadcrumb={[{ label: "Packages & Pricing" }]}
        title="Packages & Pricing"
        help={
          selectedProduct
            ? `Packages of ${selectedProduct.name}`
            : "Packages live under a product — pick one"
        }
        action={
          selectedProduct ? (
            <Button variant="accent" icon={Plus} onClick={() => setCreateOpen(true)}>
              Create package
            </Button>
          ) : undefined
        }
      />
      {productsQuery.isPending ? (
        <div className="sm-table-wrap sm-table-wrap-pad">
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
            icon={Tags}
            title="No products yet"
            body="Create a product first — packages belong to a product."
            actionLabel="Go to products"
            onAction={() => {
              void navigate({ to: "/products" } as never);
            }}
          />
        </div>
      ) : !selectedProduct ? (
        <Card title="Choose a product">
          <p className="sm-hint">
            Packages live under a product — pick one to see its packages.
          </p>
          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Code</th>
                  <th>Features</th>
                  <th>Packages</th>
                  <th>Select</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>
                      <span className="sm-mono">{p.code}</span>
                    </td>
                    <td>
                      <span className="sm-tabular">{p.features_count}</span>
                    </td>
                    <td>
                      <span className="sm-tabular">{p.packages_count}</span>
                    </td>
                    <td>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => updateSearch({ product: p.id, page: 1 })}
                      >
                        Select
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
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
          isLoading={packagesQuery.isPending}
          isError={packagesQuery.isError}
          error={packagesQuery.error}
          onRetry={() => void packagesQuery.refetch()}
          emptyIcon={Tags}
          emptyTitle="No packages yet"
          emptyBody="Create the first package for this product."
          emptyActionLabel="Create package"
          onEmptyAction={() => setCreateOpen(true)}
          getRowId={(row) => row.id}
          toolbar={
            <>
              <Select
                value={productId ?? ""}
                aria-label="Product"
                style={{ width: "auto", minWidth: 200 }}
                onChange={(e) => updateSearch({ product: e.target.value, page: 1 })}
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
      {selectedProduct ? (
        <CreatePackageDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          productId={selectedProduct.id}
          products={products}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Price create / edit (CreatePackagePriceSchema / UpdatePackagePrice)  */
/* Amounts are entered in major units (e.g. BDT) and sent as minor.    */
/* ------------------------------------------------------------------ */
const PRICE_KEY_RE = /^[a-z0-9_-]+$/;

function CreatePriceDialog({
  open,
  onClose,
  version,
  packageId,
  productId,
}: {
  open: boolean;
  onClose: () => void;
  version: PackageVersionDto;
  packageId: string;
  productId: string;
}) {
  const [priceKey, setPriceKey] = useState("");
  const [priceKind, setPriceKind] = useState<PackagePriceDto["price_kind"]>("one_time");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const [intervalUnit, setIntervalUnit] = useState("month");
  const [intervalCount, setIntervalCount] = useState("1");
  const [trialDays, setTrialDays] = useState("0");
  const [setupFee, setSetupFee] = useState("0");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const create = useAdminMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<PackagePriceDto>(
        `/api/v1/admin/package-versions/${version.id}/prices`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    invalidateKeys: [
      detailKey("packages", packageId),
      ["admin", "packages", "list", productId],
    ],
    successTitle: "Price created",
    onSuccess: () => onClose(),
  });

  function submitForm() {
    setSubmitError(null);
    const next: Record<string, string> = {};
    const key = priceKey.trim().toLowerCase();
    if (key.length < 2 || key.length > 100 || !PRICE_KEY_RE.test(key)) {
      next.priceKey = "2–100 chars, lowercase letters, digits, hyphens or underscores.";
    }
    if (currency.trim().length !== 3) next.currency = "3-letter code, e.g. BDT.";
    const amountMinor = toMinor(priceKind === "free" ? "0" : amount);
    if (amountMinor.error) next.amount = amountMinor.error;
    const setupMinor = toMinor(priceKind === "free" ? "0" : setupFee);
    if (setupMinor.error) next.setupFee = setupMinor.error;
    const trial = Number(trialDays);
    if (!Number.isInteger(trial) || trial < 0) {
      next.trialDays = "Whole number, 0 or more.";
    }
    if (priceKind === "free") {
      if (amountMinor.minor !== 0 || setupMinor.minor !== 0) {
        next.amount = "A free price must stay at zero amount.";
      }
    }
    let intervalUnitValue: string | null = null;
    let intervalCountValue: number | null = null;
    if (priceKind === "recurring") {
      const count = Number(intervalCount);
      if (!Number.isInteger(count) || count <= 0) {
        next.intervalCount = "Whole number greater than 0.";
      } else {
        intervalUnitValue = intervalUnit;
        intervalCountValue = count;
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body: Record<string, unknown> = {
      price_key: key,
      price_kind: priceKind,
      amount_minor: amountMinor.minor,
      currency_code: currency.trim().toUpperCase(),
      trial_days: trial,
      setup_fee_minor: setupMinor.minor,
    };
    if (intervalUnitValue) body.interval_unit = intervalUnitValue;
    if (intervalCountValue) body.interval_count = intervalCountValue;
    create.mutate(body, {
      onError: (err) => setSubmitError(apiErrorMessage(err)),
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Add price — v${version.version_number}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" loading={create.isPending} onClick={submitForm}>
            Create price
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
          <Field label="Price key" required {...(errors.priceKey ? { error: errors.priceKey } : {})} htmlFor="pr-key">
            <Input
              id="pr-key"
              value={priceKey}
              aria-invalid={errors.priceKey ? true : undefined}
              onChange={(e) => setPriceKey(e.target.value.toLowerCase())}
              placeholder="monthly"
            />
          </Field>
          <Field label="Price kind" required htmlFor="pr-kind">
            <Select
              id="pr-kind"
              value={priceKind}
              onChange={(e) =>
                setPriceKind(e.target.value as PackagePriceDto["price_kind"])
              }
            >
              {PRICE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {sentenceCase(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={`Amount (${currency.trim().toUpperCase() || "BDT"})`}
            required
            {...(errors.amount ? { error: errors.amount } : {})}
            htmlFor="pr-amount"
          >
            <Input
              id="pr-amount"
              type="number"
              min={0}
              step="0.01"
              disabled={priceKind === "free"}
              value={priceKind === "free" ? "0" : amount}
              aria-invalid={errors.amount ? true : undefined}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field label="Currency" required {...(errors.currency ? { error: errors.currency } : {})} htmlFor="pr-currency">
            <Input
              id="pr-currency"
              value={currency}
              aria-invalid={errors.currency ? true : undefined}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              placeholder="BDT"
            />
          </Field>
          {priceKind === "recurring" ? (
            <>
              <Field label="Interval unit" required htmlFor="pr-interval-unit">
                <Select
                  id="pr-interval-unit"
                  value={intervalUnit}
                  onChange={(e) => setIntervalUnit(e.target.value)}
                >
                  {INTERVAL_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {sentenceCase(u)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Interval count"
                required
                {...(errors.intervalCount ? { error: errors.intervalCount } : {})}
                htmlFor="pr-interval-count"
              >
                <Input
                  id="pr-interval-count"
                  type="number"
                  min={1}
                  value={intervalCount}
                  aria-invalid={errors.intervalCount ? true : undefined}
                  onChange={(e) => setIntervalCount(e.target.value)}
                />
              </Field>
            </>
          ) : null}
          <Field label="Trial days" {...(errors.trialDays ? { error: errors.trialDays } : {})} htmlFor="pr-trial">
            <Input
              id="pr-trial"
              type="number"
              min={0}
              value={trialDays}
              aria-invalid={errors.trialDays ? true : undefined}
              onChange={(e) => setTrialDays(e.target.value)}
            />
          </Field>
          <Field label="Setup fee" {...(errors.setupFee ? { error: errors.setupFee } : {})} htmlFor="pr-setup">
            <Input
              id="pr-setup"
              type="number"
              min={0}
              step="0.01"
              disabled={priceKind === "free"}
              value={priceKind === "free" ? "0" : setupFee}
              aria-invalid={errors.setupFee ? true : undefined}
              onChange={(e) => setSetupFee(e.target.value)}
              placeholder="0.00"
            />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

function EditPriceDialog({
  open,
  onClose,
  price,
  packageId,
  productId,
}: {
  open: boolean;
  onClose: () => void;
  price: PackagePriceDto;
  packageId: string;
  productId: string;
}) {
  const [amount, setAmount] = useState(String(price.amount_minor / 100));
  const [currency, setCurrency] = useState(price.currency_code);
  const [intervalUnit, setIntervalUnit] = useState<string>(
    price.interval_unit ?? "month",
  );
  const [intervalCount, setIntervalCount] = useState(
    price.interval_count === null ? "" : String(price.interval_count),
  );
  const [trialDays, setTrialDays] = useState(String(price.trial_days));
  const [setupFee, setSetupFee] = useState(String(price.setup_fee_minor / 100));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const save = useAdminMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<PackagePriceDto>(`/api/v1/admin/prices/${price.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [
      detailKey("packages", packageId),
      ["admin", "packages", "list", productId],
    ],
    successTitle: "Price updated",
    onSuccess: () => onClose(),
  });

  function submitForm() {
    setSubmitError(null);
    const next: Record<string, string> = {};
    if (currency.trim().length !== 3) next.currency = "3-letter code, e.g. BDT.";
    const amountMinor = toMinor(amount);
    if (amountMinor.error) next.amount = amountMinor.error;
    const setupMinor = toMinor(setupFee);
    if (setupMinor.error) next.setupFee = setupMinor.error;
    const trial = Number(trialDays);
    if (!Number.isInteger(trial) || trial < 0) {
      next.trialDays = "Whole number, 0 or more.";
    }
    if (price.price_kind === "free" && (amountMinor.minor !== 0 || setupMinor.minor !== 0)) {
      next.amount = "A free price must stay at zero amount.";
    }
    let intervalUnitValue: string | null = null;
    let intervalCountValue: number | null = null;
    if (price.price_kind === "recurring") {
      const count = Number(intervalCount);
      if (!Number.isInteger(count) || count <= 0) {
        next.intervalCount = "Whole number greater than 0.";
      } else {
        intervalUnitValue = intervalUnit;
        intervalCountValue = count;
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body: Record<string, unknown> = {
      amount_minor: amountMinor.minor,
      currency_code: currency.trim().toUpperCase(),
      trial_days: trial,
      setup_fee_minor: setupMinor.minor,
    };
    if (price.price_kind === "recurring") {
      body.interval_unit = intervalUnitValue;
      body.interval_count = intervalCountValue;
    }
    save.mutate(body, {
      onError: (err) => setSubmitError(apiErrorMessage(err)),
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Edit price ${price.price_key}`}
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
      <p className="sm-hint">
        Kind ({sentenceCase(price.price_kind)}) cannot be changed. A price used in
        orders cannot be edited at all — create a replacement price instead.
      </p>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submitForm();
        }}
      >
        <div className="sm-form-grid">
          <Field label="Amount" required {...(errors.amount ? { error: errors.amount } : {})} htmlFor="ep-amount">
            <Input
              id="ep-amount"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              aria-invalid={errors.amount ? true : undefined}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Currency" required {...(errors.currency ? { error: errors.currency } : {})} htmlFor="ep-currency">
            <Input
              id="ep-currency"
              value={currency}
              aria-invalid={errors.currency ? true : undefined}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </Field>
          {price.price_kind === "recurring" ? (
            <>
              <Field label="Interval unit" required htmlFor="ep-interval-unit">
                <Select
                  id="ep-interval-unit"
                  value={intervalUnit}
                  onChange={(e) => setIntervalUnit(e.target.value)}
                >
                  {INTERVAL_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {sentenceCase(u)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Interval count"
                required
                {...(errors.intervalCount ? { error: errors.intervalCount } : {})}
                htmlFor="ep-interval-count"
              >
                <Input
                  id="ep-interval-count"
                  type="number"
                  min={1}
                  value={intervalCount}
                  aria-invalid={errors.intervalCount ? true : undefined}
                  onChange={(e) => setIntervalCount(e.target.value)}
                />
              </Field>
            </>
          ) : null}
          <Field label="Trial days" {...(errors.trialDays ? { error: errors.trialDays } : {})} htmlFor="ep-trial">
            <Input
              id="ep-trial"
              type="number"
              min={0}
              value={trialDays}
              aria-invalid={errors.trialDays ? true : undefined}
              onChange={(e) => setTrialDays(e.target.value)}
            />
          </Field>
          <Field label="Setup fee" {...(errors.setupFee ? { error: errors.setupFee } : {})} htmlFor="ep-setup">
            <Input
              id="ep-setup"
              type="number"
              min={0}
              step="0.01"
              value={setupFee}
              aria-invalid={errors.setupFee ? true : undefined}
              onChange={(e) => setSetupFee(e.target.value)}
            />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* New package version                                                 */
/* ------------------------------------------------------------------ */
function NewVersionDialog({
  open,
  onClose,
  pkg,
}: {
  open: boolean;
  onClose: () => void;
  pkg: PackageDto;
}) {
  const [changeSummary, setChangeSummary] = useState("");
  const [drafts, setDrafts] = useState<Record<string, GrantDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const featuresQuery = useQuery({
    queryKey: ["admin", "features", "list", pkg.product_id],
    queryFn: async () => {
      const res = await apiRequest<{ items: FeatureDto[] }>(
        `/api/v1/admin/products/${pkg.product_id}/features`,
      );
      return res.items;
    },
    enabled: open,
  });
  const features = (featuresQuery.data ?? []).filter(
    (f) => f.status === "active",
  );

  const create = useAdminMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<PackageVersionDto>(`/api/v1/admin/packages/${pkg.id}/versions`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [
      detailKey("packages", pkg.id),
      ["admin", "packages", "list", pkg.product_id],
    ],
    successTitle: "New version created",
    onSuccess: () => onClose(),
  });

  function submitForm() {
    setSubmitError(null);
    const next: Record<string, string> = {};
    const grants: { product_feature_id: string; entitlement_value: unknown }[] = [];
    for (const f of features) {
      const draft = drafts[f.id];
      if (!draft?.included) continue;
      const composed = composeGrant(f, draft);
      if (composed.error) {
        next.grants = composed.error;
        break;
      }
      grants.push(composed.grant);
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body: Record<string, unknown> = { features: grants };
    if (changeSummary.trim()) body.change_summary = changeSummary.trim();
    create.mutate(body, {
      onError: (err) => setSubmitError(apiErrorMessage(err)),
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New version"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" loading={create.isPending} onClick={submitForm}>
            Create version
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
        <Field label="Change summary" htmlFor="nv-summary">
          <Input
            id="nv-summary"
            value={changeSummary}
            onChange={(e) => setChangeSummary(e.target.value)}
            placeholder="What changed in this version"
          />
        </Field>
        <div style={{ marginTop: 16 }}>
          <div className="sm-label" style={{ marginBottom: 8 }}>
            Features in this version
          </div>
          {featuresQuery.isPending ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ height: 20, width: "60%" }} className="sm-skeleton" />
              <div style={{ height: 20, width: "45%" }} className="sm-skeleton" />
            </div>
          ) : (
            <FeatureGrantsEditor
              features={features}
              drafts={drafts}
              onChange={setDrafts}
              {...(errors.grants ? { error: errors.grants } : {})}
            />
          )}
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Edit package (name / description only — UpdateProductPackageSchema)  */
/* ------------------------------------------------------------------ */
function EditPackageDialog({
  open,
  onClose,
  pkg,
}: {
  open: boolean;
  onClose: () => void;
  pkg: PackageDto;
}) {
  const [name, setName] = useState(pkg.name);
  const [description, setDescription] = useState(pkg.description ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const save = useAdminMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<PackageDto>(`/api/v1/admin/packages/${pkg.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [
      detailKey("packages", pkg.id),
      ["admin", "packages", "list", pkg.product_id],
    ],
    successTitle: "Package updated",
    onSuccess: () => onClose(),
  });

  function submitForm() {
    setSubmitError(null);
    const next: Record<string, string> = {};
    if (name.trim().length < 2 || name.trim().length > 160) {
      next.name = "Name is required (2–160 chars).";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate(
      {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
      },
      { onError: (err) => setSubmitError(apiErrorMessage(err)) },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit package"
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
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submitForm();
        }}
      >
        <div className="sm-form-grid">
          <Field label="Name" required {...(errors.name ? { error: errors.name } : {})} htmlFor="ek-name">
            <Input
              id="ek-name"
              value={name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Field label="Description" htmlFor="ek-description">
            <Textarea
              id="ek-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <p className="sm-hint" style={{ marginTop: 16 }}>
          Package key cannot be changed. Prices and features change through new
          versions, never by editing a published version.
        </p>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Package detail                                                      */
/* ------------------------------------------------------------------ */
export function PackageDetailSection({ id }: { id: string }) {
  const confirm = useConfirm();
  const [tab, setTab] = useState("versions");
  const [editOpen, setEditOpen] = useState(false);
  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [priceVersion, setPriceVersion] = useState<PackageVersionDto | null>(null);
  const [editPrice, setEditPrice] = useState<PackagePriceDto | null>(null);

  const query = useAdminDetail<PackageDto>("packages", id, `/api/v1/admin/packages/${id}`);

  const publishVersion = useAdminMutation({
    mutationFn: (versionId: string) =>
      apiRequest<PackageVersionDto>(
        `/api/v1/admin/package-versions/${versionId}/publish`,
        { method: "POST" },
      ),
    invalidateKeys: [detailKey("packages", id)],
    successTitle: "Version published",
  });

  const retireVersion = useAdminMutation({
    mutationFn: (versionId: string) =>
      apiRequest<PackageVersionDto>(
        `/api/v1/admin/package-versions/${versionId}/retire`,
        { method: "POST" },
      ),
    invalidateKeys: [detailKey("packages", id)],
    successTitle: "Version retired",
  });

  const disablePrice = useAdminMutation({
    mutationFn: (priceId: string) =>
      apiRequest<PackagePriceDto>(`/api/v1/admin/prices/${priceId}/disable`, {
        method: "POST",
      }),
    invalidateKeys: [detailKey("packages", id)],
    successTitle: "Price disabled",
  });

  if (query.isPending) {
    return (
      <section aria-labelledby="package-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Packages & Pricing", href: "/packages" }, { label: "…" }]}
          title="Package"
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
      <section aria-labelledby="package-detail-heading">
        <PageHeader
          breadcrumb={[{ label: "Packages & Pricing", href: "/packages" }, { label: "Package" }]}
          title="Package"
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

  const pkg = query.data;
  const versions = [...pkg.versions].sort(
    (a, b) => b.version_number - a.version_number,
  );
  const currentVersion = pkg.versions.find((v) => v.id === pkg.current_version_id);
  const allPrices = versions.flatMap((v) =>
    (v.prices ?? []).map((p) => ({ ...p, version_number: v.version_number })),
  );

  async function onRetire(version: PackageVersionDto) {
    const ok = await confirm({
      title: `Retire version ${version.version_number}?`,
      body: (
        <div>
          <p style={{ marginTop: 0 }}>
            Version {version.version_number} stops being purchasable.
          </p>
          <p style={{ marginBottom: 0 }}>
            {currentVersion?.id === version.id
              ? "It is the current version, so the package returns to Draft until another version is published."
              : "The package keeps its current version."}{" "}
            A retired version can never be republished.
          </p>
        </div>
      ),
      confirmLabel: "Retire",
      danger: true,
    });
    if (ok) retireVersion.mutate(version.id);
  }

  async function onDisablePrice(price: PackagePriceDto) {
    const ok = await confirm({
      title: `Disable price ${price.price_key}?`,
      body: (
        <div>
          <p style={{ marginTop: 0 }}>
            This price stops being offered to new customers.
          </p>
          <p style={{ marginBottom: 0 }}>
            Existing orders and subscriptions using it are not affected.
          </p>
        </div>
      ),
      confirmLabel: "Disable",
      danger: true,
    });
    if (ok) disablePrice.mutate(price.id);
  }

  return (
    <section aria-labelledby="package-detail-heading">
      <PageHeader
        breadcrumb={[
          { label: "Packages & Pricing", href: "/packages" },
          { label: pkg.name },
        ]}
        title={pkg.name}
        {...(pkg.description ? { subtitle: pkg.description } : {})}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <Button
              variant="accent"
              icon={Plus}
              onClick={() => setNewVersionOpen(true)}
            >
              New version
            </Button>
          </div>
        }
      />
      <DetailLayout
        title="Package"
        facts={[
          {
            label: "Key",
            value: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span className="sm-mono">{pkg.package_key}</span>
                <CopyButton value={pkg.package_key} label="Copy package key" />
              </span>
            ),
          },
          {
            label: "Product",
            value: <a href={`/products/${pkg.product_id}`}>View product</a>,
          },
          {
            label: "Status",
            value: <StatusBadge status={pkg.status} />,
          },
          {
            label: "Current version",
            value: currentVersion ? `v${currentVersion.version_number}` : "—",
          },
          {
            label: "Versions",
            value: <span className="sm-tabular">{pkg.versions.length}</span>,
          },
          { label: "Created", value: <DateCell value={pkg.created_at} /> },
          { label: "Updated", value: <DateCell value={pkg.updated_at} /> },
        ]}
      >

        <Tabs
          tabs={[
            { key: "versions", label: `Versions (${versions.length})` },
            { key: "prices", label: `Prices (${allPrices.length})` },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "versions" ? (
          <Card title="Versions">
            {versions.length === 0 ? (
              <p className="sm-hint">No versions yet.</p>
            ) : (
              <div className="sm-table-wrap">
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Status</th>
                      <th>Change summary</th>
                      <th>Features</th>
                      <th>Prices</th>
                      <th>Published</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.id}>
                        <td>
                          <span className="sm-tabular">v{v.version_number}</span>
                        </td>
                        <td>
                          <StatusBadge status={v.status} />
                        </td>
                        <td>{v.change_summary ?? "—"}</td>
                        <td>
                          <span className="sm-tabular">{v.features.length}</span>
                        </td>
                        <td>
                          <span className="sm-tabular">{(v.prices ?? []).length}</span>
                        </td>
                        <td>
                          <DateCell value={v.published_at} />
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setPriceVersion(v)}
                            >
                              Add price
                            </Button>
                            {v.status === "draft" ? (
                              <Button
                                variant="accent"
                                size="sm"
                                loading={publishVersion.isPending}
                                onClick={() => publishVersion.mutate(v.id)}
                              >
                                Publish
                              </Button>
                            ) : null}
                            {v.status === "published" ? (
                              <Button
                                variant="danger-ghost"
                                size="sm"
                                loading={retireVersion.isPending}
                                onClick={() => void onRetire(v)}
                              >
                                Retire
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {versions.length > 0 ? (
              <div style={{ marginTop: 24 }}>
                <h3 className="sm-card-title" style={{ marginBottom: 12 }}>
                  Features in the current version
                </h3>
                {(() => {
                  const shown =
                    currentVersion ?? versions[0];
                  if (!shown || shown.features.length === 0) {
                    return <p className="sm-hint">No feature grants on this version.</p>;
                  }
                  return (
                    <div className="sm-table-wrap">
                      <table className="sm-table">
                        <thead>
                          <tr>
                            <th>Feature</th>
                            <th>Value type</th>
                            <th>Entitlement</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.features.map((g) => (
                            <tr key={g.id}>
                              <td>
                                <span className="sm-mono">{g.feature_key_snapshot}</span>
                              </td>
                              <td>{g.value_type_snapshot}</td>
                              <td>{formatEntitlement(g.entitlement_value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </div>
            ) : null}
          </Card>
        ) : (
          <Card title="Prices">
            {allPrices.length === 0 ? (
              <p className="sm-hint">
                No prices yet. Add a price to a version from the Versions tab.
              </p>
            ) : (
              <div className="sm-table-wrap">
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Version</th>
                      <th>Kind</th>
                      <th>Amount</th>
                      <th>Interval</th>
                      <th>Trial</th>
                      <th>Setup fee</th>
                      <th>Status</th>
                      <th>Used in orders</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allPrices.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <span className="sm-mono">{p.price_key}</span>
                        </td>
                        <td>
                          <span className="sm-tabular">v{p.version_number}</span>
                        </td>
                        <td>{sentenceCase(p.price_kind)}</td>
                        <td>
                          <MoneyCell currency={p.currency_code} minor={p.amount_minor} />
                        </td>
                        <td>{formatInterval(p)}</td>
                        <td>
                          <span className="sm-tabular">
                            {p.trial_days > 0 ? `${p.trial_days} days` : "—"}
                          </span>
                        </td>
                        <td>
                          <MoneyCell
                            currency={p.currency_code}
                            minor={p.setup_fee_minor}
                          />
                        </td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td>{p.used_in_orders ? "Yes" : "No"}</td>
                        <td>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={p.used_in_orders}
                              title={
                                p.used_in_orders
                                  ? "Used in orders — create a replacement price instead"
                                  : "Edit price"
                              }
                              onClick={() => setEditPrice(p)}
                            >
                              Edit
                            </Button>
                            {p.status === "active" ? (
                              <Button
                                variant="danger-ghost"
                                size="sm"
                                loading={disablePrice.isPending}
                                onClick={() => void onDisablePrice(p)}
                              >
                                Disable
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        <EditPackageDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          pkg={pkg}
        />
        <NewVersionDialog
          open={newVersionOpen}
          onClose={() => setNewVersionOpen(false)}
          pkg={pkg}
        />
        {priceVersion ? (
          <CreatePriceDialog
            open
            onClose={() => setPriceVersion(null)}
            version={priceVersion}
            packageId={pkg.id}
            productId={pkg.product_id}
          />
        ) : null}
        {editPrice ? (
          <EditPriceDialog
            open
            onClose={() => setEditPrice(null)}
            price={editPrice}
            packageId={pkg.id}
            productId={pkg.product_id}
          />
        ) : null}
      </DetailLayout>
    </section>
  );
}
