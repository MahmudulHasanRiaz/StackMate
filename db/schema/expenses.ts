import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  date,
  timestamp,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { products } from "./catalog.ts";
import { paymentMethods } from "./payments.ts";
import { mediaAssets } from "./media.ts";

/**
 * Expense module (migration 0018).
 *
 * `expense_categories` is the admin-managed lookup for expense
 * categories (name is unique; color defaults to the StackMate green
 * #00E599; icon holds a Lucide icon name). `expenses` records one
 * business expense: a positive amount in minor units, the date it
 * was incurred, its category (RESTRICT — a category in use cannot
 * be deleted), and optional links to a product, a payment method,
 * and a receipt file in the media library (all SET NULL — deleting
 * the linked row must never delete the expense record).
 *
 * `recorded_by` is a plain nullable uuid with NO foreign key:
 * no `recorded_by` column exists anywhere else in the schema to
 * copy an FK pattern from, and the staff-user pattern used
 * elsewhere (text FK to `users.id`, e.g. `created_by_user_id`,
 * `reviewed_by_user_id`) cannot apply — `users.id` is text, so a
 * uuid FK to it would be a type mismatch. If the API later needs
 * `recorded_by` to reference a staff user, change it to
 * `text("recorded_by").references(() => users.id, { onDelete:
 * "set null" })` in a forward migration.
 */
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 120 }).notNull().unique(),
    description: text("description"),
    color: varchar("color", { length: 7 }).default("#00E599"),
    icon: varchar("icon", { length: 60 }),
    // Hierarchy (migration 0026): nullable self-reference, NULL =
    // top-level. ON DELETE RESTRICT — a parent with children cannot
    // be deleted (the API layer enforces the same 409 first). Cycle
    // prevention lives in the service layer (a CHECK cannot walk a
    // chain); the FK alone only guarantees the parent exists.
    // The `: AnyPgColumn` return annotation on the references
    // callback breaks tsc's circular inference on this
    // self-reference (without it: TS7022/TS7024).
    parentId: uuid("parent_id").references((): AnyPgColumn => expenseCategories.id, {
      onDelete: "restrict",
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_expense_categories_parent").on(table.parentId)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    amountMinor: integer("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("BDT"),
    expenseDate: date("expense_date").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => expenseCategories.id, { onDelete: "restrict" }),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, {
      onDelete: "set null",
    }),
    vendor: varchar("vendor", { length: 200 }),
    notes: text("notes"),
    receiptMediaId: uuid("receipt_media_id").references(() => mediaAssets.id, {
      onDelete: "set null",
    }),
    recordedBy: uuid("recorded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_expenses_category").on(table.categoryId),
    index("idx_expenses_product").on(table.productId),
    index("idx_expenses_expense_date").on(table.expenseDate),
    index("idx_expenses_product_expense_date").on(table.productId, table.expenseDate),
    index("idx_expenses_category_expense_date").on(table.categoryId, table.expenseDate),
    check("expenses_amount_minor_check", sql`"amount_minor" > 0`),
  ]
);
