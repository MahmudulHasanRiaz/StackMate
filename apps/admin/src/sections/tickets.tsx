/**
 * Support Tickets — list + detail + create (ADR-0009).
 *
 * Routes (router.tsx): /tickets, /tickets/$ticketId.
 * Endpoints (apps/api/src/app.ts):
 *  - GET  /api/v1/admin/tickets                          tickets.view
 *         (?status=&priority=&customer_id=&assignee_user_id=&q=)
 *  - POST /api/v1/admin/tickets                          tickets.manage
 *  - GET  /api/v1/admin/tickets/:id                      tickets.view
 *         (embeds customer, reporter/assignee names, comments, linked
 *         order/subscription/license/product)
 *  - PATCH /api/v1/admin/tickets/:id                     tickets.manage
 *  - POST /api/v1/admin/tickets/:id/transition           tickets.manage
 *  - POST /api/v1/admin/tickets/:id/assign               tickets.manage
 *  - POST /api/v1/admin/tickets/:id/comments             tickets.manage
 *
 * Status flow (enforced server-side, 409 otherwise):
 *   open → in_progress → waiting_on_customer → resolved → closed,
 *   with reopen (closed/resolved → open). Customers report problems
 *   out-of-band (phone/email/WhatsApp); staff create the ticket —
 *   there is no public customer submission form.
 *
 * Create dialog: title + description + customer + priority + assignee
 * are the primary flow; the optional record links live in a collapsed
 * "Linked records" section (owner 2026-11-17). Picking an order
 * auto-assigns its customer; picking a subscription or license
 * auto-assigns its customer AND product (the API validates the same).
 */
import { useState, type FormEvent } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { LifeBuoy, Plus } from "lucide-react";
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
  DateTimeCell,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MenuSelect,
  Select,
  StatusBadge,
  TableSkeleton,
  Textarea,
} from "../components/primitives";
import { CollapsibleSection, type CustomerDto } from "./customers";
import { humanizeType } from "../lib/resolve-names";

/** Assignee option label — name + email + roles, so two staff with the
 *  same name are distinguishable (fix batch 2026-11-17). */
function staffOptionLabel(u: StaffUserDto): string {
  const roles = (u.roles ?? []).map((r) => humanizeType(r)).join(", ");
  return roles ? `${u.name} — ${u.email} (${roles})` : `${u.name} — ${u.email}`;
}

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */
export interface StaffUserDto {
  id: string;
  name: string;
  email: string;
  status: "active" | "suspended";
  roles: string[];
}

export interface TicketDto {
  id: string;
  ticket_number: string;
  customer_id: string | null;
  order_id: string | null;
  subscription_id: string | null;
  license_id: string | null;
  product_id: string | null;
  title: string;
  description: string;
  status: "open" | "in_progress" | "waiting_on_customer" | "resolved" | "closed";
  priority: "low" | "medium" | "high" | "urgent";
  category: "billing" | "technical" | "license" | "order" | "other";
  reporter_user_id: string;
  source_note: string | null;
  assignee_user_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  customer?: { id: string; name: string; customer_number: string } | null;
  assignee_name?: string | null;
  // Assignee disambiguation (fix batch 2026-11-17): two staff can share a
  // name — the API embeds email + role keys with the assignee.
  assignee_email?: string | null;
  assignee_roles?: string[] | null;
}

export interface TicketCommentDto {
  id: string;
  ticket_id: string;
  author_user_id: string;
  author_name?: string | null;
  body: string;
  is_internal: boolean;
  created_at: string;
}

interface TicketDetailDto extends TicketDto {
  reporter_name?: string | null;
  comments: TicketCommentDto[];
  linked: {
    order: { id: string; order_number: string } | null;
    subscription: { id: string; subscription_number: string } | null;
    license: { id: string; license_number: string } | null;
    product: { id: string; name: string } | null;
  };
}

