/**
 * Issue Management / Support Tickets (ADR-0009).
 *
 * Staff-created tickets (customers report out-of-band — phone/email/
 * WhatsApp — there is no public submission form). Optional linkages to an
 * order, subscription, license, product and customer, with auto-fill and
 * server-side consistency validation: picking an order auto-assigns its
 * customer; picking a subscription/license auto-assigns its customer AND
 * its product; mismatched links 422 (TICKET_LINK_MISMATCH).
 *
 * Status flow (409 otherwise): open → in_progress → waiting_on_customer →
 * resolved → closed, with reopen (closed/resolved → open).
 */
import { randomUUID } from "node:crypto";
import {
  AssignTicketSchema,
  CreateTicketCommentSchema,
  CreateTicketSchema,
  TICKET_TRANSITIONS,
  TransitionTicketSchema,
  UpdateTicketSchema,
} from "../../../../../packages/contracts/src/index.ts";
import type {
  DatabaseState,
  StackMateDataStore,
  SupportTicketRecord,
  TicketCommentRecord,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export interface TicketLinks {
  customer_id: string | null;
  order_id: string | null;
  subscription_id: string | null;
  license_id: string | null;
  product_id: string | null;
}

/**
 * Resolve + validate the optional links. Auto-fill rules: order → its
 * customer; subscription/license → their customer AND product. A manual
 * customer/product that disagrees with a linked record 422s.
 */
export function resolveTicketLinks(
  state: DatabaseState,
  input: {
    customer_id?: string | null | undefined;
    order_id?: string | null | undefined;
    subscription_id?: string | null | undefined;
    license_id?: string | null | undefined;
    product_id?: string | null | undefined;
  }
): TicketLinks {
  let customerId: string | null = input.customer_id ?? null;
  let productId: string | null = input.product_id ?? null;
  const orderId = input.order_id ?? null;
  const subscriptionId = input.subscription_id ?? null;
  const licenseId = input.license_id ?? null;

  const mismatch = (msg: string): never => {
    throw new AppError("TICKET_LINK_MISMATCH", msg, 422);
  };

  if (orderId) {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new AppError("NOT_FOUND", "Linked order not found.", 404);
    if (customerId && customerId !== order.customer_id) {
      mismatch("The linked order belongs to a different customer.");
    }
    customerId = order.customer_id;
  }
  if (subscriptionId) {
    const sub = state.subscriptions.find((s) => s.id === subscriptionId);
    if (!sub) throw new AppError("NOT_FOUND", "Linked subscription not found.", 404);
    if (customerId && customerId !== sub.customer_id) {
      mismatch("The linked subscription belongs to a different customer.");
    }
    customerId = sub.customer_id;
    if (productId && productId !== sub.product_id) {
      mismatch("The linked subscription belongs to a different product.");
    }
    productId = sub.product_id;
  }
  if (licenseId) {
    const license = state.licenses.find((l) => l.id === licenseId);
    if (!license) throw new AppError("NOT_FOUND", "Linked license not found.", 404);
    if (customerId && customerId !== license.customer_id) {
      mismatch("The linked license belongs to a different customer.");
    }
    customerId = license.customer_id;
    if (productId && productId !== license.product_id) {
      mismatch("The linked license belongs to a different product.");
    }
    productId = license.product_id;
  }
  if (customerId && !state.customers.some((c) => c.id === customerId)) {
    throw new AppError("NOT_FOUND", "Linked customer not found.", 404);
  }
  if (productId && !state.products.some((p) => p.id === productId)) {
    throw new AppError("NOT_FOUND", "Linked product not found.", 404);
  }
  return {
    customer_id: customerId,
    order_id: orderId,
    subscription_id: subscriptionId,
    license_id: licenseId,
    product_id: productId,
  };
}

function assertAssigneeExists(state: DatabaseState, assigneeUserId: string | null): void {
  if (!assigneeUserId) return;
  if (!state.users.some((u) => u.id === assigneeUserId)) {
    throw new AppError("NOT_FOUND", "Assignee staff user not found.", 404);
  }
}

export async function createTicketByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<SupportTicketRecord> {
  assertStaffPermission(actor, "tickets.manage");
  const input = CreateTicketSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const links = resolveTicketLinks(state, input);
    assertAssigneeExists(state, input.assignee_user_id ?? null);
    const now = new Date().toISOString();
    state.sequence_counters.ticket += 1;
    const ticket: SupportTicketRecord = {
      id: randomUUID(),
      ticket_number: `TKT-${state.sequence_counters.ticket}`,
      customer_id: links.customer_id,
      order_id: links.order_id,
      subscription_id: links.subscription_id,
      license_id: links.license_id,
      product_id: links.product_id,
      title: input.title.trim(),
      description: input.description ?? "",
      status: "open",
      priority: input.priority,
      category: input.category,
      reporter_user_id: actor.user.id,
      source_note: input.source_note ?? null,
      assignee_user_id: input.assignee_user_id ?? null,
      created_at: now,
      updated_at: now,
      resolved_at: null,
      closed_at: null,
    };
    state.support_tickets.push(ticket);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "tickets.ticket.created",
      resource_type: "ticket",
      resource_id: ticket.id,
      outcome: "success",
      request_id: requestId,
      changes: { ticket_number: ticket.ticket_number, customer_id: ticket.customer_id },
    });
    return ticket;
  });
}

