import { v } from "../common/validator.ts";

// Support tickets (ADR-0009).
//
// Status flow (enforced server-side, 409 otherwise):
//   open → in_progress → waiting_on_customer → resolved → closed
//   closed/resolved → open (reopen)
// Priority: low | medium | high | urgent.
// Category (small enum): billing | technical | license | order | other.
export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "waiting_on_customer",
  "resolved",
  "closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = [
  "billing",
  "technical",
  "license",
  "order",
  "other",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Allowed status transitions (server-enforced). */
export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ["in_progress", "waiting_on_customer", "resolved", "closed"],
  in_progress: ["waiting_on_customer", "resolved", "closed", "open"],
  waiting_on_customer: ["in_progress", "resolved", "closed", "open"],
  resolved: ["closed", "open"],
  closed: ["open"],
};

export const CreateTicketSchema = v.object({
  title: v.string().trim().min(2).max(200),
  description: v.string().trim().max(5000).default(""),
  customer_id: v.string().uuid().nullable().optional(),
  order_id: v.string().uuid().nullable().optional(),
  subscription_id: v.string().uuid().nullable().optional(),
  license_id: v.string().uuid().nullable().optional(),
  product_id: v.string().uuid().nullable().optional(),
  priority: v.enum(TICKET_PRIORITIES).default("medium"),
  category: v.enum(TICKET_CATEGORIES).default("other"),
  assignee_user_id: v.string().trim().min(1).max(200).nullable().optional(),
  // How the issue reached us (phone / email / WhatsApp / in person).
  // Null-tolerant (ADR-0009 decision 11): JSON null ≡ absent.
  source_note: v.string().trim().max(500).nullable().optional(),
});

export const UpdateTicketSchema = v.object({
  title: v.string().trim().min(2).max(200).optional(),
  description: v.string().trim().max(5000).nullable().optional(),
  priority: v.enum(TICKET_PRIORITIES).optional(),
  category: v.enum(TICKET_CATEGORIES).optional(),
  assignee_user_id: v.string().trim().min(1).max(200).nullable().optional(),
  source_note: v.string().trim().max(500).nullable().optional(),
});

export const TransitionTicketSchema = v.object({
  status: v.enum(TICKET_STATUSES),
  note: v.string().trim().max(2000).nullable().optional(),
});

export const AssignTicketSchema = v.object({
  assignee_user_id: v.string().trim().min(1).max(200).nullable(),
});

export const CreateTicketCommentSchema = v.object({
  body: v.string().trim().min(1).max(5000),
  is_internal: v.boolean().default(false),
});
