/**
 * Customers — list + detail (design spec §4.1/§4.2).
 *
 * Routes (wired by the parent): /customers, /customers/$customerId.
 * Endpoints (verified in apps/api/src/app.ts):
 *  - GET    /api/v1/admin/customers                     customers.read
 *  - GET    /api/v1/admin/customers/:id                customers.read
 *  - PATCH  /api/v1/admin/customers/:id                customers.manage
 *  - GET    /api/v1/admin/customers/:id/orders         customers.read
 *  - GET    /api/v1/admin/customers/:id/subscriptions  customers.read
 *  - GET    /api/v1/admin/customers/:id/licenses       customers.read
 *    (licenses strip license_key_hash server-side; only the hint renders)
 *
 * Route-search note: the /customers route is not registered in router.tsx
 * yet, so a literal useSearch({ from: "/customers" }) does not typecheck
 * (probe-verified: TS2322). Until the parent wires the route, search is
 * read with useSearch({ strict: false }) and written with navigate({ search })
 * cast to never — both resolve by path at runtime and keep working once the
 * route (with validateSearch) is registered. The cast can then be dropped.
 */
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, UserRound, Users } from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { detailKey, listKey } from "../lib/query";
import {
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
  CopyButton,
  DateCell,
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
  company_name: string | null;
  country_code: string;
  status: "active" | "inactive" | "blocked";
  registration_source: string;
  notes: string | null;
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

interface CustomerDetailDto extends CustomerDto {
  orders: CustomerOrderDto[];
  subscriptions: CustomerSubscriptionDto[];
  licenses: CustomerLicenseDto[];
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
          <div>{c.name}</div>
          <div>
            <span className="sm-mono">{c.customer_number}</span>
            <CopyButton value={c.customer_number} label="Copy customer number" />
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
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "created_at",
    header: "Created",
    cell: ({ row }) => <DateCell value={row.original.created_at} />,
  },
];

export function CustomersSection() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const parsed = parseListSearch(rawSearch);
  const updateSearch = useListSearchControls(parsed);
  const goTo = useGoTo();
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
        subtitle="People and businesses who have ordered"
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
        emptyBody="Customers appear here once an order is placed."
        getRowId={(row) => row.id}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Customer detail — tabs: Orders / Subscriptions / Licenses           */
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
  const orderCount = ordersQuery.data?.length ?? customer.orders.length;
  const subCount = subsQuery.data?.length ?? customer.subscriptions.length;
  const licenseCount = licensesQuery.data?.length ?? customer.licenses.length;

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
    {
      accessorKey: "total_minor",
      header: "Total",
      cell: ({ row }) => (
        <MoneyCell
          currency={row.original.currency_code}
          minor={row.original.total_minor}
        />
      ),
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateCell value={row.original.created_at} />,
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
      cell: ({ row }) => <DateCell value={row.original.next_renewal_at} />,
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <DateCell value={row.original.created_at} />,
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
      cell: ({ row }) => <DateCell value={row.original.expires_at} />,
    },
    {
      accessorKey: "issued_at",
      header: "Issued",
      cell: ({ row }) => <DateCell value={row.original.issued_at} />,
    },
  ];

  return (
    <section aria-labelledby="customer-heading">
      <PageHeader
        breadcrumb={[{ label: "Customers", href: "/customers" }, { label: customer.name }]}
        title={customer.name}
        subtitle={`${customer.customer_number} · ${customer.customer_type === "business" ? "Business" : "Person"}`}
        action={
          <Button variant="accent" icon={Pencil} onClick={() => setEditOpen(true)}>
            Edit customer
          </Button>
        }
      />
      <DetailLayout
        title="Customer"
        facts={[
          { label: "Status", value: <StatusBadge status={customer.status} /> },
          { label: "Email", value: customer.email ?? "—" },
          { label: "Phone", value: customer.phone ?? "—" },
          {
            label: "Company",
            value: customer.company_name ?? "—",
          },
          { label: "Country", value: customer.country_code },
          { label: "Registered", value: <DateCell value={customer.created_at} /> },
        ]}
      >
        {customer.notes ? (
          <Card title="Notes">
            <p className="sm-hint">{customer.notes}</p>
          </Card>
        ) : null}
        <Tabs
          tabs={[
            { key: "orders", label: `Orders (${orderCount})` },
            { key: "subscriptions", label: `Subscriptions (${subCount})` },
            { key: "licenses", label: `Licenses (${licenseCount})` },
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
        {editOpen ? (
          <EditCustomerDialog customer={customer} onClose={() => setEditOpen(false)} />
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
  const [companyName, setCompanyName] = useState(customer.company_name ?? "");
  const [countryCode, setCountryCode] = useState(customer.country_code);
  const [status, setStatus] = useState(customer.status);
  const [notes, setNotes] = useState(customer.notes ?? "");
  const [errors, setErrors] = useState<{
    name?: string;
    email?: string;
    phone?: string;
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
      company_name: companyName.trim() === "" ? null : companyName.trim(),
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
        <Field label="Company" htmlFor="edit-company">
          <Input
            id="edit-company"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            maxLength={200}
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
