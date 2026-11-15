/**
 * Payment Methods — list + detail (design spec §4.1/§4.2).
 *
 * Routes (wired by the parent after delivery): /payment-methods and
 * /payment-methods/$methodId. The list search/page state is URL-backed
 * via useRouterState + useNavigate (not useSearch({ from }) — that
 * literal only typechecks once the parent registers the routes; this
 * helper is behaviourally identical and compiles before wiring).
 *
 * Endpoints used (all verified in apps/api/src/app.ts):
 *  - GET  /api/v1/admin/payment-methods            payments.read
 *  - POST /api/v1/admin/payment-methods            payments.methods.manage
 *  - GET  /api/v1/admin/payment-methods/:id        payments.read
 *  - PATCH /api/v1/admin/payment-methods/:id       payments.methods.manage
 *  - POST /api/v1/admin/payment-methods/:id/enable  payments.methods.manage
 *  - POST /api/v1/admin/payment-methods/:id/disable payments.methods.manage
 *  - GET  /api/v1/admin/payment-providers          payments.read
 *  - POST /api/v1/admin/payment-providers          payments.methods.manage
 *  - PATCH /api/v1/admin/payment-providers/:id     payments.methods.manage
 */
import { useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { CreditCard, Pencil, Plus } from "lucide-react";
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
  type ListSearch,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  CopyButton,
  DateCell,
  Dialog,
  Field,
  Input,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  ErrorState,
  useConfirm,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* Types (mirror apps/api/src/platform/db/store.ts + contracts)        */
/* ------------------------------------------------------------------ */
export interface PaymentProvider {
  id: string;
  provider_key: string;
  display_name: string;
  provider_type: "manual_mfs" | "manual_bank" | "automated";
  adapter_key: string;
  status: "enabled" | "disabled";
}

export interface PaymentMethod {
  id: string;
  provider_id: string;
  method_key: string;
  display_name: string;
  method_kind: "mfs_account" | "bank_account" | "automated_checkout";
  account_type: "personal" | "merchant" | "agent" | null;
  account_label: string | null;
  instructions: string | null;
  configuration: {
    account_number: string;
    account_holder_name?: string;
    bank_name?: string;
    branch_name?: string;
    routing_number?: string;
    transaction_id_requirement: "required" | "optional" | "disabled";
  };
  transfer_rails: Array<"npsb" | "beftn" | "rtgs">;
  is_enabled: boolean;
  sort_order: number;
  created_at: string;
}

const KIND_LABELS: Record<PaymentMethod["method_kind"], string> = {
  mfs_account: "MFS account",
  bank_account: "Bank account",
  automated_checkout: "Automated checkout",
};

const PROVIDER_TYPE_LABELS: Record<PaymentProvider["provider_type"], string> = {
  manual_mfs: "Manual MFS",
  manual_bank: "Manual bank",
  automated: "Automated",
};

const RAILS = ["npsb", "beftn", "rtgs"] as const;
type Rail = (typeof RAILS)[number];

/* ------------------------------------------------------------------ */
/* URL-backed list search (see header note)                            */
/* ------------------------------------------------------------------ */
function useListSearch() {
  const search = useRouterState({ select: (s) => s.location.search }) as Record<
    string,
    unknown
  >;
  const navigate = useNavigate();
  const parsed = parseListSearch(search);
  const setSearch = (next: { q?: string | null; page?: number; pageSize?: number }) => {
    const merged: ListSearch = { ...parsed };
    if (next.q === null) delete merged.q;
    else if (next.q !== undefined) merged.q = next.q;
    if (next.page !== undefined) merged.page = next.page;
    if (next.pageSize !== undefined) merged.pageSize = next.pageSize;
    (navigate as unknown as (opts: { search: Record<string, unknown> }) => void)({
      search: {
        ...(merged.q ? { q: merged.q } : {}),
        page: merged.page ?? 1,
        pageSize: merged.pageSize ?? 25,
      },
    });
  };
  return { parsed, setSearch };
}

function useGoDetail(base: string, param: string) {
  const navigate = useNavigate();
  return (id: string) =>
    (navigate as unknown as (opts: { to: string; params: Record<string, string> }) => void)({
      to: `${base}/$${param}`,
      params: { [param]: id },
    });
}

/* ------------------------------------------------------------------ */
/* Payment Methods — list (methods tab + providers tab)                */
/* ------------------------------------------------------------------ */
export function PaymentMethodsSection() {
  const { parsed, setSearch } = useListSearch();
  const goDetail = useGoDetail("/payment-methods", "methodId");
  const [tab, setTab] = useState<"methods" | "providers">("methods");
  const [createMethodOpen, setCreateMethodOpen] = useState(false);
  const [createProviderOpen, setCreateProviderOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [providerPage, setProviderPage] = useState(1);
  const [providerPageSize, setProviderPageSize] = useState(25);

  const methods = useAdminList<PaymentMethod>("payment-methods", "/api/v1/admin/payment-methods");
  const providers = useAdminList<PaymentProvider>(
    "payment-providers",
    "/api/v1/admin/payment-providers",
  );
  const providerById = useMemo(
    () => new Map((providers.data ?? []).map((p) => [p.id, p])),
    [providers.data],
  );

  const columns: ColumnDef<PaymentMethod, unknown>[] = [
    {
      accessorKey: "display_name",
      header: "Method",
      cell: ({ row }) => (
        <span>
          <strong>{row.original.display_name}</strong>
          {row.original.account_label ? (
            <span className="sm-hint"> — {row.original.account_label}</span>
          ) : null}
        </span>
      ),
    },
    {
      accessorKey: "method_key",
      header: "Key",
      cell: ({ row }) => (
        <span className="sm-mono">
          {row.original.method_key} <CopyButton value={row.original.method_key} />
        </span>
      ),
    },
    {
      accessorKey: "method_kind",
      header: "Kind",
      cell: ({ row }) => KIND_LABELS[row.original.method_kind],
    },
    {
      accessorKey: "provider_id",
      header: "Provider",
      cell: ({ row }) => providerById.get(row.original.provider_id)?.display_name ?? "—",
    },
    {
      accessorKey: "configuration.account_number",
      header: "Account",
      cell: ({ row }) => (
        <span className="sm-mono">{row.original.configuration.account_number}</span>
      ),
    },
    {
      accessorKey: "is_enabled",
      header: "Status",
      cell: ({ row }) => (
        <StatusBadge status={row.original.is_enabled ? "enabled" : "disabled"} />
      ),
    },
    {
      accessorKey: "sort_order",
      header: "Sort",
      cell: ({ row }) => <span className="sm-tabular">{row.original.sort_order}</span>,
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateCell value={row.original.created_at} />,
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => (
        <Button variant="secondary" size="sm" onClick={() => goDetail(row.original.id)}>
          View
        </Button>
      ),
    },
  ];

  return (
    <section aria-labelledby="payment-methods-heading">
      <PageHeader
        breadcrumb={[{ label: "Commerce" }, { label: "Payment Methods" }]}
        title="Payment Methods"
        subtitle="Manual MFS / bank accounts and automated checkout methods"
        action={
          tab === "methods" ? (
            <Button variant="primary" icon={Plus} onClick={() => setCreateMethodOpen(true)}>
              Create method
            </Button>
          ) : (
            <Button variant="primary" icon={Plus} onClick={() => setCreateProviderOpen(true)}>
              Create provider
            </Button>
          )
        }
      />
      <Tabs
        tabs={[
          { key: "methods", label: "Methods" },
          { key: "providers", label: "Providers" },
        ]}
        active={tab}
        onChange={(key) => setTab(key as "methods" | "providers")}
      />
      {tab === "methods" ? (
        <ListTable<PaymentMethod>
          columns={columns}
          data={methods.data}
          search={parsed.q ?? ""}
          onSearchChange={(q) => setSearch({ q: q || null, page: 1 })}
          page={parsed.page ?? 1}
          onPageChange={(page) => setSearch({ page })}
          pageSize={parsed.pageSize ?? 25}
          onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
          isLoading={methods.isPending}
          isError={methods.isError}
          error={methods.error}
          onRetry={() => void methods.refetch()}
          emptyIcon={CreditCard}
          emptyTitle="No payment methods yet"
          emptyBody="Create the first method so customers can pay manually or at checkout."
          emptyActionLabel="Create method"
          onEmptyAction={() => setCreateMethodOpen(true)}
          getRowId={(row) => row.id}
        />
      ) : (
        <ProvidersTable
          providers={providers}
          search={providerSearch}
          onSearchChange={setProviderSearch}
          page={providerPage}
          onPageChange={setProviderPage}
          pageSize={providerPageSize}
          onPageSizeChange={setProviderPageSize}
          onCreate={() => setCreateProviderOpen(true)}
        />
      )}
      {createMethodOpen ? (
        <Dialog
          open
          size="md"
          onClose={() => setCreateMethodOpen(false)}
          title="Create payment method"
        >
          <MethodCreateForm
            providers={providers.data ?? []}
            providersLoading={providers.isPending}
            onDone={() => setCreateMethodOpen(false)}
            onCancel={() => setCreateMethodOpen(false)}
          />
        </Dialog>
      ) : null}
      {createProviderOpen ? (
        <Dialog open size="md" onClose={() => setCreateProviderOpen(false)} title="Create provider">
          <ProviderForm onDone={() => setCreateProviderOpen(false)} onCancel={() => setCreateProviderOpen(false)} />
        </Dialog>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Providers table (second list on the same page, own toolbar state)   */
/* ------------------------------------------------------------------ */
function ProvidersTable({
  providers,
  search,
  onSearchChange,
  page,
  onPageChange,
  pageSize,
  onPageSizeChange,
  onCreate,
}: {
  providers: ReturnType<typeof useAdminList<PaymentProvider>>;
  search: string;
  onSearchChange: (q: string) => void;
  page: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  onCreate: () => void;
}) {
  const [editing, setEditing] = useState<PaymentProvider | null>(null);
  const columns: ColumnDef<PaymentProvider, unknown>[] = [
    {
      accessorKey: "display_name",
      header: "Provider",
      cell: ({ row }) => <strong>{row.original.display_name}</strong>,
    },
    {
      accessorKey: "provider_key",
      header: "Key",
      cell: ({ row }) => (
        <span className="sm-mono">
          {row.original.provider_key} <CopyButton value={row.original.provider_key} />
        </span>
      ),
    },
    {
      accessorKey: "provider_type",
      header: "Type",
      cell: ({ row }) => PROVIDER_TYPE_LABELS[row.original.provider_type],
    },
    {
      accessorKey: "adapter_key",
      header: "Adapter",
      cell: ({ row }) => <span className="sm-mono">{row.original.adapter_key}</span>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => (
        <Button variant="secondary" size="sm" icon={Pencil} onClick={() => setEditing(row.original)}>
          Edit
        </Button>
      ),
    },
  ];
  return (
    <>
      <ListTable<PaymentProvider>
        columns={columns}
        data={providers.data}
        search={search}
        onSearchChange={onSearchChange}
        page={page}
        onPageChange={onPageChange}
        pageSize={pageSize}
        onPageSizeChange={onPageSizeChange}
        isLoading={providers.isPending}
        isError={providers.isError}
        error={providers.error}
        onRetry={() => void providers.refetch()}
        emptyIcon={CreditCard}
        emptyTitle="No payment providers yet"
        emptyBody="Create a provider first — every method belongs to one provider."
        emptyActionLabel="Create provider"
        onEmptyAction={onCreate}
        getRowId={(row) => row.id}
      />
      {editing ? (
        <Dialog open size="md" onClose={() => setEditing(null)} title={`Edit ${editing.display_name}`}>
          <ProviderForm
            initial={editing}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Provider create / edit form                                         */
/* ------------------------------------------------------------------ */
function ProviderForm({
  initial,
  onDone,
  onCancel,
}: {
  initial?: PaymentProvider;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [providerKey, setProviderKey] = useState(initial?.provider_key ?? "");
  const [displayName, setDisplayName] = useState(initial?.display_name ?? "");
  const [providerType, setProviderType] = useState<PaymentProvider["provider_type"]>(
    initial?.provider_type ?? "manual_mfs",
  );
  const [adapterKey, setAdapterKey] = useState(initial?.adapter_key ?? "");
  const [status, setStatus] = useState<"enabled" | "disabled">(initial?.status ?? "enabled");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useAdminMutation<PaymentProvider, Record<string, unknown>>({
    mutationFn: (body) =>
      initial
        ? apiRequest<PaymentProvider>(`/api/v1/admin/payment-providers/${initial.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : apiRequest<PaymentProvider>("/api/v1/admin/payment-providers", {
            method: "POST",
            body: JSON.stringify(body),
          }),
    invalidateKeys: [listKey("payment-providers")],
    successTitle: initial ? "Provider updated" : "Provider created",
    onSuccess: onDone,
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (!initial && !/^[a-z0-9_-]{2,100}$/.test(providerKey.trim().toLowerCase()))
      next.provider_key = "Use 2–100 lowercase letters, digits, - or _.";
    if (displayName.trim().length < 2) next.display_name = "Display name needs at least 2 characters.";
    if (adapterKey.trim().length < 2) next.adapter_key = "Adapter key needs at least 2 characters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    mutation.mutate(
      initial
        ? { display_name: displayName.trim(), adapter_key: adapterKey.trim(), status }
        : {
            provider_key: providerKey.trim().toLowerCase(),
            display_name: displayName.trim(),
            provider_type: providerType,
            adapter_key: adapterKey.trim(),
            status,
          },
      {
        onError: (err) => setFormError(err instanceof Error ? err.message : "Request failed"),
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="sm-form-grid">
        {!initial ? (
          <Field label="Provider key" required hint="Lowercase, unique. Never changes." error={errors.provider_key ?? ""}>
            <Input
              id="provider-key"
              value={providerKey}
              onChange={(e) => setProviderKey(e.target.value)}
              aria-invalid={Boolean(errors.provider_key) || undefined}
              placeholder="bkash"
            />
          </Field>
        ) : null}
        <Field label="Display name" required error={errors.display_name ?? ""}>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-invalid={Boolean(errors.display_name) || undefined}
            placeholder="bKash"
          />
        </Field>
        <Field label="Provider type" required>
          <Select
            value={providerType}
            onChange={(e) => setProviderType(e.target.value as PaymentProvider["provider_type"])}
            disabled={Boolean(initial)}
          >
            <option value="manual_mfs">Manual MFS</option>
            <option value="manual_bank">Manual bank</option>
            <option value="automated">Automated</option>
          </Select>
        </Field>
        <Field label="Adapter key" required error={errors.adapter_key ?? ""}>
          <Input
            value={adapterKey}
            onChange={(e) => setAdapterKey(e.target.value)}
            aria-invalid={Boolean(errors.adapter_key) || undefined}
            placeholder="manual-mfs"
          />
        </Field>
        <Field label="Status" required>
          <Select value={status} onChange={(e) => setStatus(e.target.value as "enabled" | "disabled")}>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
      </div>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer" style={{ padding: 0, marginTop: 20 }}>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={mutation.isPending} onClick={submit}>
          {initial ? "Save changes" : "Create provider"}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Method create form                                                  */
/* ------------------------------------------------------------------ */
function MethodCreateForm({
  providers,
  providersLoading,
  onDone,
  onCancel,
}: {
  providers: PaymentProvider[];
  providersLoading: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [providerId, setProviderId] = useState("");
  const [methodKey, setMethodKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [methodKind, setMethodKind] = useState<PaymentMethod["method_kind"]>("mfs_account");
  const [accountType, setAccountType] = useState<"personal" | "merchant" | "agent">("personal");
  const [accountLabel, setAccountLabel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [bankName, setBankName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [routingNumber, setRoutingNumber] = useState("");
  const [txnRequirement, setTxnRequirement] = useState<"required" | "optional" | "disabled">("required");
  const [rails, setRails] = useState<Rail[]>([]);
  const [sortOrder, setSortOrder] = useState("0");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useAdminMutation<PaymentMethod, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<PaymentMethod>("/api/v1/admin/payment-methods", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("payment-methods")],
    successTitle: "Payment method created",
    onSuccess: onDone,
  });

  const toggleRail = (rail: Rail) =>
    setRails((prev) => (prev.includes(rail) ? prev.filter((r) => r !== rail) : [...prev, rail]));

  const submit = () => {
    const next: Record<string, string> = {};
    if (!providerId) next.provider_id = "Choose a provider.";
    if (!/^[a-z0-9_-]{2,100}$/.test(methodKey.trim().toLowerCase()))
      next.method_key = "Use 2–100 lowercase letters, digits, - or _.";
    if (displayName.trim().length < 2) next.display_name = "Display name needs at least 2 characters.";
    if (accountNumber.trim().length < 4) next.account_number = "Account number needs at least 4 characters.";
    if (methodKind === "bank_account" && rails.length === 0)
      next.transfer_rails = "Bank methods need at least one rail.";
    const sort = Number(sortOrder);
    if (!Number.isInteger(sort) || sort < 0 || sort > 10000)
      next.sort_order = "Sort order must be 0–10000.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    mutation.mutate(
      {
        provider_id: providerId,
        method_key: methodKey.trim().toLowerCase(),
        display_name: displayName.trim(),
        method_kind: methodKind,
        ...(methodKind === "mfs_account" ? { account_type: accountType } : {}),
        ...(accountLabel.trim() ? { account_label: accountLabel.trim() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        configuration: {
          account_number: accountNumber.trim(),
          ...(accountHolder.trim() ? { account_holder_name: accountHolder.trim() } : {}),
          ...(bankName.trim() ? { bank_name: bankName.trim() } : {}),
          ...(branchName.trim() ? { branch_name: branchName.trim() } : {}),
          ...(routingNumber.trim() ? { routing_number: routingNumber.trim() } : {}),
          transaction_id_requirement: txnRequirement,
        },
        transfer_rails: rails,
        is_enabled: true,
        sort_order: sort,
      },
      {
        onError: (err) => setFormError(err instanceof Error ? err.message : "Request failed"),
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="sm-form-grid">
        <Field label="Provider" required error={errors.provider_id ?? ""}>
          <Select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            aria-invalid={Boolean(errors.provider_id) || undefined}
            disabled={providersLoading}
          >
            <option value="">Select a provider…</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name} ({PROVIDER_TYPE_LABELS[p.provider_type]})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Method key" required hint="Lowercase, unique per provider." error={errors.method_key ?? ""}>
          <Input
            value={methodKey}
            onChange={(e) => setMethodKey(e.target.value)}
            aria-invalid={Boolean(errors.method_key) || undefined}
            placeholder="bkash-personal"
          />
        </Field>
        <Field label="Display name" required error={errors.display_name ?? ""}>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-invalid={Boolean(errors.display_name) || undefined}
            placeholder="bKash Personal"
          />
        </Field>
        <Field label="Kind" required>
          <Select value={methodKind} onChange={(e) => setMethodKind(e.target.value as PaymentMethod["method_kind"])}>
            <option value="mfs_account">MFS account</option>
            <option value="bank_account">Bank account</option>
            <option value="automated_checkout">Automated checkout</option>
          </Select>
        </Field>
        {methodKind === "mfs_account" ? (
          <Field label="Account type" required>
            <Select value={accountType} onChange={(e) => setAccountType(e.target.value as "personal" | "merchant" | "agent")}>
              <option value="personal">Personal</option>
              <option value="merchant">Merchant</option>
              <option value="agent">Agent</option>
            </Select>
          </Field>
        ) : null}
        <Field label="Account label" hint="Shown to customers, e.g. Send Money number.">
          <Input value={accountLabel} onChange={(e) => setAccountLabel(e.target.value)} placeholder="bKash Send Money" />
        </Field>
        <Field label="Account number" required error={errors.account_number ?? ""}>
          <Input
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
            aria-invalid={Boolean(errors.account_number) || undefined}
            placeholder="01XXXXXXXXX"
          />
        </Field>
        <Field label="Account holder name">
          <Input value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} />
        </Field>
        {methodKind === "bank_account" ? (
          <>
            <Field label="Bank name">
              <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
            </Field>
            <Field label="Branch name">
              <Input value={branchName} onChange={(e) => setBranchName(e.target.value)} />
            </Field>
            <Field label="Routing number">
              <Input value={routingNumber} onChange={(e) => setRoutingNumber(e.target.value)} />
            </Field>
          </>
        ) : null}
        <Field label="Transaction ID" required hint="What customers must provide.">
          <Select value={txnRequirement} onChange={(e) => setTxnRequirement(e.target.value as "required" | "optional" | "disabled")}>
            <option value="required">Required</option>
            <option value="optional">Optional</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
        <Field label="Sort order" error={errors.sort_order ?? ""}>
          <Input inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
        </Field>
      </div>
      {methodKind === "bank_account" ? (
        <div style={{ marginTop: 16 }}>
          <Field label="Transfer rails" required error={errors.transfer_rails ?? ""}>
            <span>
              {RAILS.map((rail) => (
                <Checkbox
                  key={rail}
                  label={rail.toUpperCase()}
                  checked={rails.includes(rail)}
                  onChange={() => toggleRail(rail)}
                />
              ))}
            </span>
          </Field>
        </div>
      ) : null}
      <div style={{ marginTop: 16 }}>
        <Field label="Customer instructions" hint="Shown at checkout, max 1000 characters.">
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Send the exact order total to this number, then submit the transaction ID."
          />
        </Field>
      </div>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer" style={{ padding: 0, marginTop: 20 }}>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={mutation.isPending} onClick={submit}>
          Create method
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Payment Method — detail                                             */
/* ------------------------------------------------------------------ */
export function PaymentMethodDetailSection({ id }: { id: string }) {
  const confirm = useConfirm();
  const [editOpen, setEditOpen] = useState(false);
  const detail = useAdminDetail<PaymentMethod>("payment-methods", id, `/api/v1/admin/payment-methods/${id}`);
  const providers = useAdminList<PaymentProvider>("payment-providers", "/api/v1/admin/payment-providers");
  const providerById = useMemo(
    () => new Map((providers.data ?? []).map((p) => [p.id, p])),
    [providers.data],
  );

  const toggleMutation = useAdminMutation<PaymentMethod, { enabled: boolean }>({
    mutationFn: ({ enabled }) =>
      apiRequest<PaymentMethod>(`/api/v1/admin/payment-methods/${id}/${enabled ? "enable" : "disable"}`, {
        method: "POST",
      }),
    invalidateKeys: [detailKey("payment-methods", id), listKey("payment-methods")],
    successTitle: "Payment method updated",
  });

  const onToggle = async () => {
    const method = detail.data;
    if (!method) return;
    const enabling = !method.is_enabled;
    const ok = await confirm({
      title: enabling ? `Enable ${method.display_name}?` : `Disable ${method.display_name}?`,
      body: enabling
        ? "Customers will be able to choose this method at checkout again."
        : "Customers will no longer see this method at checkout. Open payment submissions for it stay open.",
      confirmLabel: enabling ? "Enable" : "Disable",
      danger: !enabling,
    });
    if (ok) toggleMutation.mutate({ enabled: enabling });
  };

  if (detail.isPending) {
    return (
      <section aria-labelledby="method-detail-heading">
        <PageHeader breadcrumb={[{ label: "Commerce" }, { label: "Payment Methods", href: "/payment-methods" }, { label: "…" }]} title="Payment method" />
        <div className="sm-table-wrap sm-table-wrap-pad">
          <Skeleton height={20} width="40%" />
          <div style={{ marginTop: 12 }}>
            <Skeleton height={16} />
          </div>
          <div style={{ marginTop: 12 }}>
            <Skeleton height={16} />
          </div>
        </div>
      </section>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <section aria-labelledby="method-detail-heading">
        <PageHeader breadcrumb={[{ label: "Commerce" }, { label: "Payment Methods", href: "/payment-methods" }, { label: "Not found" }]} title="Payment method" />
        <div className="sm-table-wrap">
          <ErrorState
            message={detail.error instanceof Error ? detail.error.message : "Payment method not found."}
            onRetry={() => void detail.refetch()}
          />
        </div>
      </section>
    );
  }

  const method = detail.data;
  const cfg = method.configuration;
  return (
    <section aria-labelledby="method-detail-heading">
      <PageHeader
        breadcrumb={[{ label: "Commerce" }, { label: "Payment Methods", href: "/payment-methods" }, { label: method.display_name }]}
        title={method.display_name}
        subtitle={`${KIND_LABELS[method.method_kind]} · ${providerById.get(method.provider_id)?.display_name ?? "—"}`}
        action={
          <span style={{ display: "inline-flex", gap: 8 }}>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <Button
              variant={method.is_enabled ? "danger-ghost" : "primary"}
              loading={toggleMutation.isPending}
              onClick={() => void onToggle()}
            >
              {method.is_enabled ? "Disable" : "Enable"}
            </Button>
          </span>
        }
      />
      <div style={{ marginBottom: 16 }}>
        <StatusBadge status={method.is_enabled ? "enabled" : "disabled"} />
      </div>
      <DetailFacts
        facts={[
          { label: "Method key", value: <span className="sm-mono">{method.method_key}</span> },
          { label: "Kind", value: KIND_LABELS[method.method_kind] },
          { label: "Provider", value: providerById.get(method.provider_id)?.display_name ?? "—" },
          { label: "Account type", value: method.account_type ?? "—" },
          { label: "Sort order", value: <span className="sm-tabular">{method.sort_order}</span> },
          { label: "Created", value: <DateCell value={method.created_at} /> },
        ]}
      />
      <Card title="Account configuration">
        <DetailFacts
          facts={[
            {
              label: "Account number",
              value: (
                <span className="sm-mono">
                  {cfg.account_number} <CopyButton value={cfg.account_number} />
                </span>
              ),
            },
            { label: "Account holder", value: cfg.account_holder_name ?? "—" },
            { label: "Bank", value: cfg.bank_name ?? "—" },
            { label: "Branch", value: cfg.branch_name ?? "—" },
            { label: "Routing number", value: cfg.routing_number ?? "—" },
            { label: "Transaction ID", value: cfg.transaction_id_requirement },
            { label: "Transfer rails", value: method.transfer_rails.length > 0 ? method.transfer_rails.join(", ").toUpperCase() : "—" },
            { label: "Account label", value: method.account_label ?? "—" },
          ]}
        />
        {method.instructions ? <p className="sm-hint">{method.instructions}</p> : null}
      </Card>
      {editOpen ? (
        <Dialog open size="md" onClose={() => setEditOpen(false)} title={`Edit ${method.display_name}`}>
          <MethodEditForm method={method} onDone={() => setEditOpen(false)} onCancel={() => setEditOpen(false)} />
        </Dialog>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Method edit form (PATCH — provider, key and kind never change)      */
/* ------------------------------------------------------------------ */
function MethodEditForm({
  method,
  onDone,
  onCancel,
}: {
  method: PaymentMethod;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(method.display_name);
  const [accountLabel, setAccountLabel] = useState(method.account_label ?? "");
  const [instructions, setInstructions] = useState(method.instructions ?? "");
  const [accountNumber, setAccountNumber] = useState(method.configuration.account_number);
  const [accountHolder, setAccountHolder] = useState(method.configuration.account_holder_name ?? "");
  const [bankName, setBankName] = useState(method.configuration.bank_name ?? "");
  const [branchName, setBranchName] = useState(method.configuration.branch_name ?? "");
  const [routingNumber, setRoutingNumber] = useState(method.configuration.routing_number ?? "");
  const [txnRequirement, setTxnRequirement] = useState(method.configuration.transaction_id_requirement);
  const [rails, setRails] = useState<Rail[]>([...method.transfer_rails]);
  const [sortOrder, setSortOrder] = useState(String(method.sort_order));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useAdminMutation<PaymentMethod, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<PaymentMethod>(`/api/v1/admin/payment-methods/${method.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [detailKey("payment-methods", method.id), listKey("payment-methods")],
    successTitle: "Payment method updated",
    onSuccess: onDone,
  });

  const toggleRail = (rail: Rail) =>
    setRails((prev) => (prev.includes(rail) ? prev.filter((r) => r !== rail) : [...prev, rail]));

  const submit = () => {
    const next: Record<string, string> = {};
    if (displayName.trim().length < 2) next.display_name = "Display name needs at least 2 characters.";
    if (accountNumber.trim().length < 4) next.account_number = "Account number needs at least 4 characters.";
    if (method.method_kind === "bank_account" && rails.length === 0)
      next.transfer_rails = "Bank methods need at least one rail.";
    const sort = Number(sortOrder);
    if (!Number.isInteger(sort) || sort < 0 || sort > 10000)
      next.sort_order = "Sort order must be 0–10000.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    mutation.mutate(
      {
        display_name: displayName.trim(),
        account_label: accountLabel.trim() || null,
        instructions: instructions.trim() || null,
        configuration: {
          account_number: accountNumber.trim(),
          account_holder_name: accountHolder.trim() || null,
          bank_name: bankName.trim() || null,
          branch_name: branchName.trim() || null,
          routing_number: routingNumber.trim() || null,
          transaction_id_requirement: txnRequirement,
        },
        transfer_rails: rails,
        sort_order: sort,
      },
      {
        onError: (err) => setFormError(err instanceof Error ? err.message : "Request failed"),
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="sm-form-grid">
        <Field label="Display name" required error={errors.display_name ?? ""}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-invalid={Boolean(errors.display_name) || undefined} />
        </Field>
        <Field label="Account label">
          <Input value={accountLabel} onChange={(e) => setAccountLabel(e.target.value)} />
        </Field>
        <Field label="Account number" required error={errors.account_number ?? ""}>
          <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} aria-invalid={Boolean(errors.account_number) || undefined} />
        </Field>
        <Field label="Account holder name">
          <Input value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} />
        </Field>
        {method.method_kind === "bank_account" ? (
          <>
            <Field label="Bank name">
              <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
            </Field>
            <Field label="Branch name">
              <Input value={branchName} onChange={(e) => setBranchName(e.target.value)} />
            </Field>
            <Field label="Routing number">
              <Input value={routingNumber} onChange={(e) => setRoutingNumber(e.target.value)} />
            </Field>
          </>
        ) : null}
        <Field label="Transaction ID" required>
          <Select value={txnRequirement} onChange={(e) => setTxnRequirement(e.target.value as "required" | "optional" | "disabled")}>
            <option value="required">Required</option>
            <option value="optional">Optional</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
        <Field label="Sort order" error={errors.sort_order ?? ""}>
          <Input inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
        </Field>
      </div>
      {method.method_kind === "bank_account" ? (
        <div style={{ marginTop: 16 }}>
          <Field label="Transfer rails" required error={errors.transfer_rails ?? ""}>
            <span>
              {RAILS.map((rail) => (
                <Checkbox
                  key={rail}
                  label={rail.toUpperCase()}
                  checked={rails.includes(rail)}
                  onChange={() => toggleRail(rail)}
                />
              ))}
            </span>
          </Field>
        </div>
      ) : null}
      <div style={{ marginTop: 16 }}>
        <Field label="Customer instructions">
          <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
      </div>
      {formError ? (
        <div style={{ marginTop: 16 }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      ) : null}
      <div className="sm-dialog-footer" style={{ padding: 0, marginTop: 20 }}>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={mutation.isPending} onClick={submit}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
