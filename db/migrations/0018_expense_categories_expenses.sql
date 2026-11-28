-- 0018 — Expense module: expense_categories + expenses (2026-11-25).
--
-- Why these tables exist: the admin had NO way to record business
-- expenses (hosting, domains, tools, ads, ...). This migration adds
-- the storage for it: an admin-managed category lookup plus one row
-- per expense — a positive amount in minor units, the date it was
-- incurred, its category, and optional links to a product, a payment
-- method, and a receipt file in the media library.
--
-- Invariants:
--   expenses.amount_minor ............ always > 0 (CHECK, inline —
--                                      drizzle-kit renders single-column
--                                      CHECKs inline, see migration 0000).
--   expense_categories.name .......... UNIQUE — one row per category name.
--   expenses.category_id ............. RESTRICT — a category in use
--                                      cannot be deleted.
--   expenses.product_id /
--   expenses.payment_method_id /
--   expenses.receipt_media_id ........ SET NULL — deleting the linked
--                                      product / payment method / receipt
--                                      must never delete the expense.
--   expenses.recorded_by ............. plain nullable uuid, NO foreign
--                                      key: no recorded_by column exists
--                                      anywhere else in the schema to copy
--                                      an FK pattern from, and the
--                                      staff-user pattern used elsewhere
--                                      (text FK to users.id) cannot apply
--                                      — users.id is text, so a uuid FK
--                                      to it would be a type mismatch.
--
-- All changes are additive and idempotent (CREATE TABLE IF NOT EXISTS
-- + CREATE INDEX IF NOT EXISTS), so re-running is safe. Migrations
-- 0000–0017 are NOT edited.

CREATE TABLE IF NOT EXISTS "expense_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(120) NOT NULL UNIQUE,
  "description" text,
  "color" varchar(7) DEFAULT '#00E599',
  "icon" varchar(60),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "expenses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "amount_minor" integer NOT NULL CHECK ("amount_minor" > 0),
  "currency" varchar(3) NOT NULL DEFAULT 'BDT',
  "expense_date" date NOT NULL,
  "category_id" uuid NOT NULL REFERENCES "expense_categories"("id") ON DELETE RESTRICT,
  "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "payment_method_id" uuid REFERENCES "payment_methods"("id") ON DELETE SET NULL,
  "vendor" varchar(200),
  "notes" text,
  "receipt_media_id" uuid REFERENCES "media_assets"("id") ON DELETE SET NULL,
  "recorded_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_expenses_category" ON "expenses" ("category_id");
CREATE INDEX IF NOT EXISTS "idx_expenses_product" ON "expenses" ("product_id");
CREATE INDEX IF NOT EXISTS "idx_expenses_expense_date" ON "expenses" ("expense_date");
CREATE INDEX IF NOT EXISTS "idx_expenses_product_expense_date" ON "expenses" ("product_id", "expense_date");
CREATE INDEX IF NOT EXISTS "idx_expenses_category_expense_date" ON "expenses" ("category_id", "expense_date");
