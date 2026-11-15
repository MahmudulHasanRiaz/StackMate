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
import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ListChecks, Plus } from "lucide-react";
import { FEATURE_VALUE_TYPES } from "../../../../packages/contracts/src/index.ts";
import { ApiClientError, apiRequest } from "../lib/api-client";
import { detailKey, queryClient } from "../lib/query";
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
  Tabs,
  Textarea,
  useConfirm,
  useToast,
} from "../components/primitives";
import type { ProductListItem } from "./products";

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */
/** One package that references a feature, at the highest version that does. */
export interface FeatureUsage {
  package_id: string;
  package_key: string;
  package_name: string;
  version_number: number;
  version_status: "draft" | "published" | "retired";
}

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
  /** Real package associations, computed server-side from version grants. */
  used_by_packages?: FeatureUsage[];
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
/* Create feature form (CreateProductFeatureSchema) — single + bulk    */
/* ------------------------------------------------------------------ */

interface BulkRowState {
  localId: number;
  featureKey: string;
  name: string;
  description: string;
  valueType: FeatureValueType;
  unit: string;
  entitlement: EntitlementDraft;
  errors: Record<string, string>;
  serverError: string | null;
}

interface BulkCreateResponse {
  created: FeatureDto[];
  errors: Array<{ index: number; feature_key: string | null; error: string }>;
}

function emptyBulkRow(localId: number): BulkRowState {
  return {
    localId,
    featureKey: "",
    name: "",
    description: "",
    valueType: "boolean",
    unit: "",
    entitlement: emptyEntitlementDraft("boolean"),
    errors: {},
    serverError: null,
  };
}

