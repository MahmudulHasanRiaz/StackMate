/**
 * Leads — list + detail + manual create + convert (ADR-0009).
 *
 * Routes (router.tsx): /leads, /leads/$leadId.
 * Endpoints (apps/api/src/app.ts):
 *  - GET  /api/v1/admin/leads                          leads.view
 *         (?status=&source_site_id=&utm_campaign=&from=&to=&q=)
 *  - POST /api/v1/admin/leads                          leads.manage
 *  - GET  /api/v1/admin/leads/:id                      leads.view
 *  - PATCH /api/v1/admin/leads/:id                     leads.manage
 *  - POST /api/v1/admin/leads/:id/transition           leads.manage
 *  - POST /api/v1/admin/leads/:id/assign               leads.manage
 *  - POST /api/v1/admin/leads/:id/convert              leads.manage
 *         (resolves/creates the customer via the §1 dedupe rules and
 *         returns it; the lead itself is marked converted only when
 *         the order is created with lead_id)
 *  - POST /api/v1/integrations/sites/:siteKey/leads    S2S HMAC,
 *         scope leads.create (the main source — connected websites)
 *
 * Server-side tracking: every lead capture emits a Lead tracking event
 * into the existing pipeline (visible in Administration → Tracking
 * Events). Meta CAPI real delivery is a known stub — the event is
 * recorded + queued, never claimed as delivered.
 *
 * Status flow (enforced server-side, 409 otherwise):
 *   new → contacted → qualified → converted / lost.
 * Converting never deletes the lead — history stays.
 */
import { useState, type FormEvent, useMemo} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, UserPlus } from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { detailKey, listKey } from "../lib/query";
import {
  DetailFacts,
  DetailLayout,
  ListTable,
  PageHeader,
  detailLabelResolver,
  loadListOptions,
  parseListSearch,
  useAdminDetail,
  useAdminList,
  useAdminMutation,
  type ListSearch,
  useIdempotencyKey,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  CopyButton,
  DateTimeCell,
  Dialog,
  ErrorState,
  Field,
  Input,
  SearchableSelect,
  Select,
  StatusBadge,
  TableSkeleton,
  type SearchableOption,
  Textarea,
} from "../components/primitives";
import type { CustomerDto } from "./customers";
import type { StaffUserDto } from "./tickets";
import { humanizeType } from "../lib/resolve-names";

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */
export interface LeadDto {
  id: string;
  lead_number: string;
  name: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  source_site_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  interest: string | null;
  product_id: string | null;
  message: string | null;
  notes: string | null;
  status: "new" | "contacted" | "qualified" | "converted" | "lost";
  assignee_user_id: string | null;
  created_at: string;
  updated_at: string;
  converted_at: string | null;
  converted_customer_id: string | null;
  converted_order_id: string | null;
  source_site?: { id: string; name: string } | null;
  assignee_name?: string | null;
}

interface LeadDetailDto extends LeadDto {
  product?: { id: string; name: string } | null;
  converted_customer?: CustomerDto | null;
  converted_order?: { id: string; order_number: string } | null;
}

interface IntegratedSiteOption {
  id: string;
  name: string;
}

interface ProductOption {
  id: string;
  name: string;
}

const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;

