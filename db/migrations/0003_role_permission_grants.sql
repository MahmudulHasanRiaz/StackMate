-- StackMate Migration 0003: Role-permission grants for non-super-admin roles
--
-- Why this migration exists: migration 0001 seeded the 8 built-in roles and
-- the 25 permissions, but granted permissions ONLY to super_admin. The
-- other 7 roles existed in the database with zero grants, while the API's
-- in-memory store (db/seeds/seed-reference.ts, SEED_ROLES) seeds the full
-- matrix — so RBAC in the database diverged from RBAC in memory. This
-- migration grants exactly the matrix defined in seed-reference.ts.
-- Migration 0001 is NOT edited (it may already be applied); this is a
-- forward, idempotent correction (ON CONFLICT DO NOTHING on the
-- role_permissions primary key).
--
-- Grants added: admin 24, finance_manager 13, license_manager 7,
-- product_manager 6, support_staff 7, marketing_manager 4, read_only 7
-- = 68 grants. super_admin already holds all 25 from migration 0001.

-- admin: everything except users.manage
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT '00000000-0000-4000-8000-000000000202'::uuid, "id" FROM "permissions"
WHERE "key" <> 'users.manage'
ON CONFLICT DO NOTHING;

-- finance_manager: orders, manual payment verification, invoices, subscriptions
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT '00000000-0000-4000-8000-000000000203'::uuid, "id" FROM "permissions"
WHERE "key" IN (
  'products.read', 'customers.read', 'customers.manage',
  'orders.read', 'orders.create', 'orders.manage',
  'payments.read', 'payments.methods.manage', 'payments.approve', 'payments.reject',
  'subscriptions.read', 'subscriptions.manage', 'licenses.read'
)
ON CONFLICT DO NOTHING;

-- license_manager: license issuance, suspension, revocation, activation management
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT '00000000-0000-4000-8000-000000000204'::uuid, "id" FROM "permissions"
WHERE "key" IN (
  'products.read', 'customers.read', 'orders.read', 'subscriptions.read',
  'licenses.read', 'licenses.manage', 'licenses.revoke'
)
ON CONFLICT DO NOTHING;

-- product_manager: catalog, features, packages, pricing
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT '00000000-0000-4000-8000-000000000205'::uuid, "id" FROM "permissions"
WHERE "key" IN (
  'products.read', 'products.create', 'products.update',
  'features.manage', 'packages.manage', 'packages.publish'
)
ON CONFLICT DO NOTHING;

-- support_staff: customer lookup, order/license inspection, support operations
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT '00000000-0000-4000-8000-000000000206'::uuid, "id" FROM "permissions"
WHERE "key" IN (
  'products.read', 'customers.read', 'customers.manage',
  'orders.read', 'payments.read', 'subscriptions.read', 'licenses.read'
)
ON CONFLICT DO NOTHING;

-- marketing_manager: integrations, Meta Pixel/CAPI tracking, webhooks
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT '00000000-0000-4000-8000-000000000207'::uuid, "id" FROM "permissions"
WHERE "key" IN (
  'products.read', 'integrations.manage', 'integrations.rotate_credentials', 'tracking.manage'
)
ON CONFLICT DO NOTHING;

-- read_only: authorized read-only access across operational views
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT '00000000-0000-4000-8000-000000000208'::uuid, "id" FROM "permissions"
WHERE "key" IN (
  'products.read', 'customers.read', 'orders.read', 'payments.read',
  'subscriptions.read', 'licenses.read', 'audit_logs.read'
)
ON CONFLICT DO NOTHING;
