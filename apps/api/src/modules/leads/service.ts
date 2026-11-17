/**
 * Lead Management (ADR-0009).
 *
 * Leads arrive from connected websites through the S2S HMAC ingestion
 * endpoint (same auth as the server checkout orders — scope
 * `leads.create`; there is NO `wpi_` Bearer scheme anywhere in the
 * codebase, so none was invented) or are entered manually by staff.
 * Contact rule mirrors customers: at least one of email/phone.
 *
 * Dedupe: the same normalized contact from the same site within 30 days
 * updates the existing lead instead of creating a duplicate (the update
 * refreshes message/notes/UTM fields; the original created_at is kept).
 *
 * Tracking: every lead CAPTURE (ingested or manual) emits a Lead tracking
 * event into the existing tracking pipeline (tracking_events row +
 * outbox `tracking.meta_capi.dispatch`). HONESTY: Meta CAPI real delivery
 * is a known stub — the event is recorded + queued through the real
 * pipeline and visible in Tracking Events; nothing here claims a Meta
 * delivery happened.
 *
 * Conversion: POST /convert resolves/creates the customer via the §1
 * dedupe rules and returns it; the lead is NOT marked converted yet. The
 * Create Order wizard opens with ?customer=<id>&lead=<id>, and order
 * creation with lead_id marks the lead converted (history stays).
 */