/** Allowed next statuses from each status (mirrors the API map). */
const NEXT_STATUSES: Record<LeadDto["status"], LeadDto["status"][]> = {
  new: ["contacted", "lost"],
  contacted: ["qualified", "lost"],
  qualified: ["converted", "lost"],
  converted: [],
  lost: ["new"],
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
/* Leads list                                                          */
/* ------------------------------------------------------------------ */
export function LeadsSection() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const parsed = parseListSearch(rawSearch);
  const updateSearch = useListSearchControls(parsed);
  const goTo = useGoTo();
  const [createOpen, setCreateOpen] = useState(false);
  const statusFilter = typeof rawSearch.status === "string" ? rawSearch.status : "";
  const siteFilter =
    typeof rawSearch.source_site_id === "string" ? rawSearch.source_site_id : "";
  const campaignFilter =
    typeof rawSearch.utm_campaign === "string" ? rawSearch.utm_campaign : "";
  const fromFilter = typeof rawSearch.from === "string" ? rawSearch.from : "";
  const toFilter = typeof rawSearch.to === "string" ? rawSearch.to : "";
  const query = useAdminList<LeadDto>("leads", "/api/v1/admin/leads", {
    q: parsed.q,
    page: parsed.page,
    pageSize: parsed.pageSize,
    // Server-side: the endpoint reads ?status=, ?source_site_id=,
    // ?utm_campaign=, ?from= and ?to= (created-date range, same
    // inclusive day comparison as the client memo below).
    extra: {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(siteFilter ? { source_site_id: siteFilter } : {}),
      ...(campaignFilter ? { utm_campaign: campaignFilter } : {}),
      ...(fromFilter ? { from: fromFilter } : {}),
      ...(toFilter ? { to: toFilter } : {}),
    },
  });

  const columns: ColumnDef<LeadDto, unknown>[] = useMemo(
    () => [
      {
        accessorKey: "lead_number",
        header: "Lead",
        cell: ({ row }) => (
          <span>
            <span className="sm-mono">{row.original.lead_number}</span>
            <CopyButton value={row.original.lead_number} label="Copy lead number" />
          </span>
        ),
      },
      {
        accessorKey: "name",
        header: "Contact",
        cell: ({ row }) => {
          const l = row.original;
          return (
            <span className="sm-cell-line">
              <span className="sm-cell-text">{l.name}</span>
              <span className="sm-hint sm-cell-text">
                {l.email ?? l.phone ?? "No contact"}
              </span>
            </span>
          );
        },
      },
      {
        accessorKey: "interest",
        header: "Interest",
        cell: ({ row }) => row.original.interest ?? "—",
      },
      {
        accessorKey: "source_site",
        header: "Source",
        cell: ({ row }) => row.original.source_site?.name ?? "Manual",
      },
      {
        accessorKey: "utm_campaign",
        header: "Campaign",
        cell: ({ row }) => row.original.utm_campaign ?? "—",
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: "assignee_name",
        header: "Assignee",
        cell: ({ row }) => row.original.assignee_name ?? "Unassigned",
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
          <Button variant="ghost" size="sm" onClick={() => goTo(`/leads/${row.original.id}`)}>
            View
          </Button>
        ),
      },
  ],
    [goTo],
  )

  const filtered = (query.data ?? []).filter((l) => {
    if (statusFilter && l.status !== statusFilter) return false;
    if (siteFilter && l.source_site_id !== siteFilter) return false;
    if (campaignFilter && l.utm_campaign !== campaignFilter) return false;
    if (fromFilter && l.created_at.slice(0, 10) < fromFilter) return false;
    if (toFilter && l.created_at.slice(0, 10) > toFilter) return false;
    return true;
  });

  return (
    <section aria-labelledby="leads-heading">
      <PageHeader
        breadcrumb={[{ label: "Commerce" }, { label: "Leads" }]}
        title="Leads"
        help="People who showed interest on a connected website or were added by staff"
        action={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Add lead
          </Button>
        }
      />
      <ListTable<LeadDto>
        columns={columns}
        data={filtered}
        serverSearch
        serverPagination
        refreshSection="leads"
        filtersActive={
          statusFilter !== "" ||
          siteFilter !== "" ||
          campaignFilter !== "" ||
          fromFilter !== "" ||
          toFilter !== ""
        }
        total={query.total}
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
        emptyIcon={UserPlus}
        emptyTitle="No leads yet"
        emptyBody="Leads arrive from connected websites, or add one manually."
        toolbar={
          <>
            <Select
              id="leads-status-filter"
              name="status"
              value={statusFilter}
              onChange={(e) =>
                updateSearch({ status: e.target.value === "" ? undefined : e.target.value, page: 1 })
              }
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {LEAD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanizeType(s)}
                </option>
              ))}
            </Select>
            {/* Searchable (PLAN §29): integrated sites are unbounded.
               Status (5) stays a native select (fixed-enum exception). */}
            <SearchableSelect
              id="leads-site-filter"
              value={siteFilter}
              onChange={(v) =>
                updateSearch({
                  source_site_id: v === "" ? undefined : v,
                  page: 1,
                })
              }
              loadOptions={(q, signal) =>
                loadListOptions<IntegratedSiteOption>(
                  "/api/v1/admin/integrated-sites",
                  q,
                  (s) => ({ value: s.id, label: s.name }),
                  signal,
                )
              }
              resolveLabel={detailLabelResolver<IntegratedSiteOption>(
                (id) => `/api/v1/admin/integrated-sites/${id}`,
                (s) => s.name,
              )}
              leadingOptions={[{ value: "", label: "All sources" }]}
              placeholder="All sources"
              ariaLabel="Filter by source website"
            />
            <Input
              id="leads-campaign-filter"
              name="utm_campaign"
              value={campaignFilter}
              onChange={(e) =>
                updateSearch({
                  utm_campaign: e.target.value === "" ? undefined : e.target.value,
                  page: 1,
                })
              }
              placeholder="Campaign"
              aria-label="Filter by campaign"
              autoComplete="off"
            />
            <Input
              id="leads-from-filter"
              name="from"
              value={fromFilter}
              onChange={(e) =>
                updateSearch({ from: e.target.value === "" ? undefined : e.target.value, page: 1 })
              }
              placeholder="From (YYYY-MM-DD)"
              aria-label="Filter from date"
              autoComplete="off"
            />
            <Input
              id="leads-to-filter"
              name="to"
              value={toFilter}
              onChange={(e) =>
                updateSearch({ to: e.target.value === "" ? undefined : e.target.value, page: 1 })
              }
              placeholder="To (YYYY-MM-DD)"
              aria-label="Filter to date"
              autoComplete="off"
            />
          </>
        }
        getRowId={(row) => row.id}
      />
      {createOpen ? (
        <CreateLeadDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            goTo(`/leads/${id}`);
          }}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Manual create (the main source is the website ingestion API)        */
