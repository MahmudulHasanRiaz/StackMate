import { sql } from "drizzle-orm";
import { pgTable, uuid, varchar, text, boolean, timestamp, index, check } from "drizzle-orm/pg-core";
import { customers } from "./customers.ts";
import { orders } from "./orders.ts";
import { subscriptions } from "./subscriptions.ts";
import { licenses } from "./licenses.ts";
import { products } from "./catalog.ts";

// Migration 0009: issue management / support tickets (ADR-0009).
//
// Status flow (enforced in the API, 409 otherwise):
//   open → in_progress → waiting_on_customer → resolved → closed
//   closed/resolved → open (reopen)
// Priority: low | medium | high | urgent.
// Category: billing | technical | license | order | other (small enum).
//
// Linkages (all nullable, shown as links on the ticket detail):
//   order → customer is auto-set from the order; subscription/license
//   auto-set customer + product and must belong to the ticket's customer
//   (422 otherwise); an explicitly given product must match the linked
//   subscription/license product (422 otherwise).
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey(),
    ticketNumber: varchar("ticket_number", { length: 40 }).notNull().unique(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    licenseId: uuid("license_id").references(() => licenses.id, { onDelete: "set null" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("open"),
    priority: text("priority").notNull().default("medium"),
    category: text("category").notNull().default("other"),
    reporterUserId: text("reporter_user_id").notNull(),
    sourceNote: text("source_note"),
    assigneeUserId: text("assignee_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_support_tickets_customer_created").on(table.customerId, table.createdAt.desc()),
    index("idx_support_tickets_status_created").on(table.status, table.createdAt.desc()),
    index("idx_support_tickets_assignee").on(table.assigneeUserId, table.createdAt.desc()),
    // CHECKs declared in Drizzle (migration 0014 / audit F-11) so
    // drizzle-kit generate reproduces them; previously SQL-only (the
    // 0009 tables carried plain text status columns with no check).
    check("support_tickets_status_check", sql`"status" IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed')`),
    check("support_tickets_priority_check", sql`"priority" IN ('low', 'medium', 'high', 'urgent')`),
    check("support_tickets_category_check", sql`"category" IN ('billing', 'technical', 'license', 'order', 'other')`),
  ]
);

export const ticketComments = pgTable(
  "ticket_comments",
  {
    id: uuid("id").primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").notNull(),
    body: text("body").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_ticket_comments_ticket_created").on(table.ticketId, table.createdAt),
  ]
);