const TICKET_STATUSES = ["open", "in_progress", "waiting_on_customer", "resolved", "closed"] as const;
const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const TICKET_CATEGORIES = ["billing", "technical", "license", "order", "other"] as const;

/** Allowed next statuses from each status (mirrors the API map). */
const NEXT_STATUSES: Record<TicketDto["status"], TicketDto["status"][]> = {
  open: ["in_progress", "closed"],
  in_progress: ["waiting_on_customer", "resolved", "closed"],
  waiting_on_customer: ["in_progress", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: ["open"],
};

function useGoTo() {
  const navigate = useNavigate();
  return (to: string) => {
    void navigate({ to } as never);
  };
}

function useListSearchControls(parsed: ListSearch) {
  const navigate = useNavigate();
  const update = (patch: Record<string, unknown>) => {
    void navigate({ search: { ...parsed, ...patch } } as never);
  };
  return update;
}

/* ------------------------------------------------------------------ */
/* Tickets list                                                        */
/* ------------------------------------------------------------------ */
export function TicketsSection() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const parsed = parseListSearch(rawSearch);
  const updateSearch = useListSearchControls(parsed);
  const goTo = useGoTo();
  const [createOpen, setCreateOpen] = useState(
    rawSearch.new === "1" || rawSearch.new === 1,
  );
  const prefillCustomer =
    typeof rawSearch.customer === "string" ? rawSearch.customer : "";
  const statusFilter = typeof rawSearch.status === "string" ? rawSearch.status : "";
  const priorityFilter = typeof rawSearch.priority === "string" ? rawSearch.priority : "";
  const assigneeFilter =
    typeof rawSearch.assignee_user_id === "string" ? rawSearch.assignee_user_id : "";
  const customerFilter =
    typeof rawSearch.customer_id === "string" ? rawSearch.customer_id : "";
  const query = useAdminList<TicketDto>("tickets", "/api/v1/admin/tickets");
  const staffQuery = useAdminList<StaffUserDto>("staff-users", "/api/v1/admin/users");
  const customersQuery = useAdminList<CustomerDto>("customers", "/api/v1/admin/customers");

  const columns: ColumnDef<TicketDto, unknown>[] = [
    {
      accessorKey: "ticket_number",
      header: "Ticket",
      cell: ({ row }) => (
        <span>
          <span className="sm-mono">{row.original.ticket_number}</span>
          <CopyButton value={row.original.ticket_number} label="Copy ticket number" />
        </span>
      ),
    },
    {
      accessorKey: "title",
      header: "Title",
      cell: ({ row }) => row.original.title,
    },
    {
      accessorKey: "customer",
      header: "Customer",
      cell: ({ row }) => row.original.customer?.name ?? "—",
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

  const filtered = (query.data ?? []).filter((t) => {
    if (statusFilter && t.status !== statusFilter) return false;
    if (priorityFilter && t.priority !== priorityFilter) return false;
    if (assigneeFilter && t.assignee_user_id !== assigneeFilter) return false;
    if (customerFilter && t.customer_id !== customerFilter) return false;
    return true;
  });

  return (
    <section aria-labelledby="tickets-heading">
      <PageHeader
        breadcrumb={[{ label: "Support" }, { label: "Support Tickets" }]}
        title="Support Tickets"
        help="Issues customers report by phone, email or WhatsApp, tracked to resolution"
        action={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Create ticket
          </Button>
        }
      />
      <ListTable<TicketDto>
        columns={columns}
        data={filtered}
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
        emptyIcon={LifeBuoy}
        emptyTitle="No tickets yet"
        emptyBody="Support tickets appear here once staff create one."
        toolbar={
          <>
            <Select
              value={statusFilter}
              onChange={(e) =>
                updateSearch({ status: e.target.value === "" ? undefined : e.target.value, page: 1 })
              }
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
            <Select
              value={priorityFilter}
              onChange={(e) =>
                updateSearch({ priority: e.target.value === "" ? undefined : e.target.value, page: 1 })
              }
              aria-label="Filter by priority"
            >
              <option value="">All priorities</option>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
            <Select
              value={assigneeFilter}
              onChange={(e) =>
                updateSearch({
                  assignee_user_id: e.target.value === "" ? undefined : e.target.value,
                  page: 1,
                })
              }
              aria-label="Filter by assignee"
            >
              <option value="">All assignees</option>
              {(staffQuery.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {staffOptionLabel(u)}
                </option>
              ))}
            </Select>
            <Select
              value={customerFilter}
              onChange={(e) =>
                updateSearch({
                  customer_id: e.target.value === "" ? undefined : e.target.value,
                  page: 1,
                })
              }
              aria-label="Filter by customer"
            >
              <option value="">All customers</option>
              {(customersQuery.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </>
        }
        getRowId={(row) => row.id}
      />
      {createOpen ? (
        <CreateTicketDialog
          prefillCustomerId={prefillCustomer}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            goTo(`/tickets/${id}`);
          }}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Create ticket                                                       */
/* ------------------------------------------------------------------ */
interface LinkOption {
  id: string;
  label: string;
  customer_id?: string | null;
  product_id?: string | null;
}

function CreateTicketDialog({
  prefillCustomerId,
  onClose,
  onCreated,
}: {
  prefillCustomerId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [customerId, setCustomerId] = useState(prefillCustomerId);
  const [priority, setPriority] = useState<TicketDto["priority"]>("medium");
  const [category, setCategory] = useState<TicketDto["category"]>("other");
  const [assigneeId, setAssigneeId] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [orderId, setOrderId] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [licenseId, setLicenseId] = useState("");
  const [productId, setProductId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const customersQuery = useAdminList<CustomerDto>("customers", "/api/v1/admin/customers");
  const staffQuery = useAdminList<StaffUserDto>("staff-users", "/api/v1/admin/users");
  const ordersQuery = useAdminList<LinkOption & { customer_id: string }>(
    "orders",
    "/api/v1/admin/orders",
  );
  const subsQuery = useAdminList<
    LinkOption & { subscription_number: string; customer_id: string; product_id: string }
  >("subscriptions", "/api/v1/admin/subscriptions");
  const licensesQuery = useAdminList<
    LinkOption & { license_number: string; customer_id: string; product_id: string }
  >("licenses", "/api/v1/admin/licenses");
  const productsQuery = useAdminList<LinkOption & { name: string }>(
    "products",
    "/api/v1/admin/products",
  );

  const mutation = useAdminMutation<TicketDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<TicketDto>("/api/v1/admin/tickets", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("tickets")],
    successTitle: "Ticket created",
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (title.trim().length < 3) next.title = "Title must be at least 3 characters.";
    if (description.trim().length < 3) next.description = "Describe the issue.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    mutation.mutate(
      {
        title: title.trim(),
        description: description.trim(),
        ...(customerId ? { customer_id: customerId } : {}),
        priority,
        category,
        ...(assigneeId ? { assignee_user_id: assigneeId } : {}),
        ...(sourceNote.trim() ? { source_note: sourceNote.trim() } : {}),
        ...(orderId ? { order_id: orderId } : {}),
        ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
        ...(licenseId ? { license_id: licenseId } : {}),
        ...(productId ? { product_id: productId } : {}),
      },
      {
        onSuccess: (data) => onCreated(data.id),
        onError: (err) =>
          setFormError(err instanceof Error ? err.message : "Could not create the ticket."),
      },
    );
  };

  // Auto-fill (owner 2026-11-17): picking an order assigns its
  // customer; picking a subscription/license assigns its customer AND
  // product. The API enforces the same rules server-side.
  const onOrderChange = (id: string) => {
    setOrderId(id);
    if (id) {
      const order = (ordersQuery.data ?? []).find((o) => o.id === id);
      if (order?.customer_id) setCustomerId(order.customer_id);
    }
  };
  const onSubscriptionChange = (id: string) => {
    setSubscriptionId(id);
    if (id) {
      const sub = (subsQuery.data ?? []).find((s) => s.id === id);
      if (sub) {
        if (sub.customer_id) setCustomerId(sub.customer_id);
        if (sub.product_id) setProductId(sub.product_id);
      }
    }
  };
  const onLicenseChange = (id: string) => {
    setLicenseId(id);
    if (id) {
      const lic = (licensesQuery.data ?? []).find((l) => l.id === id);
      if (lic) {
        if (lic.customer_id) setCustomerId(lic.customer_id);
        if (lic.product_id) setProductId(lic.product_id);
      }
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create ticket"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="create-ticket-form"
            loading={mutation.isPending}
          >
            Create ticket
          </Button>
        </>
      }
    >
      <form id="create-ticket-form" onSubmit={onSubmit} aria-label="Create ticket">
        {formError ? <Alert variant="danger">{formError}</Alert> : null}
        <Field label="Title" required error={errors.title ?? ""}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="e.g. License stopped working after renewal"
          />
        </Field>
        <Field label="Description" required error={errors.description ?? ""}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={5000}
            placeholder="What the customer reported, and what you have checked so far."
          />
        </Field>
        <Field label="Customer">
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Unlinked</option>
            {(customersQuery.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.email ? ` — ${c.email}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TicketDto["priority"])}
          >
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category">
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as TicketDto["category"])}
          >
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assignee">
          <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Unassigned</option>
            {(staffQuery.data ?? [])
              .filter((u) => u.status === "active")
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {staffOptionLabel(u)}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Source note" hint="How the customer reported it — phone, email, WhatsApp.">
          <Input
            value={sourceNote}
            onChange={(e) => setSourceNote(e.target.value)}
            maxLength={300}
            placeholder="e.g. Reported on WhatsApp, 15/11/2026"
          />
        </Field>
        <CollapsibleSection title="Linked records (optional)">
          <Field
            label="Order"
            hint="Picking an order sets the ticket's customer from that order."
          >
            <Select value={orderId} onChange={(e) => onOrderChange(e.target.value)}>
              <option value="">None</option>
              {(ordersQuery.data ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {(o as unknown as { order_number: string }).order_number}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Subscription"
            hint="Picking a subscription sets the customer and product from it."
          >
            <Select
              value={subscriptionId}
              onChange={(e) => onSubscriptionChange(e.target.value)}
            >
              <option value="">None</option>
              {(subsQuery.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.subscription_number}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="License"
            hint="Picking a license sets the customer and product from it."
          >
            <Select value={licenseId} onChange={(e) => onLicenseChange(e.target.value)}>
              <option value="">None</option>
              {(licensesQuery.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.license_number}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Product">
            <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">None</option>
              {(productsQuery.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </CollapsibleSection>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Ticket detail                                                       */
/* ------------------------------------------------------------------ */
export function TicketDetailSection({ id }: { id: string }) {
  const goTo = useGoTo();
  const [commentBody, setCommentBody] = useState("");
  const [commentInternal, setCommentInternal] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [transitionNote, setTransitionNote] = useState("");
  const query = useAdminDetail<TicketDetailDto>("tickets", id, `/api/v1/admin/tickets/${id}`);
  const staffQuery = useAdminList<StaffUserDto>("staff-users", "/api/v1/admin/users");

  const transitionMutation = useAdminMutation<TicketDetailDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<TicketDetailDto>(`/api/v1/admin/tickets/${id}/transition`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("tickets"), detailKey("tickets", id)],
    successTitle: "Ticket status updated",
  });
  const assignMutation = useAdminMutation<TicketDetailDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<TicketDetailDto>(`/api/v1/admin/tickets/${id}/assign`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("tickets"), detailKey("tickets", id)],
    successTitle: "Ticket assigned",
  });
  const commentMutation = useAdminMutation<TicketCommentDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<TicketCommentDto>(`/api/v1/admin/tickets/${id}/comments`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [detailKey("tickets", id)],
    successTitle: "Comment added",
    onSuccess: () => {
      setCommentBody("");
      setCommentInternal(false);
    },
  });

  if (query.isPending) {
    return (
      <section aria-labelledby="ticket-heading">
        <PageHeader
          breadcrumb={[{ label: "Support Tickets", href: "/tickets" }, { label: "…" }]}
          title="Ticket"
        />
        <TableSkeleton rows={5} />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section aria-labelledby="ticket-heading">
        <PageHeader
          breadcrumb={[{ label: "Support Tickets", href: "/tickets" }, { label: "Ticket" }]}
          title="Ticket"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={
              query.error instanceof Error ? query.error.message : "Could not load this ticket."
            }
            onRetry={() => void query.refetch()}
          />
        </div>
      </section>
    );
  }

  const ticket = query.data;
  const nextStatuses = NEXT_STATUSES[ticket.status];

  const onTransition = (status: TicketDto["status"]) => {
    transitionMutation.mutate({
      status,
      ...(transitionNote.trim() ? { note: transitionNote.trim() } : {}),
    });
  };

  const onComment = (e: FormEvent) => {
    e.preventDefault();
    if (commentBody.trim().length < 1) {
      setCommentError("Write a comment first.");
      return;
    }
    setCommentError(null);
    commentMutation.mutate({
      body: commentBody.trim(),
      is_internal: commentInternal,
    });
  };

  return (
    <section aria-labelledby="ticket-heading">
      <PageHeader
        breadcrumb={[
          { label: "Support Tickets", href: "/tickets" },
          { label: ticket.ticket_number },
        ]}
        title={ticket.title}
        subtitle={`${ticket.ticket_number} · ${ticket.category}`}
      />
      <DetailLayout
        title="Ticket"
        facts={[
          { label: "Status", value: <StatusBadge status={ticket.status} /> },
          { label: "Priority", value: ticket.priority },
          { label: "Category", value: ticket.category },
          {
            label: "Customer",
            value: ticket.customer ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => goTo(`/customers/${ticket.customer!.id}`)}
              >
                {ticket.customer.name}
              </Button>
            ) : (
              "Unlinked"
            ),
          },
          { label: "Reporter", value: ticket.reporter_name ?? "—" },
          {
            label: "Assignee",
            value: ticket.assignee_name
              ? `${ticket.assignee_name} — ${ticket.assignee_email ?? ""}${
                  (ticket.assignee_roles ?? []).length > 0
                    ? ` (${(ticket.assignee_roles ?? []).map((r) => humanizeType(r)).join(", ")})`
                    : ""
                }`
              : "Unassigned",
          },
          { label: "Source", value: ticket.source_note ?? "—" },
          { label: "Created", value: <DateTimeCell value={ticket.created_at} /> },
          ...(ticket.resolved_at
            ? [{ label: "Resolved", value: <DateTimeCell value={ticket.resolved_at} /> }]
            : []),
          ...(ticket.closed_at
            ? [{ label: "Closed", value: <DateTimeCell value={ticket.closed_at} /> }]
            : []),
        ]}
      >
        <Card title="Description">
          <p>{ticket.description}</p>
        </Card>
        <Card title="Status">
          <DetailFacts
            facts={[
              {
                label: "Move to",
                value: (
                  <span>
                    {nextStatuses.map((s) => (
                      <span key={s} style={{ marginRight: 8 }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={transitionMutation.isPending}
                          onClick={() => onTransition(s)}
                        >
                          {s === "open" ? "Reopen" : s.replace(/_/g, " ")}
                        </Button>
                      </span>
                    ))}
                  </span>
                ),
              },
              {
                label: "Assignee",
                value: (
                  // MenuSelect, not the native Select: the native popup
                  // is OS-rendered and never opened on click in the
                  // user's extension-driven browser (live defect
                  // 2026-11-17). The assign endpoint itself already
                  // exists (POST /tickets/:id/assign, tickets.manage).
                  <MenuSelect
                    value={ticket.assignee_user_id ?? ""}
                    onChange={(v) =>
                      assignMutation.mutate({
                        assignee_user_id: v === "" ? null : v,
                      })
                    }
                    options={[
                      { value: "", label: "Unassigned" },
                      ...(staffQuery.data ?? [])
                        .filter((u) => u.status === "active")
                        .map((u) => ({ value: u.id, label: staffOptionLabel(u) })),
                    ]}
                    placeholder="Unassigned"
                    disabled={assignMutation.isPending}
                    ariaLabel="Assign ticket"
                  />
                ),
              },
            ]}
          />
          <Field label="Note on this status change (optional — saved as an internal comment)">
            <Input
              value={transitionNote}
              onChange={(e) => setTransitionNote(e.target.value)}
              maxLength={2000}
              placeholder="e.g. Customer confirmed the fix works"
            />
          </Field>
        </Card>
        {(ticket.linked.order ||
          ticket.linked.subscription ||
          ticket.linked.license ||
          ticket.linked.product) && (
          <Card title="Linked records">
            <DetailFacts
              facts={[
                ...(ticket.linked.order
                  ? [
                      {
                        label: "Order",
                        value: (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => goTo(`/orders/${ticket.linked.order!.id}`)}
                          >
                            {ticket.linked.order.order_number}
                          </Button>
                        ),
                      },
                    ]
                  : []),
                ...(ticket.linked.subscription
                  ? [
                      {
                        label: "Subscription",
                        value: (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              goTo(`/subscriptions/${ticket.linked.subscription!.id}`)
                            }
                          >
                            {ticket.linked.subscription.subscription_number}
                          </Button>
                        ),
                      },
                    ]
                  : []),
                ...(ticket.linked.license
                  ? [
                      {
                        label: "License",
                        value: (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => goTo(`/licenses/${ticket.linked.license!.id}`)}
                          >
                            {ticket.linked.license.license_number}
                          </Button>
                        ),
                      },
                    ]
                  : []),
                ...(ticket.linked.product
                  ? [
                      {
                        label: "Product",
                        value: (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => goTo(`/products/${ticket.linked.product!.id}`)}
                          >
                            {ticket.linked.product.name}
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </Card>
        )}
        <Card title={`Comments (${ticket.comments.length})`}>
          {ticket.comments.length === 0 ? (
            <EmptyState
              icon={LifeBuoy}
              title="No comments yet"
              body="Updates on this ticket will appear here."
            />
          ) : (
            <div className="sm-table-wrap">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Author</th>
                    <th scope="col">Comment</th>
                    <th scope="col">Visibility</th>
                  </tr>
                </thead>
                <tbody>
                  {ticket.comments.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <DateTimeCell value={c.created_at} />
                      </td>
                      <td>{c.author_name ?? "—"}</td>
                      <td>{c.body}</td>
                      <td>{c.is_internal ? "Internal" : "Shared"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form onSubmit={onComment} style={{ marginTop: 16 }} aria-label="Add a comment">
            {commentError ? <Alert variant="danger">{commentError}</Alert> : null}
            <Field label="Add a comment">
              <Textarea
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                maxLength={5000}
                placeholder="Update, question, or resolution note…"
              />
            </Field>
            <Checkbox
              label="Internal only (not shared with the customer)"
              checked={commentInternal}
              onChange={(e) => setCommentInternal(e.target.checked)}
            />
            <div style={{ marginTop: 12 }}>
              <Button
                variant="accent"
                type="submit"
                loading={commentMutation.isPending}
              >
                Add comment
              </Button>
            </div>
          </form>
        </Card>
      </DetailLayout>
    </section>
  );
}
