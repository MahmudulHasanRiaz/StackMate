import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { customers } from "./customers.ts";
import { currencies } from "./catalog.ts";
import { orders, orderItems } from "./orders.ts";
import { subscriptions } from "./subscriptions.ts";

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey(),
    invoiceNumber: varchar("invoice_number", { length: 60 }).notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "restrict",
    }),
    invoiceType: text("invoice_type").notNull().default("initial"), // initial | renewal | adjustment | credit_note
    status: text("status").notNull().default("open"), // draft | open | paid | void | uncollectible | partially_paid
    currencyCode: varchar("currency_code", { length: 3 })
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    subtotalMinor: bigint("subtotal_minor", { mode: "number" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "number" }).notNull().default(0),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull().default(0),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
    amountPaidMinor: bigint("amount_paid_minor", { mode: "number" }).notNull().default(0),
    amountDueMinor: bigint("amount_due_minor", { mode: "number" }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    billingSnapshot: jsonb("billing_snapshot").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_invoices_customer_issued").on(table.customerId, table.issuedAt.desc()),
    index("idx_invoices_status_due").on(table.status, table.dueAt),
    index("idx_invoices_subscription_issued").on(table.subscriptionId, table.issuedAt.desc()),
    // Migration 0021 (audit C-02): order detail + invoice void scan
    // by order_id; renewal reconciliation joins on it.
    index("idx_invoices_order_id").on(table.orderId),
    check("invoices_invoice_type_check", sql`"invoice_type" IN ('initial', 'renewal', 'adjustment', 'credit_note')`),
    check("invoices_status_check", sql`"status" IN ('draft', 'open', 'paid', 'void', 'uncollectible', 'partially_paid')`),
    check("invoices_subtotal_minor_check", sql`"subtotal_minor" >= 0`),
    check("invoices_discount_minor_check", sql`"discount_minor" >= 0`),
    check("invoices_tax_minor_check", sql`"tax_minor" >= 0`),
    check("invoices_total_minor_check", sql`"total_minor" >= 0`),
    check("invoices_amount_paid_minor_check", sql`"amount_paid_minor" >= 0`),
    check("invoices_amount_due_minor_check", sql`"amount_due_minor" >= 0`),
  ]
);

export const invoiceItems = pgTable("invoice_items", {
  id: uuid("id").primaryKey(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "restrict" }),
  orderItemId: uuid("order_item_id").references(() => orderItems.id, {
    onDelete: "restrict",
  }),
  descriptionSnapshot: text("description_snapshot").notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
  lineAmountMinor: bigint("line_amount_minor", { mode: "number" }).notNull(),
  taxAmountMinor: bigint("tax_amount_minor", { mode: "number" }).notNull().default(0),
  currencyCode: varchar("currency_code", { length: 3 })
    .notNull()
    .references(() => currencies.code, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
(table) => [
  // Migration 0021 (audit C-02): invoice detail renders its items by
  // invoice_id; invoice deletes scan the child table.
  index("idx_invoice_items_invoice_id").on(table.invoiceId),
  check("invoice_items_quantity_check", sql`"quantity" >= 1`),
  check("invoice_items_unit_amount_minor_check", sql`"unit_amount_minor" >= 0`),
  check("invoice_items_line_amount_minor_check", sql`"line_amount_minor" >= 0`),
  check("invoice_items_tax_amount_minor_check", sql`"tax_amount_minor" >= 0`),
]);