import { randomUUID } from "node:crypto";
import {
  AssignLeadSchema,
  CreateLeadSchema,
  IngestLeadSchema,
  LEAD_TRANSITIONS,
  TransitionLeadSchema,
  UpdateLeadSchema,
} from "../../../../../packages/contracts/src/index.ts";
import type {
  CustomerRecord,
  DatabaseState,
  IntegratedSiteRecord,
  LeadRecord,
  StackMateDataStore,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { normalizePhoneE164, resolveOrCreateCustomerInTx } from "../customers/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export const LEAD_DEDUPE_WINDOW_DAYS = 30;

export interface IngestLeadInput {
  name: string;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  whatsapp?: string | null | undefined;
  utm_source?: string | undefined;
  utm_medium?: string | undefined;
  utm_campaign?: string | undefined;
  interest?: string | undefined;
  product_id?: string | null | undefined;
  message?: string | undefined;
  notes?: string | undefined;
  fbp?: string | undefined;
  fbc?: string | undefined;
  event_source_url?: string | undefined;
}

function normalizeLeadEmail(email?: string | null): string | null {
  return email ? email.trim().toLowerCase() : null;
}

/** Find a lead with the same contact from the same site within the window. */
export function findDuplicateLead(
  state: DatabaseState,
  sourceSiteId: string | null,
  email: string | null,
  phone: string | null,
  now: Date
): LeadRecord | null {
  const normalizedEmail = normalizeLeadEmail(email);
  const normalizedPhone = normalizePhoneE164(phone);
  const windowStart = new Date(now.getTime() - LEAD_DEDUPE_WINDOW_DAYS * 86400000).toISOString();
  return (
    state.leads.find((l) => {
      if (l.source_site_id !== sourceSiteId) return false;
      if (l.created_at < windowStart) return false;
      if (l.status === "converted" || l.status === "lost") return false;
      const emailMatch = normalizedEmail !== null && l.normalized_email === normalizedEmail;
      const phoneMatch = normalizedPhone !== null && l.normalized_phone === normalizedPhone;
      return emailMatch || phoneMatch;
    }) ?? null
  );
}

/** Emit the Lead tracking event (recorded + queued; CAPI delivery is a stub). */
export function emitLeadTrackingEventInTx(
  state: DatabaseState,
  lead: LeadRecord,
  nowIso: string,
  opts: { fbp?: string | undefined; fbc?: string | undefined; eventSourceUrl?: string | undefined }
): void {
  if (!lead.source_site_id) return; // Manual leads have no site to attribute to.
  const trackId = randomUUID();
  state.tracking_events.push({
    id: trackId,
    integrated_site_id: lead.source_site_id,
    event_name: "Lead",
    event_id: `lead_${lead.id}`,
    event_time: nowIso,
    event_source_url: opts.eventSourceUrl ?? null,
    order_id: null,
    consent_state: "granted",
    consent_policy_version: "server-verified-v1",
    sanitized_payload: {
      lead_number: lead.lead_number,
      lead_id: lead.id,
      interest: lead.interest,
      product_id: lead.product_id,
      utm_source: lead.utm_source,
      utm_medium: lead.utm_medium,
      utm_campaign: lead.utm_campaign,
      fbp: opts.fbp ?? null,
      fbc: opts.fbc ?? null,
    },
    status: "queued",
    delivery_attempts: 0,
    delivered_at: null,
    created_at: nowIso,
  });
  state.outbox_events.push({
    id: randomUUID(),
    event_key: `meta_capi.lead:${lead.id}`,
    aggregate_type: "tracking_event",
    aggregate_id: trackId,
    event_type: "tracking.meta_capi.dispatch",
    payload: {
      tracking_event_id: trackId,
      event_name: "Lead",
      event_id: `lead_${lead.id}`,
      lead_number: lead.lead_number,
      interest: lead.interest,
      product_id: lead.product_id,
    },
    status: "pending",
    attempt_count: 0,
    available_at: nowIso,
    locked_until: null,
    locked_by: null,
    last_error_code: null,
    created_at: nowIso,
    processed_at: null,
  });
}

export interface IngestLeadResult {
  lead: LeadRecord;
  created: boolean;
  replayed: boolean;
}

/** In-transaction lead capture (ingestion + manual share this core). */
export function captureLeadInTx(
  state: DatabaseState,
  input: IngestLeadInput,
  sourceSiteId: string | null,
  now: Date
): IngestLeadResult {
  const nowIso = now.toISOString();
  const normalizedEmail = normalizeLeadEmail(input.email);
  const normalizedPhone = normalizePhoneE164(input.phone);

  const duplicate = findDuplicateLead(state, sourceSiteId, input.email ?? null, input.phone ?? null, now);
  if (duplicate) {
    // Dedupe window hit: refresh the mutable capture fields, keep history.
    if (input.message) duplicate.message = input.message;
    if (input.notes) duplicate.notes = input.notes;
    if (input.utm_source) duplicate.utm_source = input.utm_source;
    if (input.utm_medium) duplicate.utm_medium = input.utm_medium;
    if (input.utm_campaign) duplicate.utm_campaign = input.utm_campaign;
    if (input.interest) duplicate.interest = input.interest;
    if (input.product_id !== undefined) duplicate.product_id = input.product_id;
    if (input.whatsapp) duplicate.whatsapp = input.whatsapp.trim();
    duplicate.updated_at = nowIso;
    return { lead: duplicate, created: false, replayed: false };
  }

  if (input.product_id) {
    const product = state.products.find((p) => p.id === input.product_id);
    if (!product) throw new AppError("NOT_FOUND", "Linked product not found.", 404);
  }

  state.sequence_counters.lead += 1;
  const lead: LeadRecord = {
    id: randomUUID(),
    lead_number: `LEAD-${state.sequence_counters.lead}`,
    name: input.name.trim(),
    email: input.email ? input.email.trim() : null,
    normalized_email: normalizedEmail,
    phone: input.phone ? input.phone.trim() : null,
    normalized_phone: normalizedPhone,
    whatsapp: input.whatsapp ? input.whatsapp.trim() : null,
    source_site_id: sourceSiteId,
    utm_source: input.utm_source ?? null,
    utm_medium: input.utm_medium ?? null,
    utm_campaign: input.utm_campaign ?? null,
    interest: input.interest ?? null,
    product_id: input.product_id ?? null,
    message: input.message ?? null,
    notes: input.notes ?? null,
    status: "new",
    assignee_user_id: null,
    created_at: nowIso,
    updated_at: nowIso,
    converted_at: null,
    converted_customer_id: null,
    converted_order_id: null,
  };
  state.leads.push(lead);
  emitLeadTrackingEventInTx(state, lead, nowIso, {
    fbp: input.fbp,
    fbc: input.fbc,
    eventSourceUrl: input.event_source_url,
  });
  return { lead, created: true, replayed: false };
}

export async function ingestLead(
  store: StackMateDataStore,
  site: IntegratedSiteRecord,
  rawBody: unknown
): Promise<IngestLeadResult> {
  const input = IngestLeadSchema.parse(rawBody);
  return store.withTransaction((state) =>
    captureLeadInTx(state, input, site.id, new Date())
  );
}

export async function createLeadByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<LeadRecord> {
  assertStaffPermission(actor, "leads.manage");
  const input = CreateLeadSchema.parse(rawInput);
  const result = await store.withTransaction((state) => {
    const res = captureLeadInTx(state, input, input.source_site_id ?? null, new Date());
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: res.created ? "leads.lead.created" : "leads.lead.matched",
      resource_type: "lead",
      resource_id: res.lead.id,
      outcome: "success",
      request_id: requestId,
      changes: { lead_number: res.lead.lead_number, created: res.created },
    });
    return res;
  });
  return result.lead;
}

