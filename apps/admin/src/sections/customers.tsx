/**
 * Customers — list + detail (design spec §4.1/§4.2).
 *
 * Routes (wired in router.tsx): /customers, /customers/$customerId.
 * Endpoints (verified in apps/api/src/app.ts):
 *  - GET    /api/v1/admin/customers                     customers.read
 *  - POST   /api/v1/admin/customers                     customers.manage
 *         (dedupe: email/phone match resolves to the existing customer;
 *         both matching DIFFERENT customers → 409)
 *  - GET    /api/v1/admin/customers/:id                customers.read
 *         (embeds financials, contacts, addresses, reports, orders
 *         with paid/remaining, subscriptions, licenses, payments,
 *         installations, tickets, activity)
 *  - PATCH  /api/v1/admin/customers/:id                customers.manage
 *  - GET    /api/v1/admin/customers/:id/orders         customers.read
 *         (each row carries paid_amount_minor / remaining_minor)
 *  - GET    /api/v1/admin/customers/:id/subscriptions  customers.read
 *  - GET    /api/v1/admin/customers/:id/licenses       customers.read
 *    (licenses strip license_key_hash server-side; only the hint renders)
 *  - GET/POST /api/v1/admin/customers/:id/addresses    customers.read/manage
 *  - PATCH/DELETE .../addresses/:addressId             customers.manage
 *  - GET/POST /api/v1/admin/customers/:id/reports      customers.read/manage
 *  - POST   /api/v1/admin/customers/:id/split-contact  customers.manage
 *  - GET    /api/v1/admin/customers/:id/payments       customers.read
 *  - GET    /api/v1/admin/customers/:id/installations  customers.read
 *  - GET    /api/v1/admin/customers/:id/activity       customers.read
 *  - GET    /api/v1/admin/customers/:id/tickets        tickets.view
 *
 * Detail tabs (PRD §9, all seven + Issues + Reports): Orders,
 * Subscriptions, Licenses, Payments, Connected Installations, Activity
 * History, Issues, Reports. The profile shows the financial overview
 * (total billed / paid / due / credit) and every order row shows its
 * own billed, paid and due amounts (owner 2026-11-17).
 *
 * Route-search note: search is read with useSearch({ strict: false })
 * and written with navigate({ search }) cast to never — both resolve
 * by path at runtime (see the same note in orders.tsx).
 */
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  LifeBuoy,
  Pencil,
  Plus,
  Scissors,
  UserRound,
  Users,
} from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { detailKey, listKey } from "../lib/query";
import {
  DetailFacts,
  DetailLayout,
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
  DateTimeCell,
  Dialog,
  ErrorState,
  Field,
  Input,
  MoneyCell,
  Select,
  StatusBadge,
  TableSkeleton,
  Tabs,
  Textarea,
} from "../components/primitives";

