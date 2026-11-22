import { sql } from "drizzle-orm";
import { pgTable, uuid, varchar, char, text, boolean, bigint, timestamp, index, unique, uniqueIndex, check } from "drizzle-orm/pg-core";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey(),
    customerNumber: varchar("customer_number", { length: 40 }).notNull().unique(),
    customerType: text("customer_type").notNull().default("person"), // person | business
    name: varchar("name", { length: 200 }).notNull(),
    email: varchar("email", { length: 320 }),
    normalizedEmail: varchar("normalized_email", { length: 320 }),
    phone: varchar("phone", { length: 40 }),
    normalizedPhone: varchar("normalized_phone", { length: 20 }),
    // Migration 0009: WhatsApp number (often the same as phone) + credit
    // balance from overpayments, in minor units (ADR-0009).
    whatsapp: varchar("whatsapp", { length: 40 }),
    creditBalanceMinor: bigint("credit_balance_minor", { mode: "number" }).notNull().default(0),
    companyName: varchar("company_name", { length: 200 }),
    // Migration 0011: website (ADR-0009 decision 11) — the UI collected
    // it but there was no column, so the value was silently discarded.
    website: varchar("website", { length: 200 }),
    countryCode: char("country_code", { length: 2 }).default("BD"),
    status: text("status").notNull().default("active"), // active | inactive | blocked
    registrationSource: text("registration_source").notNull().default("admin"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    // Migration 0014 (audit F-02): the dedupe invariant ("same email OR
    // phone never makes a second customer") is enforced in the DB, not
    // just by the app-level resolver — partial unique indexes, created
    // by the migration only when no duplicates exist (see 0014).
    uniqueIndex("uq_customers_normalized_email").on(table.normalizedEmail).where(sql`"normalized_email" IS NOT NULL`),
    uniqueIndex("uq_customers_normalized_phone").on(table.normalizedPhone).where(sql`"normalized_phone" IS NOT NULL`),
    index("idx_customers_status_created_at").on(table.status, table.createdAt.desc()),
    // CHECKs declared in Drizzle (migration 0014 / audit F-11) so
    // drizzle-kit generate reproduces them; previously SQL-only.
    check("customers_customer_type_check", sql`"customer_type" IN ('person', 'business')`),
    check("customers_status_check", sql`"status" IN ('active', 'inactive', 'blocked')`),
    check("customers_credit_balance_minor_check", sql`"credit_balance_minor" >= 0`),
  ]
);

// Migration 0009: secondary emails/phones (dedupe, ADR-0009). One normalized
// contact belongs to at most one customer — enforced by the unique index on
// (kind, normalized_value). The primary contact stays on `customers`.
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // email | phone
    value: varchar("value", { length: 320 }).notNull(),
    normalizedValue: varchar("normalized_value", { length: 320 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_customer_contacts_kind_normalized").on(table.kind, table.normalizedValue),
    index("idx_customer_contacts_customer").on(table.customerId, table.createdAt),
  ]
);

// Migration 0009: staff reports on a customer (note / concern + required
// detail), filed from the customer profile (ADR-0009).
export const customerReports = pgTable(
  "customer_reports",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").notNull(),
    type: text("type").notNull().default("note"), // note | concern
    detail: text("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_customer_reports_customer_created").on(table.customerId, table.createdAt.desc()),
  ]
);

export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    addressType: text("address_type").notNull().default("billing"), // billing | shipping | other
    contactName: varchar("contact_name", { length: 200 }),
    phone: varchar("phone", { length: 40 }),
    addressLine1: text("address_line_1"),
    addressLine2: text("address_line_2"),
    city: varchar("city", { length: 120 }),
    stateOrRegion: varchar("state_or_region", { length: 120 }),
    postalCode: varchar("postal_code", { length: 40 }),
    countryCode: char("country_code", { length: 2 }).notNull().default("BD"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_customer_addresses_customer_type").on(table.customerId, table.addressType),
    check("customer_addresses_address_type_check", sql`"address_type" IN ('billing', 'shipping', 'other')`),
  ]
);