/* ------------------------------------------------------------------ */
function CreateLeadDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [interest, setInterest] = useState("");
  const [productId, setProductId] = useState("");
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

    const mutationKey = useIdempotencyKey();
const mutation = useAdminMutation<LeadDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<LeadDto>("/api/v1/admin/leads", {
        method: "POST", idempotencyKey: mutationKey,
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("leads")],
    successTitle: "Lead added",
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next.name = "Name must be at least 2 characters.";
    if (email.trim() === "" && phone.trim() === "") {
      next.email = "At least one of email or phone is required.";
      next.phone = "At least one of email or phone is required.";
    }
    if (email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      next.email = "Enter a valid email address.";
    }
    if (phone.trim() !== "" && phone.trim().length < 6) {
      next.phone = "Phone must be at least 6 characters.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    mutation.mutate(
      {
        name: name.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(whatsapp.trim() ? { whatsapp: whatsapp.trim() } : {}),
        ...(interest.trim() ? { interest: interest.trim() } : {}),
        ...(productId ? { product_id: productId } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      {
        onSuccess: (data) => onCreated(data.id),
        onError: (err) =>
          setFormError(err instanceof Error ? err.message : "Could not add the lead."),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add lead"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            type="submit"
            form="create-lead-form"
            loading={mutation.isPending}
          >
            Add lead
          </Button>
        </>
      }
    >
      <form id="create-lead-form" onSubmit={onSubmit} aria-label="Add lead">
        {formError ? <Alert variant="danger">{formError}</Alert> : null}
        <p className="sm-hint">
          Manual entry — most leads arrive automatically from connected
          websites. A Lead tracking event is recorded for every capture.
        </p>
        <Field label="Name" required htmlFor="lead-name" error={errors.name ?? ""}>
          <Input id="lead-name" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Email" htmlFor="lead-email" error={errors.email ?? ""}>
          <Input
            id="lead-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label="Phone" htmlFor="lead-phone" error={errors.phone ?? ""}>
          <Input
            id="lead-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={40}
          />
        </Field>
        <Field label="WhatsApp" htmlFor="lead-whatsapp">
          <Input
            id="lead-whatsapp"
            name="whatsapp"
            type="tel"
            autoComplete="tel"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            maxLength={40}
          />
        </Field>
        <Field label="Interest" htmlFor="lead-interest" hint="What product or service they are interested in.">
          <Input id="lead-interest" name="interest" value={interest} onChange={(e) => setInterest(e.target.value)} maxLength={300} />
        </Field>
        <Field label="Product" htmlFor="lead-product">
          {/* Searchable (PLAN §29): products are unbounded. */}
          <SearchableSelect
            id="lead-product"
            value={productId}
            onChange={(v) => setProductId(v)}
            loadOptions={(q, signal) =>
              loadListOptions<ProductOption>(
                "/api/v1/admin/products",
                q,
                (p) => ({ value: p.id, label: p.name }),
                signal,
              )
            }
            leadingOptions={[{ value: "", label: "None" }]}
            placeholder="None"
            ariaLabel="Product"
          />
        </Field>
        <Field label="Message" htmlFor="lead-message">
          <Textarea id="lead-message" name="message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} />
        </Field>
        <Field label="Notes" htmlFor="lead-notes">
          <Textarea id="lead-notes" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
        </Field>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Lead detail — status, assignee, convert to order                    */
/* ------------------------------------------------------------------ */
export function LeadDetailSection({ id }: { id: string }) {
  const goTo = useGoTo();
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const query = useAdminDetail<LeadDetailDto>("leads", id, `/api/v1/admin/leads/${id}`);

    const transitionMutationKey = useIdempotencyKey();
const transitionMutation = useAdminMutation<LeadDetailDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<LeadDetailDto>(`/api/v1/admin/leads/${id}/transition`, {
        method: "POST", idempotencyKey: transitionMutationKey,
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("leads"), detailKey("leads", id)],
    successTitle: "Lead status updated",
  });
    const assignMutationKey = useIdempotencyKey();
const assignMutation = useAdminMutation<LeadDetailDto, Record<string, unknown>>({
    mutationFn: (body) =>
      apiRequest<LeadDetailDto>(`/api/v1/admin/leads/${id}/assign`, {
        method: "POST", idempotencyKey: assignMutationKey,
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("leads"), detailKey("leads", id)],
    successTitle: "Lead assigned",
  });

  if (query.isPending) {
    return (
      <section aria-labelledby="lead-heading">
        <PageHeader
          breadcrumb={[{ label: "Leads", href: "/leads" }, { label: "…" }]}
          title="Lead"
        />
        <TableSkeleton rows={5} />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section aria-labelledby="lead-heading">
        <PageHeader
          breadcrumb={[{ label: "Leads", href: "/leads" }, { label: "Lead" }]}
          title="Lead"
        />
        <div className="sm-table-wrap">
          <ErrorState
            message={
              query.error instanceof Error ? query.error.message : "Could not load this lead."
            }
            onRetry={() => void query.refetch()}
          />
        </div>
      </section>
    );
  }

  const lead = query.data;
  const nextStatuses = NEXT_STATUSES[lead.status];
  const canConvert = lead.status !== "converted" && lead.status !== "lost";

  // A-04: one key per detail instance — a retried convert replays
  // instead of creating a second customer.
  const convertKey = useIdempotencyKey();
  const onConvert = async () => {
    setConvertError(null);
    setConverting(true);
    try {
      const res = await apiRequest<{ lead: LeadDto; customer: CustomerDto }>(
        `/api/v1/admin/leads/${id}/convert`,
        { method: "POST", body: JSON.stringify({}), idempotencyKey: convertKey },
      );
      // The wizard opens with the resolved customer prefilled; the
      // lead is marked converted only when the order is created.
      // The lead's linked product / interest travel in the URL so the
      // wizard can prefill them (audit L-16).
      const extra = new URLSearchParams();
      if (res.lead.product_id) extra.set("product", res.lead.product_id);
      if (res.lead.interest) extra.set("interest", res.lead.interest);
      const suffix = extra.toString() ? `&${extra.toString()}` : "";
      goTo(`/orders?new=1&customer=${res.customer.id}&lead=${lead.id}${suffix}`);
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : "Could not convert the lead.");
    } finally {
      setConverting(false);
    }
  };

  return (
    <section aria-labelledby="lead-heading">
      <PageHeader
        breadcrumb={[{ label: "Leads", href: "/leads" }, { label: lead.lead_number }]}
        title={lead.name}
        subtitle={`${lead.lead_number} · ${humanizeType(lead.status)}`}
        action={
          canConvert ? (
            <Button variant="primary" icon={UserPlus} loading={converting} onClick={() => void onConvert()}>
              Convert to order
            </Button>
          ) : null
        }
      />
      {convertError ? (
        <div style={{ marginBottom: 16 }}>
          <Alert variant="danger">{convertError}</Alert>
        </div>
      ) : null}
      <DetailLayout
        title="Lead"
        facts={[
          { label: "Status", value: <StatusBadge status={lead.status} /> },
          { label: "Email", value: lead.email ?? "—" },
          { label: "Phone", value: lead.phone ?? "—" },
          { label: "WhatsApp", value: lead.whatsapp ?? "—" },
          { label: "Interest", value: lead.interest ?? "—" },
          { label: "Product", value: lead.product?.name ?? "—" },
          { label: "Source", value: lead.source_site?.name ?? "Manual" },
          { label: "Campaign", value: lead.utm_campaign ?? "—" },
          {
            label: "UTM",
            value: [lead.utm_source, lead.utm_medium].filter(Boolean).join(" / ") || "—",
          },
          { label: "Assignee", value: lead.assignee_name ?? "Unassigned" },
          { label: "Created", value: <DateTimeCell value={lead.created_at} /> },
          ...(lead.converted_at
            ? [
                {
                  label: "Converted",
                  value: <DateTimeCell value={lead.converted_at} />,
                },
                {
                  label: "Customer",
                  value: lead.converted_customer ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => goTo(`/customers/${lead.converted_customer!.id}`)}
                    >
                      {lead.converted_customer.name}
                    </Button>
                  ) : (
                    "—"
                  ),
                },
                {
                  label: "Order",
                  value: lead.converted_order ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => goTo(`/orders/${lead.converted_order!.id}`)}
                    >
                      {lead.converted_order.order_number}
                    </Button>
                  ) : (
                    "—"
                  ),
                },
              ]
            : []),
        ]}
      >
        {lead.message ? (
          <DetailFacts facts={[{ label: "Message", value: lead.message }]} />
        ) : null}
        {lead.notes ? (
          <DetailFacts facts={[{ label: "Notes", value: lead.notes }]} />
        ) : null}
        <DetailFacts
          facts={[
            {
              label: "Move to",
              value:
                nextStatuses.length > 0 ? (
                  <span>
                    {nextStatuses.map((s) => (
                      <span key={s} style={{ marginRight: 8 }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={transitionMutation.isPending}
                          onClick={() => transitionMutation.mutate({ status: s })}
                        >
                          {s.replace(/_/g, " ")}
                        </Button>
                      </span>
                    ))}
                  </span>
                ) : (
                  "No further transitions."
                ),
            },
            {
              label: "Assignee",
              value: (
                /* Searchable (PLAN §29): staff grows; only active staff
                   are offered (status=active is a server param now).
                   The current assignee label comes from the lead detail. */
                <SearchableSelect
                  id="lead-assignee"
                  value={lead.assignee_user_id ?? ""}
                  onChange={(v) =>
                    assignMutation.mutate({
                      assignee_user_id: v === "" ? null : v,
                    })
                  }
                  loadOptions={(q, signal) =>
                    loadListOptions<StaffUserDto>(
                      "/api/v1/admin/users",
                      q,
                      (u) => ({ value: u.id, label: u.name, data: u }),
                      signal,
                      { extra: { status: "active" } },
                    )
                  }
                  selectedLabel={lead.assignee_name ?? undefined}
                  leadingOptions={[{ value: "", label: "Unassigned" }]}
                  placeholder="Unassigned"
                  disabled={assignMutation.isPending}
                  ariaLabel="Assign lead"
                />
              ),
            },
          ]}
        />
        <p className="sm-hint">
          A Lead tracking event was recorded when this lead was captured
          (Administration → Tracking Events). Meta CAPI delivery is not live
          yet — the event is recorded and queued, never claimed as delivered.
        </p>
      </DetailLayout>
    </section>
  );
}
