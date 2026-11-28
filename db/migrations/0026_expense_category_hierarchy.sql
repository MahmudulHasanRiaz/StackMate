-- 0026 — Expense category hierarchy: parent_id (2026-11-26).
--
-- Why: expense categories were flat — "Office" and "Office /
-- Stationery" had no relationship, so the P&L breakdown could not
-- roll a sub-category's spend up into its parent. This migration
-- adds an optional self-referencing parent:
--
--   expense_categories.parent_id ....... NULLABLE uuid, NULL = top-level.
--                                      Existing rows ("Test Office",
--                                      "Hono Test Cat", ...) stay NULL.
--   FK self-reference .................. REFERENCES expense_categories(id)
--                                      ON DELETE RESTRICT — a parent with
--                                      children cannot be deleted at the
--                                      DB level either (the API layer
--                                      enforces the same 409 first).
--   Cycle prevention ................... NOT enforceable by this FK
--                                      alone — the service layer walks
--                                      the ancestor chain on create /
--                                      update and rejects a cycle
--                                      (400). A CHECK cannot walk a
--                                      chain, so no CHECK is attempted.
--
-- All changes are additive and idempotent (ADD COLUMN IF NOT EXISTS +
-- DO blocks for the FK / index), so re-running is safe. Migrations
-- 0000–0025 are NOT edited.

ALTER TABLE "expense_categories"
  ADD COLUMN IF NOT EXISTS "parent_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expense_categories_parent_id_fkey'
      AND conrelid = 'expense_categories'::regclass
  ) THEN
    ALTER TABLE "expense_categories"
      ADD CONSTRAINT "expense_categories_parent_id_fkey"
      FOREIGN KEY ("parent_id")
      REFERENCES "expense_categories"("id")
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_expense_categories_parent"
  ON "expense_categories" ("parent_id");