function CreateFeatureDialog({
  open,
  onClose,
  productId,
  productName,
}: {
  open: boolean;
  onClose: () => void;
  productId: string;
  productName: string;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [bulkRows, setBulkRows] = useState<BulkRowState[]>(() => [
    emptyBulkRow(1),
    emptyBulkRow(2),
  ]);
  const [nextRowId, setNextRowId] = useState(3);
  const [bulkSummary, setBulkSummary] = useState<string | null>(null);
  const submittedOrderRef = useRef<number[]>([]);
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

  function validateBulkRow(row: BulkRowState): Record<string, string> {
    const next: Record<string, string> = {};
    const key = row.featureKey.trim().toLowerCase();
    if (key.length < 2 || key.length > 120 || !FEATURE_KEY_RE.test(key)) {
      next.featureKey =
        "snake_case, starts with a letter, e.g. b1_extra (no hyphens).";
    }
    if (row.name.trim().length < 2 || row.name.trim().length > 160) {
      next.name = "Name is required (2–160 chars).";
    }
    const composed = composeEntitlement(row.valueType, row.entitlement);
    if (composed.error) next.entitlement = composed.error;
    return next;
  }

  /**
   * Bulk create with per-row results. Partial success drops the rows
   * that landed and keeps the failed rows with their server error
   * attached — nothing is ever silent. An all-failed bulk arrives as
   * a 422 whose per-row errors live in error.details.errors.
   */
  const bulkCreate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<BulkCreateResponse>(
        `/api/v1/admin/products/${productId}/features/bulk`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ["admin", "features", "list", productId],
      });
      void queryClient.invalidateQueries({ queryKey: detailKey("products", productId) });
      if (result.errors.length === 0) {
        toast({
          title: `${result.created.length} feature${result.created.length === 1 ? "" : "s"} created`,
          variant: "success",
        });
        onClose();
        return;
      }
      const createdKeys = new Set(result.created.map((f) => f.feature_key));
      setBulkRows((rows) =>
        rows
          .filter((r) => !createdKeys.has(r.featureKey.trim().toLowerCase()))
          .map((row) => {
            const submittedIdx = submittedOrderRef.current.indexOf(row.localId);
            const hit = result.errors.find((e) => e.index === submittedIdx);
            return { ...row, serverError: hit ? hit.error : null };
          }),
      );
      setBulkSummary(
        `${result.created.length} created, ${result.errors.length} failed — the failed rows are still below; fix them and retry.`,
      );
    },
    onError: (err) => attachBulkServerErrors(err),
  });

  function attachBulkServerErrors(err: unknown) {
    const details =
      err instanceof ApiClientError
        ? (err.details as {
            errors?: Array<{ index: number; feature_key: string | null; error: string }>;
          } | null)
        : null;
    const serverErrors = details?.errors;
    if (!serverErrors || serverErrors.length === 0) {
      setSubmitError(apiErrorMessage(err));
      return;
    }
    setBulkRows((rows) =>
      rows.map((row) => {
        const submittedIdx = submittedOrderRef.current.indexOf(row.localId);
        const hit = serverErrors.find((e) => e.index === submittedIdx);
        return hit ? { ...row, serverError: hit.error } : row;
      }),
    );
    setBulkSummary(
      `${serverErrors.length} row(s) failed — fix them below and retry. Nothing was created.`,
    );
  }

  function submitBulk() {
    setBulkSummary(null);
    setSubmitError(null);
    let hasErrors = false;
    const validated = bulkRows.map((row) => {
      const errors = validateBulkRow(row);
      if (Object.keys(errors).length > 0) hasErrors = true;
      return { ...row, errors, serverError: null };
    });
    setBulkRows(validated);
    if (hasErrors) return;
    const features = validated.map((row) => {
      const composed = composeEntitlement(row.valueType, row.entitlement);
      const body: Record<string, unknown> = {
        feature_key: row.featureKey.trim().toLowerCase(),
        name: row.name.trim(),
        value_type: row.valueType,
        default_value: composed.value,
      };
      if (row.description.trim()) body.description = row.description.trim();
      if (row.unit.trim()) body.unit = row.unit.trim();
      return body;
    });
    submittedOrderRef.current = validated.map((r) => r.localId);
    bulkCreate.mutate({ features });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Create feature — ${productName}`}
      size={mode === "bulk" ? "md" : "sm"}
      footer={
        mode === "single" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={submitForm}>
              Create feature
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={bulkCreate.isPending}
              onClick={submitBulk}
            >
              {`Create ${bulkRows.length} feature${bulkRows.length === 1 ? "" : "s"}`}
            </Button>
          </>
        )
      }
    >
      {submitError ? (
        <Alert variant="danger" role="alert">
          {submitError}
        </Alert>
      ) : null}
      <Tabs
        tabs={[
          { key: "single", label: "One feature" },
          { key: "bulk", label: "Several at once" },
        ]}
        active={mode}
        onChange={(key) => setMode(key as "single" | "bulk")}
      />
      {bulkSummary ? (
        <Alert variant="warning" role="status">
          {bulkSummary}
        </Alert>
      ) : null}
      <Field label="Product" htmlFor="cf-product">
        <Input id="cf-product" value={productName} disabled />
      </Field>
      {mode === "single" ? (
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
      ) : (
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submitBulk();
        }}
      >
        {bulkRows.map((row, i) => (
          <Card
            key={row.localId}
            title={`Feature ${i + 1}`}
            actions={
              bulkRows.length > 1 ? (
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={() =>
                    setBulkRows((rows) =>
                      rows.filter((r) => r.localId !== row.localId),
                    )
                  }
                >
                  Remove
                </Button>
              ) : undefined
            }
          >
            <div className="sm-form-grid">
              <Field
                label="Feature key"
                required
                {...(row.errors.featureKey ? { error: row.errors.featureKey } : {})}
                htmlFor={`bf-key-${row.localId}`}
              >
                <Input
                  id={`bf-key-${row.localId}`}
                  value={row.featureKey}
                  aria-invalid={row.errors.featureKey ? true : undefined}
                  onChange={(e) =>
                    setBulkRows((rows) =>
                      rows.map((r) =>
                        r.localId === row.localId
                          ? { ...r, featureKey: e.target.value.toLowerCase() }
                          : r,
                      ),
                    )
                  }
                  placeholder="b1_extra"
                />
              </Field>
              <Field
                label="Name"
                required
                {...(row.errors.name ? { error: row.errors.name } : {})}
                htmlFor={`bf-name-${row.localId}`}
              >
                <Input
                  id={`bf-name-${row.localId}`}
                  value={row.name}
                  aria-invalid={row.errors.name ? true : undefined}
                  onChange={(e) =>
                    setBulkRows((rows) =>
                      rows.map((r) =>
                        r.localId === row.localId ? { ...r, name: e.target.value } : r,
                      ),
                    )
                  }
                  placeholder="Feature name"
                />
              </Field>
              <Field label="Value type" required htmlFor={`bf-type-${row.localId}`}>
                <Select
                  id={`bf-type-${row.localId}`}
                  value={row.valueType}
                  onChange={(e) => {
                    const next = e.target.value as FeatureValueType;
                    setBulkRows((rows) =>
                      rows.map((r) =>
                        r.localId === row.localId
                          ? {
                              ...r,
                              valueType: next,
                              entitlement: emptyEntitlementDraft(next),
                            }
                          : r,
                      ),
                    );
                  }}
                >
                  {FEATURE_VALUE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {sentenceCase(t)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Unit" hint="e.g. seats, GB" htmlFor={`bf-unit-${row.localId}`}>
                <Input
                  id={`bf-unit-${row.localId}`}
                  value={row.unit}
                  onChange={(e) =>
                    setBulkRows((rows) =>
                      rows.map((r) =>
                        r.localId === row.localId ? { ...r, unit: e.target.value } : r,
                      ),
                    )
                  }
                  placeholder="seats"
                />
              </Field>
              <Field
                label="Default value"
                hint="Used when a package does not set its own value"
                {...(row.errors.entitlement ? { error: row.errors.entitlement } : {})}
              >
                <EntitlementInputs
                  valueType={row.valueType}
                  draft={row.entitlement}
                  onChange={(next) =>
                    setBulkRows((rows) =>
                      rows.map((r) =>
                        r.localId === row.localId ? { ...r, entitlement: next } : r,
                      ),
                    )
                  }
                  {...(row.errors.entitlement ? { error: row.errors.entitlement } : {})}
                  idPrefix={`bf-default-${row.localId}`}
                />
              </Field>
              <Field label="Description" htmlFor={`bf-description-${row.localId}`}>
                <Input
                  id={`bf-description-${row.localId}`}
                  value={row.description}
                  onChange={(e) =>
                    setBulkRows((rows) =>
                      rows.map((r) =>
                        r.localId === row.localId
                          ? { ...r, description: e.target.value }
                          : r,
                      ),
                    )
                  }
                  placeholder="Optional"
                />
              </Field>
            </div>
            {row.serverError ? (
              <Alert variant="danger" role="alert">
                {row.serverError}
              </Alert>
            ) : null}
          </Card>
        ))}
        <Button
          variant="secondary"
          icon={Plus}
          onClick={() => {
            setBulkRows((rows) => [...rows, emptyBulkRow(nextRowId)]);
            setNextRowId((n) => n + 1);
          }}
        >
          Add another feature
        </Button>
      </form>
      )}
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

  // Explicit product-first: no silent default. Landing here without a
  // product in the URL shows the picker below; a product=… that names
  // nothing is treated the same way.
  const productId = productParam;
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
      accessorKey: "used_by_packages",
      header: "Used by",
      cell: ({ row }) => {
        const used = row.original.used_by_packages ?? [];
        if (used.length === 0) return "Not used in any package";
        return (
          <span>
            {used.map((u, i) => (
              <span key={u.package_id}>
                {i > 0 ? ", " : null}
                <a href={`/packages/${u.package_id}`}>{u.package_name}</a>
                {` v${u.version_number} · ${u.version_status}`}
              </span>
            ))}
          </span>
        );
      },
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
          selectedProduct ? (
            <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
              Create feature
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
            icon={ListChecks}
            title="No products yet"
            body="Create a product first — features belong to a product."
            actionLabel="Go to products"
            onAction={() => {
              void navigate({ to: "/products" } as never);
            }}
          />
        </div>
      ) : !selectedProduct ? (
        <Card title="Choose a product">
          <p className="sm-hint">
            Features live under a product — pick one to see its features.
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
      {selectedProduct ? (
        <CreateFeatureDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          productId={selectedProduct.id}
          productName={selectedProduct.name}
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
          <div className="sm-table-wrap sm-table-wrap-pad">
            <div className="sm-stack-sm">
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
      <Card title={`Used by packages (${(feature.used_by_packages ?? []).length})`}>
        {(feature.used_by_packages ?? []).length === 0 ? (
          <p className="sm-hint">
            Not used in any package yet. Add this feature to a package
            version to grant it to customers.
          </p>
        ) : (
          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Version</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(feature.used_by_packages ?? []).map((u) => (
                  <tr key={u.package_id}>
                    <td>
                      <a href={`/packages/${u.package_id}`}>{u.package_name}</a>
                    </td>
                    <td>
                      <span className="sm-tabular">v{u.version_number}</span>
                    </td>
                    <td>
                      <StatusBadge status={u.version_status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <EditFeatureDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        feature={feature}
      />
    </section>
  );
}
