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
});
