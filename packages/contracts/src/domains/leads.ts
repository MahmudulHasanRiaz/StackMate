import { v } from "../common/validator.ts";

// Leads (ADR-0009).
//
// Status flow (enforced server-side, 409 otherwise):
//   new → contacted → qualified → converted
//   new/contacted/qualified → lost; lost → new (reopen)
// Contact rule mirrors customers: at least one of email/phone.
export const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Allowed status transitions (server-enforced). */
export const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  new: ["contacted", "qualified", "lost"],
  contacted: ["qualified", "lost", "new"],
  qualified: ["converted", "lost", "contacted"],
  converted: [],
  lost: ["new"],
};

const LeadContactFields = {
  name: v.string().trim().min(2).max(200),
  email: v.string().trim().email().optional(),
  phone: v.string().trim().min(6).max(40).optional(),
  whatsapp: v.string().trim().min(6).max(40).optional(),
};

const CONTACT_RULE = "At least one of email or phone is required.";

function contactRule<T extends { email?: string | null | undefined; phone?: string | null | undefined }>(
  val: T
): boolean {
  return Boolean(val.email?.trim() || val.phone?.trim());
}

/** Website ingestion body (S2S HMAC, scope `leads.create`). */
export const IngestLeadSchema = v
  .object({
    ...LeadContactFields,
    utm_source: v.string().trim().max(120).optional(),
    utm_medium: v.string().trim().max(120).optional(),
    utm_campaign: v.string().trim().max(120).optional(),
    interest: v.string().trim().max(2000).optional(),
    product_id: v.string().uuid().nullable().optional(),
    message: v.string().trim().max(5000).optional(),
    notes: v.string().trim().max(2000).optional(),
    // Browser identifiers the site may forward for the Lead tracking event.
    fbp: v.string().trim().max(200).optional(),
    fbc: v.string().trim().max(200).optional(),
    event_source_url: v.string().trim().max(500).optional(),
  })
  .refine(contactRule, CONTACT_RULE);

/** Manual lead creation by staff (same contact rule). */
export const CreateLeadSchema = v
  .object({
    ...LeadContactFields,
    source_site_id: v.string().uuid().nullable().optional(),
    utm_source: v.string().trim().max(120).optional(),
    utm_medium: v.string().trim().max(120).optional(),
    utm_campaign: v.string().trim().max(120).optional(),
    interest: v.string().trim().max(2000).optional(),
    product_id: v.string().uuid().nullable().optional(),
    message: v.string().trim().max(5000).optional(),
    notes: v.string().trim().max(2000).optional(),
    assignee_user_id: v.string().trim().min(1).max(200).nullable().optional(),
  })
  .refine(contactRule, CONTACT_RULE);

export const UpdateLeadSchema = v.object({
  name: v.string().trim().min(2).max(200).optional(),
  email: v.string().trim().email().nullable().optional(),
  phone: v.string().trim().min(6).max(40).nullable().optional(),
  whatsapp: v.string().trim().min(6).max(40).nullable().optional(),
  utm_source: v.string().trim().max(120).nullable().optional(),
  utm_medium: v.string().trim().max(120).nullable().optional(),
  utm_campaign: v.string().trim().max(120).nullable().optional(),
  interest: v.string().trim().max(2000).nullable().optional(),
  product_id: v.string().uuid().nullable().optional(),
  message: v.string().trim().max(5000).nullable().optional(),
  notes: v.string().trim().max(2000).nullable().optional(),
  assignee_user_id: v.string().trim().min(1).max(200).nullable().optional(),
});

export const TransitionLeadSchema = v.object({
  status: v.enum(LEAD_STATUSES),
  note: v.string().trim().max(2000).optional(),
});

export const AssignLeadSchema = v.object({
  assignee_user_id: v.string().trim().min(1).max(200).nullable(),
});