export async function updateLeadByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  leadId: string,
  rawInput: unknown,
  requestId: string
): Promise<LeadRecord> {
  assertStaffPermission(actor, "leads.manage");
  const input = UpdateLeadSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const lead = state.leads.find((l) => l.id === leadId);
    if (!lead) throw new AppError("NOT_FOUND", "Lead not found.", 404);
    const changes: Record<string, unknown> = {};
    if (input.name !== undefined) {
      lead.name = input.name.trim();
      changes.name = lead.name;
    }
    if (input.email !== undefined) {
      lead.email = input.email ? input.email.trim() : null;
      lead.normalized_email = normalizeLeadEmail(input.email);
      changes.email = lead.email;
    }
    if (input.phone !== undefined) {
      lead.phone = input.phone ? input.phone.trim() : null;
      lead.normalized_phone = normalizePhoneE164(input.phone);
      changes.phone = lead.phone;
    }
    if (input.whatsapp !== undefined) {
      lead.whatsapp = input.whatsapp ? input.whatsapp.trim() : null;
      changes.whatsapp = lead.whatsapp;
    }
    if (input.interest !== undefined) {
      lead.interest = input.interest ?? null;
      changes.interest = lead.interest;
    }
    if (input.product_id !== undefined) {
      lead.product_id = input.product_id;
      changes.product_id = lead.product_id;
    }
    if (input.message !== undefined) {
      lead.message = input.message ?? null;
      changes.message = lead.message;
    }
    if (input.notes !== undefined) {
      lead.notes = input.notes ?? null;
      changes.notes = lead.notes;
    }
    if (input.assignee_user_id !== undefined) {
      lead.assignee_user_id = input.assignee_user_id;
      changes.assignee_user_id = lead.assignee_user_id;
    }
    lead.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "leads.lead.updated",
      resource_type: "lead",
      resource_id: lead.id,
      outcome: "success",
      request_id: requestId,
      changes,
    });
    return lead;
  });
}

export async function transitionLeadByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  leadId: string,
  rawInput: unknown,
  requestId: string
): Promise<LeadRecord> {
  assertStaffPermission(actor, "leads.manage");
  const input = TransitionLeadSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const lead = state.leads.find((l) => l.id === leadId);
    if (!lead) throw new AppError("NOT_FOUND", "Lead not found.", 404);
    const allowed = LEAD_TRANSITIONS[lead.status];
    if (!allowed.includes(input.status)) {
      throw new AppError(
        "INVALID_LEAD_TRANSITION",
        `Cannot move a lead from ${lead.status} to ${input.status}.`,
        409
      );
    }
    const prev = lead.status;
    lead.status = input.status;
    lead.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "leads.lead.status_changed",
      resource_type: "lead",
      resource_id: lead.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_status: prev, to_status: lead.status },
    });
    return lead;
  });
}

export async function assignLeadByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  leadId: string,
  rawInput: unknown,
  requestId: string
): Promise<LeadRecord> {
  assertStaffPermission(actor, "leads.manage");
  const input = AssignLeadSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const lead = state.leads.find((l) => l.id === leadId);
    if (!lead) throw new AppError("NOT_FOUND", "Lead not found.", 404);
    if (input.assignee_user_id && !state.users.some((u) => u.id === input.assignee_user_id)) {
      throw new AppError("NOT_FOUND", "Assignee staff user not found.", 404);
    }
    const prev = lead.assignee_user_id;
    lead.assignee_user_id = input.assignee_user_id;
    lead.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "leads.lead.assigned",
      resource_type: "lead",
      resource_id: lead.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_assignee: prev, to_assignee: lead.assignee_user_id },
    });
    return lead;
  });
}

/**
 * Convert: resolve/create the customer via the §1 dedupe rules and return
 * it. The lead is NOT marked converted here — the Create Order wizard
 * opens with the customer prefilled, and order creation with lead_id
 * marks the lead converted.
 */
export async function convertLeadByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  leadId: string,
  requestId: string
): Promise<{ lead: LeadRecord; customer: CustomerRecord }> {
  assertStaffPermission(actor, "leads.manage");
  return store.withTransaction((state) => {
    const lead = state.leads.find((l) => l.id === leadId);
    if (!lead) throw new AppError("NOT_FOUND", "Lead not found.", 404);
    if (lead.status === "converted") {
      throw new AppError(
        "LEAD_ALREADY_CONVERTED",
        `Lead ${lead.lead_number} is already converted.`,
        409
      );
    }
    if (!lead.email && !lead.phone) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Lead has neither email nor phone — a customer cannot be resolved.",
        422
      );
    }
    const { customer } = resolveOrCreateCustomerInTx(state, {
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      whatsapp: lead.whatsapp,
      registration_source: "lead",
      notes: lead.interest ? `Interested in: ${lead.interest}` : null,
    });
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "leads.lead.converted_customer_resolved",
      resource_type: "lead",
      resource_id: lead.id,
      outcome: "success",
      request_id: requestId,
      changes: { customer_id: customer.id, customer_number: customer.customer_number },
    });
    return { lead, customer };
  });
}