export async function updateTicketByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  ticketId: string,
  rawInput: unknown,
  requestId: string
): Promise<SupportTicketRecord> {
  assertStaffPermission(actor, "tickets.manage");
  const input = UpdateTicketSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const ticket = state.support_tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found.", 404);
    assertAssigneeExists(state, input.assignee_user_id ?? ticket.assignee_user_id);
    const changes: Record<string, unknown> = {};
    if (input.title !== undefined) {
      ticket.title = input.title.trim();
      changes.title = ticket.title;
    }
    if (input.description !== undefined) {
      ticket.description = input.description;
      changes.description = ticket.description;
    }
    if (input.priority !== undefined) {
      ticket.priority = input.priority;
      changes.priority = ticket.priority;
    }
    if (input.category !== undefined) {
      ticket.category = input.category;
      changes.category = ticket.category;
    }
    if (input.assignee_user_id !== undefined) {
      ticket.assignee_user_id = input.assignee_user_id;
      changes.assignee_user_id = ticket.assignee_user_id;
    }
    if (input.source_note !== undefined) {
      ticket.source_note = input.source_note;
      changes.source_note = ticket.source_note;
    }
    ticket.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "tickets.ticket.updated",
      resource_type: "ticket",
      resource_id: ticket.id,
      outcome: "success",
      request_id: requestId,
      changes,
    });
    return ticket;
  });
}

export async function transitionTicketByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  ticketId: string,
  rawInput: unknown,
  requestId: string
): Promise<SupportTicketRecord> {
  assertStaffPermission(actor, "tickets.manage");
  const input = TransitionTicketSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const ticket = state.support_tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found.", 404);
    const allowed = TICKET_TRANSITIONS[ticket.status];
    if (!allowed.includes(input.status)) {
      throw new AppError(
        "INVALID_TICKET_TRANSITION",
        `Cannot move a ticket from ${ticket.status} to ${input.status}.`,
        409
      );
    }
    const prev = ticket.status;
    const now = new Date().toISOString();
    ticket.status = input.status;
    ticket.updated_at = now;
    if (input.status === "resolved") ticket.resolved_at = now;
    if (input.status === "closed") ticket.closed_at = now;
    if (input.status === "open") {
      ticket.resolved_at = null;
      ticket.closed_at = null;
    }
    if (input.note) {
      state.ticket_comments.push({
        id: randomUUID(),
        ticket_id: ticket.id,
        author_user_id: actor.user.id,
        body: input.note,
        is_internal: true,
        created_at: now,
      });
    }
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "tickets.ticket.status_changed",
      resource_type: "ticket",
      resource_id: ticket.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_status: prev, to_status: ticket.status },
    });
    return ticket;
  });
}

export async function assignTicketByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  ticketId: string,
  rawInput: unknown,
  requestId: string
): Promise<SupportTicketRecord> {
  assertStaffPermission(actor, "tickets.manage");
  const input = AssignTicketSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const ticket = state.support_tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found.", 404);
    assertAssigneeExists(state, input.assignee_user_id);
    const prev = ticket.assignee_user_id;
    ticket.assignee_user_id = input.assignee_user_id;
    ticket.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "tickets.ticket.assigned",
      resource_type: "ticket",
      resource_id: ticket.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_assignee: prev, to_assignee: ticket.assignee_user_id },
    });
    return ticket;
  });
}

export async function addTicketCommentByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  ticketId: string,
  rawInput: unknown,
  requestId: string
): Promise<TicketCommentRecord> {
  assertStaffPermission(actor, "tickets.manage");
  const input = CreateTicketCommentSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const ticket = state.support_tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found.", 404);
    const comment: TicketCommentRecord = {
      id: randomUUID(),
      ticket_id: ticketId,
      author_user_id: actor.user.id,
      body: input.body,
      is_internal: input.is_internal,
      created_at: new Date().toISOString(),
    };
    state.ticket_comments.push(comment);
    ticket.updated_at = comment.created_at;
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "tickets.comment.created",
      resource_type: "ticket",
      resource_id: ticket.id,
      outcome: "success",
      request_id: requestId,
      changes: { comment_id: comment.id, is_internal: comment.is_internal },
    });
    return comment;
  });
}