/* ------------------------------------------------------------------ */
/* DTOs (apps/api/src/platform/db/store.ts record shapes)              */
/* ------------------------------------------------------------------ */
export interface CustomerDto {
  id: string;
  customer_number: string;
  customer_type: "person" | "business";
  name: string;
  email: string | null;
  normalized_email: string | null;
  phone: string | null;
  normalized_phone: string | null;
  whatsapp: string | null;
  website: string | null;
  company_name: string | null;
  country_code: string;
  status: "active" | "inactive" | "blocked";
  registration_source: string;
  notes: string | null;
  credit_balance_minor: number;
  report_count?: number;
  has_concern_report?: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerOrderDto {
  id: string;
  order_number: string;
  public_reference: string;
  customer_id: string;
  status: string;
  payment_status: string;
  currency_code: string;
  total_minor: number;
  paid_amount_minor: number;
  remaining_minor: number;
  created_at: string;
}

export interface CustomerSubscriptionDto {
  id: string;
  subscription_number: string;
  customer_id: string;
  product_id: string;
  status: string;
  billing_kind: string;
  interval_unit: string | null;
  interval_count: number | null;
  currency_code: string;
  unit_amount_minor: number;
  current_period_start: string | null;
  current_period_end: string | null;
  next_renewal_at: string | null;
  created_at: string;
}

export interface CustomerLicenseDto {
  id: string;
  license_number: string;
  product_id: string;
  customer_id: string;
  license_key_hint: string;
  status: string;
  activation_limit: number;
  valid_from: string;
  expires_at: string | null;
  issued_at: string;
  created_at: string;
}

export interface CustomerContactDto {
  id: string;
  customer_id: string;
  kind: "email" | "phone";
  value: string;
  normalized_value: string;
  is_primary: boolean;
  created_at: string;
}

export interface CustomerAddressDto {
  id: string;
  customer_id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postal_code: string | null;
  country_code: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerReportDto {
  id: string;
  customer_id: string;
  author_user_id: string;
  author_name?: string | null;
  type: "note" | "concern";
  detail: string;
  created_at: string;
}

export interface CustomerPaymentSubmissionDto {
  id: string;
  order_id: string;
  amount_minor: number;
  currency_code: string;
  status: string;
  sender_name: string | null;
  transaction_reference: string | null;
  installment_id: string | null;
  submitted_at: string;
}

export interface CustomerPaymentTransactionDto {
  id: string;
  order_id: string;
  payment_submission_id: string | null;
  amount_minor: number;
  currency_code: string;
  status: string;
  paid_at: string;
  verification_source: string;
  created_at: string;
}

export interface CustomerInstallationDto {
  id: string;
  license_id: string;
  license_number: string;
  product_id: string;
  installation_id_hash: string;
  domain_normalized: string | null;
  environment: string;
  status: string;
  activated_at: string;
  last_seen_at: string;
  deactivated_at: string | null;
}

export interface CustomerActivityDto {
  id: string;
  actor_type: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: string;
  created_at: string;
}

export interface CustomerTicketDto {
  id: string;
  ticket_number: string;
  title: string;
  status: string;
  priority: string;
  assignee_user_id: string | null;
  assignee_name?: string | null;
  updated_at: string;
  created_at: string;
}

export interface CustomerFinancialsDto {
  total_billed_minor: number;
  total_paid_minor: number;
  total_due_minor: number;
  credit_balance_minor: number;
}

interface CustomerDetailDto extends CustomerDto {
  financials: CustomerFinancialsDto;
  contacts: CustomerContactDto[];
  addresses: CustomerAddressDto[];
  reports: CustomerReportDto[];
  orders: CustomerOrderDto[];
  subscriptions: CustomerSubscriptionDto[];
  licenses: CustomerLicenseDto[];
  payments: {
    submissions: CustomerPaymentSubmissionDto[];
    transactions: CustomerPaymentTransactionDto[];
  };
  installations: CustomerInstallationDto[];
  tickets: CustomerTicketDto[];
  activity: CustomerActivityDto[];
}

/* ------------------------------------------------------------------ */
/* Navigation helpers (see the route-search note above)                */
/* ------------------------------------------------------------------ */
function useGoTo() {
  const navigate = useNavigate();
  return (to: string) => {
    void navigate({ to } as never);
  };
}

function useListSearchControls(parsed: ListSearch) {
  const navigate = useNavigate();
  const update = (patch: Record<string, unknown>) => {
    void navigate({
      search: { ...parsed, ...patch },
    } as never);
  };
  return update;
}

/* ------------------------------------------------------------------ */
/* Collapsible section — progressive disclosure for create dialogs     */
/* (owner 2026-11-17: grouped sections, no wall of fields). Shared    */
/* by the Add Customer dialog, the Create Order wizard and the         */
/* ticket create dialog.                                               */
/* ------------------------------------------------------------------ */
export function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 16 }}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />} {title}
      </Button>
      {open ? <div style={{ marginTop: 12 }}>{children}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Customer form — shared by Add Customer and the order wizard's       */
/* inline customer step. Validation mirrors the API (name required,    */
/* at least one of email/phone, phone 6–40 chars).                     */
/* ------------------------------------------------------------------ */
export interface CustomerFormValues {
  name: string;
  customer_type: "person" | "business";
  email: string;
  phone: string;
  whatsapp: string;
  whatsappSameAsPhone: boolean;
  company_name: string;
  country_code: string;
  website: string;
  notes: string;
  address_line1: string;
  address_line2: string;
  address_city: string;
  address_state: string;
  address_postal_code: string;
  address_country: string;
}

export function emptyCustomerForm(): CustomerFormValues {
  return {
    name: "",
    customer_type: "person",
    email: "",
    phone: "",
    whatsapp: "",
    whatsappSameAsPhone: false,
    company_name: "",
    country_code: "BD",
    website: "",
    notes: "",
    address_line1: "",
    address_line2: "",
    address_city: "",
    address_state: "",
    address_postal_code: "",
    address_country: "BD",
  };
}

export function validateCustomerForm(
  v: CustomerFormValues
): Record<string, string> {
  const next: Record<string, string> = {};
  if (v.name.trim().length < 2) next.name = "Name must be at least 2 characters.";
  if (v.email.trim() === "" && v.phone.trim() === "") {
    next.email = "At least one of email or phone is required.";
    next.phone = "At least one of email or phone is required.";
  }
  if (v.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) {
    next.email = "Enter a valid email address.";
  }
  if (v.phone.trim() !== "" && (v.phone.trim().length < 6 || v.phone.trim().length > 40)) {
    next.phone = "Phone must be 6–40 characters.";
  }
  const wa = v.whatsappSameAsPhone ? v.phone.trim() : v.whatsapp.trim();
  if (wa !== "" && (wa.length < 6 || wa.length > 40)) {
    next.whatsapp = "WhatsApp must be 6–40 characters.";
  }
  if (v.country_code.trim().length !== 2) {
    next.country_code = "Country code is 2 letters.";
  }
  return next;
}

export function customerFormToCreateBody(v: CustomerFormValues): Record<string, unknown> {
  const whatsapp = v.whatsappSameAsPhone ? v.phone.trim() : v.whatsapp.trim();
  return {
    name: v.name.trim(),
    customer_type: v.customer_type,
    email: v.email.trim() === "" ? null : v.email.trim(),
    phone: v.phone.trim() === "" ? null : v.phone.trim(),
    whatsapp: whatsapp === "" ? null : whatsapp,
    company_name: v.company_name.trim() === "" ? null : v.company_name.trim(),
    country_code: v.country_code.trim().toUpperCase(),
    website: v.website.trim() === "" ? null : v.website.trim(),
    notes: v.notes.trim() === "" ? null : v.notes.trim(),
  };
}

export function customerFormToAddressBody(
  v: CustomerFormValues
): Record<string, unknown> | null {
  if (v.address_line1.trim() === "" && v.address_city.trim() === "") return null;
  // Schema keys (ADR-0009 decision 11): the API schema expects
  // address_line_1/address_line_2/state_or_region — the old short keys
  // (line1/line2/state) were stripped by valibot and the address stored
  // all-null lines. Nulls for empty optionals are accepted by the schema.
  return {
    address_line_1: v.address_line1.trim(),
    address_line_2: v.address_line2.trim() === "" ? null : v.address_line2.trim(),
    city: v.address_city.trim(),
    state_or_region: v.address_state.trim() === "" ? null : v.address_state.trim(),
    postal_code: v.address_postal_code.trim() === "" ? null : v.address_postal_code.trim(),
    country_code: v.address_country.trim().toUpperCase() || "BD",
    is_default: true,
  };
}

export function CustomerFormFields({
  values,
  onChange,
  errors,
  idPrefix,
}: {
  values: CustomerFormValues;
  onChange: (patch: Partial<CustomerFormValues>) => void;
  errors: Record<string, string>;
  idPrefix: string;
}) {
  return (
    <div>
      <Field label="Name" required htmlFor={`${idPrefix}-name`} error={errors.name ?? ""}>
        <Input
          id={`${idPrefix}-name`}
          value={values.name}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-invalid={Boolean(errors.name) || undefined}
          maxLength={200}
        />
      </Field>
      <Field label="Type" htmlFor={`${idPrefix}-type`}>
        <Select
          id={`${idPrefix}-type`}
          value={values.customer_type}
          onChange={(e) =>
            onChange({ customer_type: e.target.value as "person" | "business" })
          }
        >
          <option value="person">Person</option>
          <option value="business">Business</option>
        </Select>
      </Field>
      <Field label="Email" htmlFor={`${idPrefix}-email`} error={errors.email ?? ""}>
        <Input
          id={`${idPrefix}-email`}
          type="email"
          value={values.email}
          onChange={(e) => onChange({ email: e.target.value })}
          aria-invalid={Boolean(errors.email) || undefined}
          maxLength={200}
        />
      </Field>
      <Field label="Phone" htmlFor={`${idPrefix}-phone`} error={errors.phone ?? ""}>
        <Input
          id={`${idPrefix}-phone`}
          type="tel"
          value={values.phone}
          onChange={(e) => onChange({ phone: e.target.value })}
          aria-invalid={Boolean(errors.phone) || undefined}
          maxLength={40}
        />
      </Field>
      <Field label="WhatsApp" htmlFor={`${idPrefix}-whatsapp`} error={errors.whatsapp ?? ""}>
        <Input
          id={`${idPrefix}-whatsapp`}
          type="tel"
          value={values.whatsappSameAsPhone ? values.phone : values.whatsapp}
          onChange={(e) => onChange({ whatsapp: e.target.value })}
          disabled={values.whatsappSameAsPhone}
          aria-invalid={Boolean(errors.whatsapp) || undefined}
          maxLength={40}
        />
      </Field>
      <Checkbox
        label="WhatsApp is the same as phone"
        checked={values.whatsappSameAsPhone}
        onChange={(e) => onChange({ whatsappSameAsPhone: e.target.checked })}
      />
      <Field label="Company" htmlFor={`${idPrefix}-company`}>
        <Input
          id={`${idPrefix}-company`}
          value={values.company_name}
          onChange={(e) => onChange({ company_name: e.target.value })}
          maxLength={200}
        />
      </Field>
      <Field
        label="Country code"
        required
        htmlFor={`${idPrefix}-country`}
        error={errors.country_code ?? ""}
      >
        <Input
          id={`${idPrefix}-country`}
          value={values.country_code}
          onChange={(e) => onChange({ country_code: e.target.value.toUpperCase() })}
          aria-invalid={Boolean(errors.country_code) || undefined}
          maxLength={2}
        />
      </Field>
      <Field label="Website" htmlFor={`${idPrefix}-website`}>
        <Input
          id={`${idPrefix}-website`}
          value={values.website}
          onChange={(e) => onChange({ website: e.target.value })}
          maxLength={500}
          placeholder="https://example.com"
        />
      </Field>
      <Field label="Notes" htmlFor={`${idPrefix}-notes`}>
        <Textarea
          id={`${idPrefix}-notes`}
          value={values.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          maxLength={2000}
        />
      </Field>
      <CollapsibleSection title="Billing address (optional)">
        <Field label="Address line 1" htmlFor={`${idPrefix}-addr1`}>
          <Input
            id={`${idPrefix}-addr1`}
            value={values.address_line1}
            onChange={(e) => onChange({ address_line1: e.target.value })}
            maxLength={300}
          />
        </Field>
        <Field label="Address line 2" htmlFor={`${idPrefix}-addr2`}>
          <Input
            id={`${idPrefix}-addr2`}
            value={values.address_line2}
            onChange={(e) => onChange({ address_line2: e.target.value })}
            maxLength={300}
          />
        </Field>
        <Field label="City" htmlFor={`${idPrefix}-city`}>
          <Input
            id={`${idPrefix}-city`}
            value={values.address_city}
            onChange={(e) => onChange({ address_city: e.target.value })}
            maxLength={150}
          />
        </Field>
        <Field label="State" htmlFor={`${idPrefix}-state`}>
          <Input
            id={`${idPrefix}-state`}
            value={values.address_state}
            onChange={(e) => onChange({ address_state: e.target.value })}
            maxLength={150}
          />
        </Field>
        <Field label="Postal code" htmlFor={`${idPrefix}-postal`}>
          <Input
            id={`${idPrefix}-postal`}
            value={values.address_postal_code}
            onChange={(e) => onChange({ address_postal_code: e.target.value })}
            maxLength={20}
          />
        </Field>
        <Field label="Address country" htmlFor={`${idPrefix}-addr-country`}>
          <Input
            id={`${idPrefix}-addr-country`}
            value={values.address_country}
            onChange={(e) => onChange({ address_country: e.target.value.toUpperCase() })}
            maxLength={2}
          />
        </Field>
      </CollapsibleSection>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Customers list                                                      */
/* ------------------------------------------------------------------ */
const customerColumns: ColumnDef<CustomerDto, unknown>[] = [
  {
    accessorKey: "name",
    header: "Customer",
    cell: ({ row }) => {
      const c = row.original;
      return (
        <div>
          {/* The name is a real link on the row's own id — the single id
             source for this row, matching the View button and the
             products/packages lists. (Live defect 2026-11-18: the list
             showed a name that led to a different customer id and a
             "Customer not found" page; the code audit found no divergent
             id source in the tree — the name was plain text, so the live
             link came from a stale cached row. A real link on
             row.original.id removes any other id from the path.) */}
          <div>
            <a href={`/customers/${c.id}`}>{c.name}</a>
          </div>
          <div>
            <span className="sm-mono">{c.customer_number}</span>
            <CopyButton value={c.customer_number} label="Copy customer number" />
            {c.has_concern_report ? (
              <span style={{ marginLeft: 8 }}>
                <StatusBadge status="warning" label="Concern reported" />
              </span>
            ) : null}
          </div>
        </div>
      );
    },
  },
  {
    accessorKey: "email",
    header: "Contact",
    cell: ({ row }) => {
      const c = row.original;
      return (
        <div>
          <div>{c.email ?? "—"}</div>
          <div className="sm-hint">{c.phone ?? "No phone"}</div>
        </div>
      );
    },
  },
  {
    accessorKey: "customer_type",
    header: "Type",
    cell: ({ row }) =>
      row.original.customer_type === "business" ? "Business" : "Person",
  },
  {
    accessorKey: "credit_balance_minor",
    header: "Credit",
    cell: ({ row }) =>
      row.original.credit_balance_minor > 0 ? (
        <MoneyCell currency="BDT" minor={row.original.credit_balance_minor} />
      ) : (
        "—"
      ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "created_at",
    header: "Created",
    cell: ({ row }) => <DateTimeCell value={row.original.created_at} />,
  },
];

export function CustomersSection() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const parsed = parseListSearch(rawSearch);
  const updateSearch = useListSearchControls(parsed);
  const goTo = useGoTo();
  const [createOpen, setCreateOpen] = useState(false);
  const query = useAdminList<CustomerDto>("customers", "/api/v1/admin/customers");

  // The name cell renders the customer name as text; the row action opens
  // the detail page. (ListTable columns are module-level so they cannot
  // close over goTo — the View button column is added here.)
  const columns: ColumnDef<CustomerDto, unknown>[] = [
    ...customerColumns,
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => goTo(`/customers/${row.original.id}`)}
        >
          View
        </Button>
      ),
    },
  ];

  return (
    <section aria-labelledby="customers-heading">
      <PageHeader
        breadcrumb={[{ label: "Commerce" }, { label: "Customers" }]}
        title="Customers"
        help="People and businesses who have ordered"
        action={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Add customer
          </Button>
        }
      />
      <ListTable<CustomerDto>
        columns={columns}
        data={query.data}
        search={parsed.q ?? ""}
        onSearchChange={(q) => updateSearch({ q: q === "" ? undefined : q, page: 1 })}
        page={parsed.page ?? 1}
        onPageChange={(page) => updateSearch({ page })}
        pageSize={parsed.pageSize ?? 25}
        onPageSizeChange={(pageSize) => updateSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={Users}
        emptyTitle="No customers yet"
        emptyBody="Customers appear here once an order is placed, or add one manually."
        getRowId={(row) => row.id}
      />
      {createOpen ? (
        <AddCustomerDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            goTo(`/customers/${id}`);
          }}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Add customer — POST /api/v1/admin/customers (customers.manage)      */
/* ------------------------------------------------------------------ */
function AddCustomerDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [values, setValues] = useState<CustomerFormValues>(emptyCustomerForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const mutation = useAdminMutation<CustomerDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<CustomerDto>("/api/v1/admin/customers", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("customers")],
    successTitle: "Customer created",
    successMessage: `${values.name.trim()} was added.`,
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const next = validateCustomerForm(values);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    setSaving(true);
    try {
      const created = await mutation.mutateAsync(customerFormToCreateBody(values));
      // Billing address (if any fields were filled) is a second call —
      // the customer must exist first.
      const addressBody = customerFormToAddressBody(values);
      if (addressBody) {
        await apiRequest(`/api/v1/admin/customers/${created.id}/addresses`, {
          method: "POST",
          body: JSON.stringify(addressBody),
        });
      }
      onCreated(created.id);
    } catch (err) {
      // A 409 here is the dedupe conflict — the server message names
      // both customers; show it verbatim so staff can resolve it.
      setFormError(err instanceof Error ? err.message : "Could not create the customer.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add customer"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="add-customer-form"
            loading={saving || mutation.isPending}
          >
            Add customer
          </Button>
        </>
      }
    >
      <form id="add-customer-form" onSubmit={(e) => void onSubmit(e)} aria-label="Add customer">
        {formError ? <Alert variant="danger">{formError}</Alert> : null}
        <CustomerFormFields
          values={values}
          onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
          errors={errors}
          idPrefix="add"
        />
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Customer detail — tabs (PRD §9 + Issues + Reports)                  */
/* ------------------------------------------------------------------ */
function useCustomerCollection<T>(customerId: string, key: string, path: string) {
  return useQuery({
    queryKey: ["admin", "customers", "detail", customerId, key],
    queryFn: async () => {
      const res = await apiRequest<{ items: T[] }>(path);
      return res.items;
    },
  });
}

/** One related-records table inside a tab, with its own search + paging. */
function RelatedList<T>({
  columns,
  data,
  isLoading,
  isError,
  error,
  onRetry,
  emptyTitle,
  emptyBody,
  getRowId,
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  emptyTitle: string;
  emptyBody: string;
  getRowId: (row: T) => string;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  return (
    <ListTable<T>
      columns={columns}
      data={data}
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
      isError={isError}
      error={error}
      onRetry={onRetry}
      emptyIcon={UserRound}
      emptyTitle={emptyTitle}
      emptyBody={emptyBody}
      getRowId={getRowId}
    />
  );
}

export function CustomerDetailSection({ id }: { id: string }) {
  const [tab, setTab] = useState("orders");
  const [editOpen, setEditOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [addressEdit, setAddressEdit] = useState<CustomerAddressDto | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const goTo = useGoTo();
  const query = useAdminDetail<CustomerDetailDto>(
    "customers",
    id,
    `/api/v1/admin/customers/${id}`,
  );
  const ordersQuery = useCustomerCollection<CustomerOrderDto>(
    id,
    "orders",
    `/api/v1/admin/customers/${id}/orders`,
  );
  const subsQuery = useCustomerCollection<CustomerSubscriptionDto>(
    id,
    "subscriptions",
    `/api/v1/admin/customers/${id}/subscriptions`,
  );
  const licensesQuery = useCustomerCollection<CustomerLicenseDto>(
    id,
    "licenses",
    `/api/v1/admin/customers/${id}/licenses`,
  );
  const paymentsQuery = useQuery({
    queryKey: ["admin", "customers", "detail", id, "payments"],
    queryFn: async () =>
      apiRequest<{
        submissions: CustomerPaymentSubmissionDto[];
        transactions: CustomerPaymentTransactionDto[];
      }>(`/api/v1/admin/customers/${id}/payments`),
  });
  const installationsQuery = useCustomerCollection<CustomerInstallationDto>(
    id,
    "installations",
    `/api/v1/admin/customers/${id}/installations`,
  );
  const activityQuery = useCustomerCollection<CustomerActivityDto>(
    id,
    "activity",
    `/api/v1/admin/customers/${id}/activity`,
  );
  const issuesQuery = useQuery({
    queryKey: ["admin", "customers", "detail", id, "issues"],
    queryFn: async () => {
      const res = await apiRequest<{ items: CustomerTicketDto[] }>(
        `/api/v1/admin/tickets?customer_id=${id}`,
      );
      return res.items;
    },
  });

  if (query.isPending) {
    return (
      <section aria-labelledby="customer-heading">
        <PageHeader
          breadcrumb={[{ label: "Customers", href: "/customers" }, { label: "…" }]}
          title="Customer"
        />
        <TableSkeleton rows={5} />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section aria-labelledby="customer-heading">
        <PageHeader
          breadcrumb={[{ label: "Customers", href: "/customers" }, { label: "Customer" }]}
          title="Customer"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={
              query.error instanceof Error
                ? query.error.message
                : "Could not load this customer."
            }
            onRetry={() => void query.refetch()}
          />
        </div>
      </section>
    );
  }

  const customer = query.data;
  const fin = customer.financials;
  // Tab counts: the sub-query data wins when it has resolved; the
  // embedded detail arrays are the fallback. Every fallback is
  // optional-chained (live defect 2026-11-17: the detail used to
  // return payments as a bare array, so
  // customer.payments.submissions.length threw "Cannot read properties
  // of undefined (reading 'length')" on first load while the
  // sub-query was still pending — warm cache on reload hid it).
  const orderCount = ordersQuery.data?.length ?? customer.orders?.length ?? 0;
  const subCount = subsQuery.data?.length ?? customer.subscriptions?.length ?? 0;
  const licenseCount = licensesQuery.data?.length ?? customer.licenses?.length ?? 0;
  const paymentCount =
    paymentsQuery.data?.submissions.length ?? customer.payments?.submissions?.length ?? 0;
  const installationCount =
    installationsQuery.data?.length ?? customer.installations?.length ?? 0;
  const activityCount = activityQuery.data?.length ?? customer.activity?.length ?? 0;
  const issueCount = issuesQuery.data?.length ?? customer.tickets?.length ?? 0;
  const reportCount = customer.reports?.length ?? 0;
  const secondaryContacts = (customer.contacts ?? []).filter((c) => !c.is_primary);
  const hasConcern = (customer.reports ?? []).some((r) => r.type === "concern");

  const orderColumns: ColumnDef<CustomerOrderDto, unknown>[] = [
    {
      accessorKey: "order_number",
      header: "Order",
      cell: ({ row }) => (
        <span>
          <span className="sm-mono">{row.original.order_number}</span>
          <CopyButton value={row.original.order_number} label="Copy order number" />
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "payment_status",
      header: "Payment",
      cell: ({ row }) => <StatusBadge status={row.original.payment_status} />,
    },
    // Owner 2026-11-17: every order row shows its own billed, paid
    // and due amounts — not only the lifetime totals above.
    {
      accessorKey: "total_minor",
      header: "Billed",
      cell: ({ row }) => (
        <MoneyCell
          currency={row.original.currency_code}
          minor={row.original.total_minor}
        />
      ),
    },
    {
      accessorKey: "paid_amount_minor",
      header: "Paid",
      cell: ({ row }) => (
        <MoneyCell
          currency={row.original.currency_code}
          minor={row.original.paid_amount_minor}
        />
      ),
    },
    {
      accessorKey: "remaining_minor",
      header: "Due",
      cell: ({ row }) => (
        <MoneyCell
          currency={row.original.currency_code}
          minor={row.original.remaining_minor}
        />
      ),
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateTimeCell value={row.original.created_at} />,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => goTo(`/orders/${row.original.id}`)}>
          View
        </Button>
      ),
    },
  ];

  const subscriptionColumns: ColumnDef<CustomerSubscriptionDto, unknown>[] = [
    {
      accessorKey: "subscription_number",
      header: "Subscription",
      cell: ({ row }) => (
        <span className="sm-mono">{row.original.subscription_number}</span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "billing_kind",
      header: "Billing",
      cell: ({ row }) => row.original.billing_kind.replace(/_/g, " "),
    },
    {
      accessorKey: "interval_unit",
      header: "Interval",
      cell: ({ row }) =>
        row.original.interval_unit && row.original.interval_count
          ? `${row.original.interval_count} ${row.original.interval_unit}${row.original.interval_count > 1 ? "s" : ""}`
          : "—",
    },
    {
      accessorKey: "next_renewal_at",
      header: "Next renewal",
      cell: ({ row }) => <DateTimeCell value={row.original.next_renewal_at} />,
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateTimeCell value={row.original.created_at} />,
    },
  ];

  const licenseColumns: ColumnDef<CustomerLicenseDto, unknown>[] = [
    {
      accessorKey: "license_number",
      header: "License",
      cell: ({ row }) => (
        <span className="sm-mono">{row.original.license_number}</span>
      ),
    },
    {
      accessorKey: "license_key_hint",
      header: "Key hint",
      cell: ({ row }) => (
        <span className="sm-mono">{row.original.license_key_hint}</span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "activation_limit",
      header: "Activations",
      cell: ({ row }) => row.original.activation_limit,
    },
    {
      accessorKey: "expires_at",
      header: "Expires",
      cell: ({ row }) => <DateTimeCell value={row.original.expires_at} />,
    },
    {
      accessorKey: "issued_at",
      header: "Issued",
      cell: ({ row }) => <DateTimeCell value={row.original.issued_at} />,
    },
  ];

  const paymentSubmissionColumns: ColumnDef<CustomerPaymentSubmissionDto, unknown>[] = [
    {
      accessorKey: "submitted_at",
      header: "Submitted",
      cell: ({ row }) => <DateTimeCell value={row.original.submitted_at} />,
    },
    {
      accessorKey: "amount_minor",
      header: "Amount",
      cell: ({ row }) => (
        <MoneyCell
          currency={row.original.currency_code}
          minor={row.original.amount_minor}
        />
      ),
    },
    {
      accessorKey: "sender_name",
      header: "Sender",
      cell: ({ row }) => row.original.sender_name ?? "—",
    },
    {
      accessorKey: "transaction_reference",
      header: "Transaction ref",
      cell: ({ row }) => row.original.transaction_reference ?? "—",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
  ];

  const installationColumns: ColumnDef<CustomerInstallationDto, unknown>[] = [
    {
      accessorKey: "license_number",
      header: "License",
      cell: ({ row }) => (
        <span className="sm-mono">{row.original.license_number}</span>
      ),
    },
    {
      accessorKey: "domain_normalized",
      header: "Domain",
      cell: ({ row }) => row.original.domain_normalized ?? "—",
    },
    {
      accessorKey: "environment",
      header: "Environment",
      cell: ({ row }) => row.original.environment,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "last_seen_at",
      header: "Last seen",
      cell: ({ row }) => <DateTimeCell value={row.original.last_seen_at} />,
    },
  ];

  const activityColumns: ColumnDef<CustomerActivityDto, unknown>[] = [
    {
      accessorKey: "created_at",
      header: "When",
      cell: ({ row }) => <DateTimeCell value={row.original.created_at} />,
    },
    {
      accessorKey: "action",
      header: "Action",
      cell: ({ row }) => row.original.action.replace(/_/g, " "),
    },
    {
      accessorKey: "actor_type",
      header: "Actor",
      cell: ({ row }) => row.original.actor_type,
    },
    {
      accessorKey: "outcome",
      header: "Outcome",
      cell: ({ row }) => <StatusBadge status={row.original.outcome} />,
    },
  ];

  const issueColumns: ColumnDef<CustomerTicketDto, unknown>[] = [
    {
      accessorKey: "ticket_number",
      header: "Ticket",
      cell: ({ row }) => (
        <span className="sm-mono">{row.original.ticket_number}</span>
      ),
    },
    {
      accessorKey: "title",
      header: "Title",
      cell: ({ row }) => row.original.title,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "priority",
      header: "Priority",
      cell: ({ row }) => row.original.priority,
    },
    {
      accessorKey: "assignee_name",
      header: "Assignee",
      cell: ({ row }) => row.original.assignee_name ?? "Unassigned",
    },
    {
      accessorKey: "updated_at",
      header: "Updated",
      cell: ({ row }) => <DateTimeCell value={row.original.updated_at} />,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => goTo(`/tickets/${row.original.id}`)}>
          View
        </Button>
      ),
    },
  ];

  return (
    <section aria-labelledby="customer-heading">
      <PageHeader
        breadcrumb={[{ label: "Customers", href: "/customers" }, { label: customer.name }]}
        title={customer.name}
        subtitle={`${customer.customer_number} · ${customer.customer_type === "business" ? "Business" : "Person"}`}
        action={
          <>
            <Button
              variant="secondary"
              icon={LifeBuoy}
              onClick={() => goTo(`/tickets?customer=${customer.id}&new=1`)}
            >
              Create issue
            </Button>
            {secondaryContacts.length > 0 ? (
              <Button variant="secondary" icon={Scissors} onClick={() => setSplitOpen(true)}>
                Split contact
              </Button>
            ) : null}
            <Button variant="accent" icon={Pencil} onClick={() => setEditOpen(true)}>
              Edit customer
            </Button>
          </>
        }
      />
      {hasConcern ? (
        <div style={{ marginBottom: 16 }}>
          <Alert variant="warning">
            This customer has a concern report on file — see the Reports tab
            before taking action.
          </Alert>
        </div>
      ) : null}
      <DetailLayout
        title="Customer"
        facts={[
          { label: "Status", value: <StatusBadge status={customer.status} /> },
          { label: "Email", value: customer.email ?? "—" },
          { label: "Phone", value: customer.phone ?? "—" },
          { label: "WhatsApp", value: customer.whatsapp ?? "—" },
          {
            label: "Company",
            value: customer.company_name ?? "—",
          },
          {
            label: "Website",
            value: customer.website ? (
              <a href={customer.website} target="_blank" rel="noreferrer">
                {customer.website}
              </a>
            ) : (
              "—"
            ),
          },
          { label: "Country", value: customer.country_code },
          { label: "Registered", value: <DateCell value={customer.created_at} /> },
          {
            label: "Reports",
            value: hasConcern ? (
              <StatusBadge status="warning" label={`Concern reported (${reportCount})`} />
            ) : reportCount > 0 ? (
              `${reportCount} note${reportCount > 1 ? "s" : ""}`
            ) : (
              "None"
            ),
          },
        ]}
      >
        <Card title="Financial overview">
          <DetailFacts
            facts={[
              {
                label: "Total billed",
                value: <MoneyCell currency="BDT" minor={fin.total_billed_minor} />,
              },
              {
                label: "Total paid",
                value: <MoneyCell currency="BDT" minor={fin.total_paid_minor} />,
              },
              {
                label: "Total due",
                value: <MoneyCell currency="BDT" minor={fin.total_due_minor} />,
              },
              {
                label: "Credit balance",
                value: <MoneyCell currency="BDT" minor={fin.credit_balance_minor} />,
              },
            ]}
          />
          <p className="sm-hint">
            Paid counts verified payments only. Overpayments become credit,
            usable against future dues when staff apply it at approval.
          </p>
        </Card>
        {customer.notes ? (
          <Card title="Notes">
            <p className="sm-hint">{customer.notes}</p>
          </Card>
        ) : null}
        <Card
          title="Billing addresses"
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon={Plus}
              onClick={() => {
                setAddressEdit(null);
                setAddressOpen(true);
              }}
            >
              Add address
            </Button>
          }
        >
          {(customer.addresses ?? []).length === 0 ? (
            <p className="sm-hint">No billing address on file.</p>
          ) : (
            <div className="sm-table-wrap">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th scope="col">Address</th>
                    <th scope="col">City</th>
                    <th scope="col">Country</th>
                    <th scope="col">Default</th>
                    <th scope="col">
                      <span className="sm-hint">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(customer.addresses ?? []).map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.line1}
                        {a.line2 ? <div className="sm-hint">{a.line2}</div> : null}
                        {a.postal_code ? (
                          <div className="sm-hint">{a.postal_code}</div>
                        ) : null}
                      </td>
                      <td>{a.city}</td>
                      <td>{a.country_code}</td>
                      <td>{a.is_default ? <StatusBadge status="active" label="Default" /> : "—"}</td>
                      <td>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setAddressEdit(a);
                            setAddressOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Tabs
          tabs={[
            { key: "orders", label: `Orders (${orderCount})` },
            { key: "subscriptions", label: `Subscriptions (${subCount})` },
            { key: "licenses", label: `Licenses (${licenseCount})` },
            { key: "payments", label: `Payments (${paymentCount})` },
            { key: "installations", label: `Installations (${installationCount})` },
            { key: "activity", label: `Activity (${activityCount})` },
            { key: "issues", label: `Issues (${issueCount})` },
            { key: "reports", label: `Reports (${reportCount})` },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === "orders" ? (
          <RelatedList<CustomerOrderDto>
            columns={orderColumns}
            data={ordersQuery.data}
            isLoading={ordersQuery.isPending}
            isError={ordersQuery.isError}
            error={ordersQuery.error}
            onRetry={() => void ordersQuery.refetch()}
            emptyTitle="No orders yet"
            emptyBody="This customer has not placed an order."
            getRowId={(row) => row.id}
          />
        ) : null}
        {tab === "subscriptions" ? (
          <RelatedList<CustomerSubscriptionDto>
            columns={subscriptionColumns}
            data={subsQuery.data}
            isLoading={subsQuery.isPending}
            isError={subsQuery.isError}
            error={subsQuery.error}
            onRetry={() => void subsQuery.refetch()}
            emptyTitle="No subscriptions yet"
            emptyBody="This customer has no subscriptions."
            getRowId={(row) => row.id}
          />
        ) : null}
        {tab === "licenses" ? (
          <RelatedList<CustomerLicenseDto>
            columns={licenseColumns}
            data={licensesQuery.data}
            isLoading={licensesQuery.isPending}
            isError={licensesQuery.isError}
            error={licensesQuery.error}
            onRetry={() => void licensesQuery.refetch()}
            emptyTitle="No licenses yet"
            emptyBody="This customer has no licenses. License keys are never shown here — only the key hint."
            getRowId={(row) => row.id}
          />
        ) : null}
        {tab === "payments" ? (
          <div>
            <RelatedList<CustomerPaymentSubmissionDto>
              columns={paymentSubmissionColumns}
              data={paymentsQuery.data?.submissions}
              isLoading={paymentsQuery.isPending}
              isError={paymentsQuery.isError}
              error={paymentsQuery.error}
              onRetry={() => void paymentsQuery.refetch()}
              emptyTitle="No payment submissions yet"
              emptyBody="No manual payment claim has been submitted for this customer."
              getRowId={(row) => row.id}
            />
            <Card title="Verified transactions">
              {(paymentsQuery.data?.transactions.length ?? 0) === 0 ? (
                <p className="sm-hint">No verified transactions yet.</p>
              ) : (
                <div className="sm-table-wrap">
                  <table className="sm-table">
                    <thead>
                      <tr>
                        <th scope="col">Paid at</th>
                        <th scope="col">Amount</th>
                        <th scope="col">Status</th>
                        <th scope="col">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(paymentsQuery.data?.transactions ?? []).map((t) => (
                        <tr key={t.id}>
                          <td>
                            <DateTimeCell value={t.paid_at} />
                          </td>
                          <td>
                            <MoneyCell currency={t.currency_code} minor={t.amount_minor} />
                          </td>
                          <td>
                            <StatusBadge status={t.status} />
                          </td>
                          <td>{t.verification_source.replace(/_/g, " ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        ) : null}
        {tab === "installations" ? (
          <RelatedList<CustomerInstallationDto>
            columns={installationColumns}
            data={installationsQuery.data}
            isLoading={installationsQuery.isPending}
            isError={installationsQuery.isError}
            error={installationsQuery.error}
            onRetry={() => void installationsQuery.refetch()}
            emptyTitle="No installations yet"
            emptyBody="No license has been activated from this customer's devices."
            getRowId={(row) => row.id}
          />
        ) : null}
        {tab === "activity" ? (
          <RelatedList<CustomerActivityDto>
            columns={activityColumns}
            data={activityQuery.data}
            isLoading={activityQuery.isPending}
            isError={activityQuery.isError}
            error={activityQuery.error}
            onRetry={() => void activityQuery.refetch()}
            emptyTitle="No activity yet"
            emptyBody="Audit entries touching this customer, their orders, subscriptions or licenses will appear here."
            getRowId={(row) => row.id}
          />
        ) : null}
        {tab === "issues" ? (
          <RelatedList<CustomerTicketDto>
            columns={issueColumns}
            data={issuesQuery.data}
            isLoading={issuesQuery.isPending}
            isError={issuesQuery.isError}
            error={issuesQuery.error}
            onRetry={() => void issuesQuery.refetch()}
            emptyTitle="No issues yet"
            emptyBody="Support tickets for this customer will appear here."
            getRowId={(row) => row.id}
          />
        ) : null}
        {tab === "reports" ? (
          <div>
            <Card
              title="Staff reports"
              actions={
                <Button
                  variant="secondary"
                  size="sm"
                  icon={FileText}
                  onClick={() => setReportOpen(true)}
                >
                  File report
                </Button>
              }
            >
              {(customer.reports ?? []).length === 0 ? (
                <p className="sm-hint">
                  No reports on file. File a note or a concern when something
                  about this customer needs to be on record.
                </p>
              ) : (
                <div className="sm-table-wrap">
                  <table className="sm-table">
                    <thead>
                      <tr>
                        <th scope="col">Type</th>
                        <th scope="col">Detail</th>
                        <th scope="col">Author</th>
                        <th scope="col">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(customer.reports ?? []).map((r) => (
                        <tr key={r.id}>
                          <td>
                            {r.type === "concern" ? (
                              <StatusBadge status="warning" label="Concern" />
                            ) : (
                              <StatusBadge status="info" label="Note" />
                            )}
                          </td>
                          <td>{r.detail}</td>
                          <td>{r.author_name ?? "—"}</td>
                          <td>
                            <DateTimeCell value={r.created_at} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        ) : null}
        {editOpen ? (
          <EditCustomerDialog customer={customer} onClose={() => setEditOpen(false)} />
        ) : null}
        {addressOpen ? (
          <AddressDialog
            customerId={customer.id}
            address={addressEdit}
            onClose={() => {
              setAddressOpen(false);
              setAddressEdit(null);
            }}
          />
        ) : null}
        {reportOpen ? (
          <ReportDialog
            customerId={customer.id}
            onClose={() => setReportOpen(false)}
            onCreated={() => setReportOpen(false)}
          />
        ) : null}
        {splitOpen ? (
          <SplitContactDialog
            customer={customer}
            onClose={() => setSplitOpen(false)}
            onCreated={(newId) => {
              setSplitOpen(false);
              goTo(`/customers/${newId}`);
            }}
          />
        ) : null}
      </DetailLayout>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Edit customer — PATCH /api/v1/admin/customers/:id (customers.manage) */
/* ------------------------------------------------------------------ */
function EditCustomerDialog({
  customer,
  onClose,
}: {
  customer: CustomerDto;
  onClose: () => void;
}) {
  const [name, setName] = useState(customer.name);
  const [email, setEmail] = useState(customer.email ?? "");
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [whatsapp, setWhatsapp] = useState(customer.whatsapp ?? "");
  const [whatsappSameAsPhone, setWhatsappSameAsPhone] = useState(false);
  const [companyName, setCompanyName] = useState(customer.company_name ?? "");
  const [website, setWebsite] = useState(customer.website ?? "");
  const [countryCode, setCountryCode] = useState(customer.country_code);
  const [status, setStatus] = useState(customer.status);
  const [notes, setNotes] = useState(customer.notes ?? "");
  const [errors, setErrors] = useState<{
    name?: string;
    email?: string;
    phone?: string;
    whatsapp?: string;
    countryCode?: string;
  }>({});

  const mutation = useAdminMutation<CustomerDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<CustomerDto>(`/api/v1/admin/customers/${customer.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("customers"), detailKey("customers", customer.id)],
    successTitle: "Customer updated",
    successMessage: `${name.trim()} saved.`,
    onSuccess: () => onClose(),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (name.trim().length < 2) next.name = "Name must be at least 2 characters.";
    if (email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      next.email = "Enter a valid email address.";
    }
    if (phone.trim() !== "" && phone.trim().length < 6) {
      next.phone = "Phone must be at least 6 characters.";
    }
    const wa = whatsappSameAsPhone ? phone.trim() : whatsapp.trim();
    if (wa !== "" && wa.length < 6) {
      next.whatsapp = "WhatsApp must be at least 6 characters.";
    }
    if (countryCode.trim().length !== 2) {
      next.countryCode = "Country code is 2 letters.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    // Editing a customer is not destructive, so no confirmation dialog:
    // the mutation toasts on success/failure and the form keeps its input
    // on a failed submit.
    mutation.mutate({
      name: name.trim(),
      email: email.trim() === "" ? null : email.trim(),
      phone: phone.trim() === "" ? null : phone.trim(),
      whatsapp: wa === "" ? null : wa,
      company_name: companyName.trim() === "" ? null : companyName.trim(),
      website: website.trim() === "" ? null : website.trim(),
      country_code: countryCode.trim().toUpperCase(),
      status,
      notes: notes.trim() === "" ? null : notes.trim(),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit customer"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            type="submit"
            form="edit-customer-form"
            loading={mutation.isPending}
          >
            Save changes
          </Button>
        </>
      }
    >
      <form
        id="edit-customer-form"
        onSubmit={onSubmit}
        aria-label="Edit customer"
      >
        {mutation.isError ? (
          <Alert variant="danger">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Could not save the customer."}
          </Alert>
        ) : null}
        <Field
          label="Name"
          required
          htmlFor="edit-name"
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            id="edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={errors.name ? true : undefined}
            maxLength={200}
          />
        </Field>
        <Field
          label="Email"
          htmlFor="edit-email"
          {...(errors.email ? { error: errors.email } : {})}
        >
          <Input
            id="edit-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={errors.email ? true : undefined}
            maxLength={200}
          />
        </Field>
        <Field
          label="Phone"
          htmlFor="edit-phone"
          {...(errors.phone ? { error: errors.phone } : {})}
        >
          <Input
            id="edit-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={errors.phone ? true : undefined}
            maxLength={40}
          />
        </Field>
        <Field
          label="WhatsApp"
          htmlFor="edit-whatsapp"
          {...(errors.whatsapp ? { error: errors.whatsapp } : {})}
        >
          <Input
            id="edit-whatsapp"
            type="tel"
            value={whatsappSameAsPhone ? phone : whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            disabled={whatsappSameAsPhone}
            aria-invalid={errors.whatsapp ? true : undefined}
            maxLength={40}
          />
        </Field>
        <Checkbox
          label="WhatsApp is the same as phone"
          checked={whatsappSameAsPhone}
          onChange={(e) => setWhatsappSameAsPhone(e.target.checked)}
        />
        <Field label="Company" htmlFor="edit-company">
          <Input
            id="edit-company"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label="Website" htmlFor="edit-website">
          <Input
            id="edit-website"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            maxLength={500}
          />
        </Field>
        <Field
          label="Country code"
          required
          htmlFor="edit-country"
          {...(errors.countryCode ? { error: errors.countryCode } : {})}
        >
          <Input
            id="edit-country"
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
            aria-invalid={errors.countryCode ? true : undefined}
            maxLength={2}
          />
        </Field>
        <Field label="Status" htmlFor="edit-status">
          <Select
            id="edit-status"
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as CustomerDto["status"])
            }
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="blocked">Blocked</option>
          </Select>
        </Field>
        <Field label="Notes" htmlFor="edit-notes">
          <Textarea
            id="edit-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Billing address — create / edit                                     */
/* ------------------------------------------------------------------ */
function AddressDialog({
  customerId,
  address,
  onClose,
}: {
  customerId: string;
  address: CustomerAddressDto | null;
  onClose: () => void;
}) {
  const [line1, setLine1] = useState(address?.line1 ?? "");
  const [line2, setLine2] = useState(address?.line2 ?? "");
  const [city, setCity] = useState(address?.city ?? "");
  const [state, setState] = useState(address?.state ?? "");
  const [postalCode, setPostalCode] = useState(address?.postal_code ?? "");
  const [countryCode, setCountryCode] = useState(address?.country_code ?? "BD");
  const [isDefault, setIsDefault] = useState(address?.is_default ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const mutation = useAdminMutation<CustomerAddressDto, Record<string, unknown>>({
    mutationFn: (body) =>
      address
        ? apiRequest<CustomerAddressDto>(
            `/api/v1/admin/customers/${customerId}/addresses/${address.id}`,
            { method: "PATCH", body: JSON.stringify(body) },
          )
        : apiRequest<CustomerAddressDto>(
            `/api/v1/admin/customers/${customerId}/addresses`,
            { method: "POST", body: JSON.stringify(body) },
          ),
    invalidateKeys: [detailKey("customers", customerId)],
    successTitle: address ? "Address updated" : "Address added",
    onSuccess: () => onClose(),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (line1.trim() === "") next.line1 = "Address line 1 is required.";
    if (city.trim() === "") next.city = "City is required.";
    if (countryCode.trim().length !== 2) next.country_code = "Country code is 2 letters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    mutation.mutate({
      // Schema keys (ADR-0009 decision 11) — see customerFormToAddressBody.
      address_line_1: line1.trim(),
      address_line_2: line2.trim() === "" ? null : line2.trim(),
      city: city.trim(),
      state_or_region: state.trim() === "" ? null : state.trim(),
      postal_code: postalCode.trim() === "" ? null : postalCode.trim(),
      country_code: countryCode.trim().toUpperCase(),
      is_default: isDefault,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={address ? "Edit billing address" : "Add billing address"}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            type="submit"
            form="address-form"
            loading={mutation.isPending}
          >
            {address ? "Save changes" : "Add address"}
          </Button>
        </>
      }
    >
      <form id="address-form" onSubmit={onSubmit} aria-label="Billing address">
        {mutation.isError ? (
          <Alert variant="danger">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Could not save the address."}
          </Alert>
        ) : null}
        <Field label="Address line 1" required error={errors.line1 ?? ""}>
          <Input value={line1} onChange={(e) => setLine1(e.target.value)} maxLength={300} />
        </Field>
        <Field label="Address line 2">
          <Input value={line2} onChange={(e) => setLine2(e.target.value)} maxLength={300} />
        </Field>
        <Field label="City" required error={errors.city ?? ""}>
          <Input value={city} onChange={(e) => setCity(e.target.value)} maxLength={150} />
        </Field>
        <Field label="State">
          <Input value={state} onChange={(e) => setState(e.target.value)} maxLength={150} />
        </Field>
        <Field label="Postal code">
          <Input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} maxLength={20} />
        </Field>
        <Field label="Country code" required error={errors.country_code ?? ""}>
          <Input
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
            maxLength={2}
          />
        </Field>
        <Checkbox
          label="Default billing address"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Staff report — POST /api/v1/admin/customers/:id/reports             */
/* ------------------------------------------------------------------ */
function ReportDialog({
  customerId,
  onClose,
  onCreated,
}: {
  customerId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [type, setType] = useState<"note" | "concern">("note");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useAdminMutation<CustomerReportDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<CustomerReportDto>(`/api/v1/admin/customers/${customerId}/reports`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("customers"), detailKey("customers", customerId)],
    successTitle: "Report filed",
    onSuccess: () => onCreated(),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (detail.trim().length < 3) {
      setError("Detail is required — say what happened.");
      return;
    }
    setError(null);
    mutation.mutate({ type, detail: detail.trim() });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="File a report"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            type="submit"
            form="report-form"
            loading={mutation.isPending}
          >
            File report
          </Button>
        </>
      }
    >
      <form id="report-form" onSubmit={onSubmit} aria-label="File a report">
        {mutation.isError ? (
          <Alert variant="danger">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Could not file the report."}
          </Alert>
        ) : null}
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as "note" | "concern")}>
            <option value="note">Note — something worth recording</option>
            <option value="concern">Concern — a problem with this customer</option>
          </Select>
        </Field>
        <Field label="Detail" required error={error ?? ""}>
          <Textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={5000}
            placeholder="What happened, when, and what should other staff know?"
          />
        </Field>
        <p className="sm-hint">
          A concern report shows a warning badge on the customer list row and
          on this profile.
        </p>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Split contact — detach a secondary email/phone into its own         */
/* customer profile (ADR-0009). Orders stay with the source customer.  */
/* ------------------------------------------------------------------ */
function SplitContactDialog({
  customer,
  onClose,
  onCreated,
}: {
  customer: CustomerDetailDto;
  onClose: () => void;
  onCreated: (newCustomerId: string) => void;
}) {
  const secondary = (customer.contacts ?? []).filter((c) => !c.is_primary);
  const secondaryPhones = secondary.filter((c) => c.kind === "phone");
  const primaryPhone = (customer.contacts ?? []).find(
    (c) => c.kind === "phone" && c.is_primary
  );
  const [contactId, setContactId] = useState(secondary[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  // Default phone: the source's most recently added secondary phone,
  // else the primary phone (ADR-0009 — the pairing "which phone
  // arrived with which email" is not tracked).
  const [phone, setPhone] = useState(
    secondaryPhones[secondaryPhones.length - 1]?.value ?? primaryPhone?.value ?? ""
  );
  const [error, setError] = useState<string | null>(null);

  const mutation = useAdminMutation<
    { source_customer: CustomerDto; new_customer: CustomerDto },
    Record<string, unknown>
  >({
    mutationFn: (body) =>
      apiRequest<{ source_customer: CustomerDto; new_customer: CustomerDto }>(
        `/api/v1/admin/customers/${customer.id}/split-contact`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    invalidateKeys: [listKey("customers"), detailKey("customers", customer.id)],
    successTitle: "Contact split",
    successMessage: "The contact now has its own customer profile.",
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const contact = secondary.find((c) => c.id === contactId);
    if (!contact) {
      setError("Choose the contact to split off.");
      return;
    }
    if (newName.trim().length < 2) {
      setError("The new profile needs a name (at least 2 characters).");
      return;
    }
    setError(null);
    mutation.mutate(
      {
        contact_kind: contact.kind,
        value: contact.value,
        new_customer_name: newName.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      },
      {
        onSuccess: (data) => onCreated(data.new_customer.id),
        onError: (err) =>
          setError(err instanceof Error ? err.message : "Could not split the contact."),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Split contact into its own profile"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            type="submit"
            form="split-form"
            loading={mutation.isPending}
          >
            Split contact
          </Button>
        </>
      }
    >
      <form id="split-form" onSubmit={onSubmit} aria-label="Split contact">
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <p className="sm-hint">
          Detaches a secondary email or phone from this profile into a new
          customer profile. Orders stay with this customer.
        </p>
        <Field label="Contact to split off" required>
          <Select value={contactId} onChange={(e) => setContactId(e.target.value)}>
            {secondary.map((c) => (
              <option key={c.id} value={c.id}>
                {c.kind === "email" ? "Email" : "Phone"} — {c.value}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="New customer name" required>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={200}
            placeholder="Name for the new profile"
          />
        </Field>
        <Field
          label="Phone for the new profile"
          hint="Defaults to the most recently added secondary phone, else the primary phone. Pick a different one if needed."
        >
          <Select value={phone} onChange={(e) => setPhone(e.target.value)}>
            {[...secondaryPhones, ...(primaryPhone ? [primaryPhone] : [])].map((c) => (
              <option key={c.id} value={c.value}>
                {c.value}
                {c.is_primary ? " (primary)" : ""}
              </option>
            ))}
            <option value="">No phone</option>
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
