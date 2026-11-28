-- StackMate Migration 0001: Reference Currency Registry, RBAC Permissions, Built-in Roles, and Payment Provider Presets
-- Deterministic, idempotent reference setup (no fake customer orders or credentials).

INSERT INTO "currencies" ("code", "name", "symbol", "exponent", "is_active")
VALUES
  ('BDT', 'Bangladeshi Taka', '৳', 2, true),
  ('USD', 'US Dollar', '$', 2, true),
  ('EUR', 'Euro', '€', 2, true),
  ('GBP', 'British Pound', '£', 2, true),
  ('JPY', 'Japanese Yen', '¥', 0, false)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "permissions" ("id", "key", "description")
VALUES
  ('00000000-0000-4000-8000-000000000101', 'products.read', 'View products and integration profiles'),
  ('00000000-0000-4000-8000-000000000102', 'products.create', 'Create new products'),
  ('00000000-0000-4000-8000-000000000103', 'products.update', 'Edit and archive products'),
  ('00000000-0000-4000-8000-000000000104', 'features.manage', 'Create and manage product feature definitions'),
  ('00000000-0000-4000-8000-000000000105', 'packages.manage', 'Create and edit draft packages and prices'),
  ('00000000-0000-4000-8000-000000000106', 'packages.publish', 'Publish immutable package versions and retire plans'),
  ('00000000-0000-4000-8000-000000000107', 'customers.read', 'View customers and customer history'),
  ('00000000-0000-4000-8000-000000000108', 'customers.manage', 'Create and update customer records'),
  ('00000000-0000-4000-8000-000000000109', 'orders.read', 'View orders and invoices'),
  ('00000000-0000-4000-8000-000000000110', 'orders.create', 'Create manual and custom-package orders'),
  ('00000000-0000-4000-8000-000000000111', 'orders.manage', 'Cancel orders and void invoices'),
  ('00000000-0000-4000-8000-000000000112', 'payments.read', 'View payment methods, submissions, and evidence'),
  ('00000000-0000-4000-8000-000000000113', 'payments.methods.manage', 'Configure manual MFS and bank payment methods'),
  ('00000000-0000-4000-8000-000000000114', 'payments.approve', 'Verify and approve manual payment submissions'),
  ('00000000-0000-4000-8000-000000000115', 'payments.reject', 'Reject manual payment submissions'),
  ('00000000-0000-4000-8000-000000000116', 'subscriptions.read', 'View subscriptions and renewal periods'),
  ('00000000-0000-4000-8000-000000000117', 'subscriptions.manage', 'Create renewal invoices, pause, resume, or cancel subscriptions'),
  ('00000000-0000-4000-8000-000000000118', 'licenses.read', 'View licenses and activations'),
  ('00000000-0000-4000-8000-000000000119', 'licenses.manage', 'Issue complimentary grants, suspend, resume, or adjust license entitlements'),
  ('00000000-0000-4000-8000-000000000120', 'licenses.revoke', 'Irreversibly revoke licenses and deactivate installations'),
  ('00000000-0000-4000-8000-000000000121', 'integrations.manage', 'Register external websites, verify domains, and manage webhooks'),
  ('00000000-0000-4000-8000-000000000122', 'integrations.rotate_credentials', 'Create, rotate, and revoke site credentials'),
  ('00000000-0000-4000-8000-000000000123', 'tracking.manage', 'Configure Meta Pixel and Conversions API tracking'),
  ('00000000-0000-4000-8000-000000000124', 'users.manage', 'Manage staff users, roles, and permissions'),
  ('00000000-0000-4000-8000-000000000125', 'audit_logs.read', 'Inspect administrative and security audit logs')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "roles" ("id", "key", "name", "description", "is_system")
VALUES
  ('00000000-0000-4000-8000-000000000201', 'super_admin', 'Super Admin', 'Full platform control across all domains', true),
  ('00000000-0000-4000-8000-000000000202', 'admin', 'Admin', 'Administrative access across operational domains', true),
  ('00000000-0000-4000-8000-000000000203', 'finance_manager', 'Finance Manager', 'Orders, manual payment verification, invoices, and subscriptions', true),
  ('00000000-0000-4000-8000-000000000204', 'license_manager', 'License Manager', 'License issuance, suspension, revocation, and activation management', true),
  ('00000000-0000-4000-8000-000000000205', 'product_manager', 'Product Manager', 'Product catalog, feature definitions, packages, and pricing', true),
  ('00000000-0000-4000-8000-000000000206', 'support_staff', 'Support Staff', 'Customer lookup, order/license inspection, and support operations', true),
  ('00000000-0000-4000-8000-000000000207', 'marketing_manager', 'Marketing Manager', 'External website integrations, Meta Pixel/CAPI tracking, and webhooks', true),
  ('00000000-0000-4000-8000-000000000208', 'read_only', 'Read Only', 'Authorized read-only access across operational views', true)
ON CONFLICT ("key") DO NOTHING;

-- Grant all permissions to super_admin
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT '00000000-0000-4000-8000-000000000201'::uuid, "id" FROM "permissions"
ON CONFLICT DO NOTHING;

-- Seed default Payment Provider Identities
INSERT INTO "payment_providers" ("id", "provider_key", "display_name", "provider_type", "adapter_key", "status")
VALUES
  ('00000000-0000-4000-8000-000000000301', 'bkash_manual', 'bKash (Manual MFS)', 'manual_mfs', 'manual_mfs_adapter', 'enabled'),
  ('00000000-0000-4000-8000-000000000302', 'nagad_manual', 'Nagad (Manual MFS)', 'manual_mfs', 'manual_mfs_adapter', 'enabled'),
  ('00000000-0000-4000-8000-000000000303', 'rocket_manual', 'Rocket (Manual MFS)', 'manual_mfs', 'manual_mfs_adapter', 'enabled'),
  ('00000000-0000-4000-8000-000000000304', 'bank_transfer_bd', 'Bank Transfer (Bangladesh)', 'manual_bank', 'manual_bank_adapter', 'enabled')
ON CONFLICT ("provider_key") DO NOTHING;
