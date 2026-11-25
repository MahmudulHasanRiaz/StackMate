-- 0019 — Expense module permissions (2026-11-25):
-- expenses.read + expenses.manage + expense_categories.manage.
--
-- Why a migration is needed (not just the seed): migration 0001 seeded
-- the permission catalogue and granted super_admin everything, and
-- migration 0003 granted the other roles — both already applied on
-- every existing database. The expense API routes
-- (apps/api/src/app.ts) and services already gate on these three keys,
-- and db/seeds/seed-reference.ts already lists them (same batch), so
-- without this migration the keys exist nowhere in the database: the
-- DrizzleStore role sync throws when a role references a permission
-- key missing from the permissions table, and finance_manager /
-- support_staff / read_only would 403 on every expense endpoint.
-- super_admin bypasses the permission list in code
-- (assertStaffPermission), so the module worked for super_admin/admin
-- before this lands — this migration makes it work for everyone else.
--
-- Grants (mirroring seed-reference.ts exactly):
--   super_admin + admin + finance_manager .... all three keys
--   (admin holds every permission per the seed; finance owns expense
--   recording, including category management).
--   support_staff + read_only ................ expenses.read only
--   (support inspects expenses like it inspects orders/payments;
--   read_only reads the P&L analytics like any other read surface).
-- license_manager / product_manager / marketing_manager get nothing:
-- expenses are not in their domains.
--
-- All changes are additive and idempotent (ON CONFLICT DO NOTHING), so
-- re-running is safe. Migrations 0000–0018 are NOT edited.

-- --- Permission keys (deterministic UUIDs, continuing the 0000000001xx
-- sequence after tracking.read ...133) ---
INSERT INTO "permissions" ("id", "key", "description", "created_at")
VALUES
  ('00000000-0000-4000-8000-000000000134', 'expenses.read', 'View expenses and profit & loss analytics', now()),
  ('00000000-0000-4000-8000-000000000135', 'expenses.manage', 'Create, edit, and delete expenses', now()),
  ('00000000-0000-4000-8000-000000000136', 'expense_categories.manage', 'Create, edit, and delete expense categories', now())
ON CONFLICT ("id") DO NOTHING;

-- --- Grants: all three keys ---
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('expenses.read', 'expenses.manage', 'expense_categories.manage')
WHERE r."key" IN ('super_admin', 'admin', 'finance_manager')
ON CONFLICT DO NOTHING;

-- --- Grants: read-only key ---
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('expenses.read')
WHERE r."key" IN ('support_staff', 'read_only')
ON CONFLICT DO NOTHING;
