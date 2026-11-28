import { sql } from "drizzle-orm";
import { pgTable, uuid, varchar, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { customers } from "./customers.ts";
import { integratedSites } from "./integrations.ts";
import { products } from "./catalog.ts";

// Migration 0009: lead management (ADR-0009).
//
// Leads arrive from connected websites through the S2S HMAC ingestion
// endpoint (same auth as the server checkout orders — scope
// `leads.create`) or are entered manually by staff. Contact rule mirrors
// customers: at least one of email/phone. Dedupe: same normalized contact
// from the same site within 30 days updates the existing lead instead of
// creating a duplicate (see the leads service).
//
// Status flow (enforced in the API, 409 otherwise):
//   new → contacted → qualified → converted
//   new/contacted/qualified → lost; lost → new (reopen)
// Conversion never deletes the lead: converted_at + converted_customer_id
// + converted_order_id link the history.
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey(),
    leadNumber: varchar("lead_number", { length: 40 }).notNull().unique(),
    name: varchar("name", { length: 200 }).notNull(),
    email: varchar("email", { length: 320 }),
    normalizedEmail: varchar("normalized_email", { length: 320 }),
    phone: varchar("phone", { length: 40 }),
    normalizedPhone: varchar("normalized_phone", { length: 20 }),
    whatsapp: varchar("whatsapp", { length: 40 }),
    sourceSiteId: uuid("source_site_id").references(() => integratedSites.id, {
      onDelete: "set null",
    }),
    utmSource: varchar("utm_source", { length: 120 }),
    utmMedium: varchar("utm_medium", { length: 120 }),
    utmCampaign: varchar("utm_campaign", { length: 120 }),
    interest: text("interest"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    message: text("message"),
    notes: text("notes"),
    status: text("status").notNull().default("new"),
    assigneeUserId: text("assignee_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    convertedCustomerId: uuid("converted_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    // converted_order_id intentionally carries NO Drizzle `.references()`:
    // orders.lead_id already references leads, so a second FK back to
    // orders makes the two tables circularly infer (TS7022/TS7024). The
    // link is enforced at the service level (conversion writes it only
    // after the order exists) and the SQL migration carries no FK either.
    convertedOrderId: uuid("converted_order_id"),
  },
  (table) => [
    index("idx_leads_normalized_email").on(table.normalizedEmail).where(sql`"normalized_email" IS NOT NULL`),
    index("idx_leads_normalized_phone").on(table.normalizedPhone).where(sql`"normalized_phone" IS NOT NULL`),
    index("idx_leads_status_created").on(table.status, table.createdAt.desc()),
    index("idx_leads_source_site_created").on(table.sourceSiteId, table.createdAt.desc()),
    // CHECK declared in Drizzle (migration 0014 / audit F-11) so
    // drizzle-kit generate reproduces it; previously SQL-only.
    check("leads_status_check", sql`"status" IN ('new', 'contacted', 'qualified', 'converted', 'lost')`),
  ]
);
