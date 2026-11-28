/**
 * Deterministic reference catalog definitions for currencies, RBAC permissions,
 * system roles, and payment provider presets.
 */

export const SEED_CURRENCIES = [
  { code: "BDT", name: "Bangladeshi Taka", symbol: "৳", exponent: 2, is_active: true },
  { code: "USD", name: "US Dollar", symbol: "$", exponent: 2, is_active: true },
  { code: "EUR", name: "Euro", symbol: "€", exponent: 2, is_active: true },
  { code: "GBP", name: "British Pound", symbol: "£", exponent: 2, is_active: true },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", exponent: 0, is_active: false },
] as const;

export const SEED_PERMISSIONS = [
  { id: "00000000-0000-4000-8000-000000000101", key: "products.read", description: "View products and integration profiles" },
  { id: "00000000-0000-4000-8000-000000000102", key: "products.create", description: "Create new products" },
  { id: "00000000-0000-4000-8000-000000000103", key: "products.update", description: "Edit and archive products" },
  { id: "00000000-0000-4000-8000-000000000104", key: "features.manage", description: "Create and manage product feature definitions" },
  { id: "00000000-0000-4000-8000-000000000105", key: "packages.manage", description: "Create and edit draft packages and prices" },
  { id: "00000000-0000-4000-8000-000000000106", key: "packages.publish", description: "Publish immutable package versions and retire plans" },
  { id: "00000000-0000-4000-8000-000000000107", key: "customers.read", description: "View customers and customer history" },
  { id: "00000000-0000-4000-8000-000000000108", key: "customers.manage", description: "Create and update customer records" },
  { id: "00000000-0000-4000-8000-000000000109", key: "orders.read", description: "View orders and invoices" },
  { id: "00000000-0000-4000-8000-000000000110", key: "orders.create", description: "Create manual and custom-package orders" },
  { id: "00000000-0000-4000-8000-000000000111", key: "orders.manage", description: "Cancel orders and void invoices" },
  { id: "00000000-0000-4000-8000-000000000112", key: "payments.read", description: "View payment methods, submissions, and evidence" },
  { id: "00000000-0000-4000-8000-000000000113", key: "payments.methods.manage", description: "Configure manual MFS and bank payment methods" },
  { id: "00000000-0000-4000-8000-000000000114", key: "payments.approve", description: "Verify and approve manual payment submissions" },
  { id: "00000000-0000-4000-8000-000000000115", key: "payments.reject", description: "Reject manual payment submissions" },
  { id: "00000000-0000-4000-8000-000000000116", key: "subscriptions.read", description: "View subscriptions and renewal periods" },
  { id: "00000000-0000-4000-8000-000000000117", key: "subscriptions.manage", description: "Create renewal invoices, pause, resume, or cancel subscriptions" },
  { id: "00000000-0000-4000-8000-000000000118", key: "licenses.read", description: "View licenses and activations" },
  { id: "00000000-0000-4000-8000-000000000119", key: "licenses.manage", description: "Issue complimentary grants, suspend, resume, or adjust license entitlements" },
  { id: "00000000-0000-4000-8000-000000000120", key: "licenses.revoke", description: "Irreversibly revoke licenses and deactivate installations" },
  { id: "00000000-0000-4000-8000-000000000121", key: "integrations.manage", description: "Register external websites, verify domains, and manage webhooks" },
  { id: "00000000-0000-4000-8000-000000000122", key: "integrations.rotate_credentials", description: "Create, rotate, and revoke site credentials" },
  { id: "00000000-0000-4000-8000-000000000123", key: "tracking.manage", description: "Configure Meta Pixel and Conversions API tracking" },
  { id: "00000000-0000-4000-8000-000000000124", key: "users.manage", description: "Manage staff users, roles, and permissions" },
  { id: "00000000-0000-4000-8000-000000000125", key: "audit_logs.read", description: "Inspect administrative and security audit logs" },
  { id: "00000000-0000-4000-8000-000000000126", key: "tickets.view", description: "View support tickets and their history" },
  { id: "00000000-0000-4000-8000-000000000127", key: "tickets.manage", description: "Create, assign, and resolve support tickets" },
  { id: "00000000-0000-4000-8000-000000000128", key: "leads.view", description: "View leads and their history" },
  { id: "00000000-0000-4000-8000-000000000129", key: "leads.manage", description: "Create, assign, convert, and manage leads" },
  { id: "00000000-0000-4000-8000-000000000130", key: "media.view", description: "View the media library and download files" },
  { id: "00000000-0000-4000-8000-000000000131", key: "media.manage", description: "Upload, rename, move, and delete media files" },
  { id: "00000000-0000-4000-8000-000000000132", key: "integrations.read", description: "View external website integrations, webhooks, and delivery records" },
  { id: "00000000-0000-4000-8000-000000000133", key: "tracking.read", description: "View Meta Pixel and Conversions API tracking events" },
  { id: "00000000-0000-4000-8000-000000000134", key: "expenses.read", description: "View expenses and profit & loss analytics" },
  { id: "00000000-0000-4000-8000-000000000135", key: "expenses.manage", description: "Create, edit, and delete expenses" },
  { id: "00000000-0000-4000-8000-000000000136", key: "expense_categories.manage", description: "Create, edit, and delete expense categories" },
  // OD-13 (2026-11-28): scoped API tokens. super_admin + admin hold it
  // via SEED_PERMISSIONS.map below (migration 0028 grants it in SQL);
  // no other role is granted it. Token scopes can never include this
  // key (API_TOKEN_SCOPES_EXCLUDED in modules/api-tokens/service.ts).
  { id: "00000000-0000-4000-8000-000000000137", key: "api_tokens.manage", description: "Create, list, and revoke scoped API tokens" },
] as const;

export const SEED_ROLES: ReadonlyArray<{
  id: string;
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  permissions: ReadonlyArray<string>;
}> = [
  {
    id: "00000000-0000-4000-8000-000000000201",
    key: "super_admin",
    name: "Super Admin",
    description: "Full platform control across all domains",
    is_system: true,
    permissions: SEED_PERMISSIONS.map((p) => p.key),
  },
  {
    id: "00000000-0000-4000-8000-000000000202",
    key: "admin",
    name: "Admin",
    description: "Administrative access across operational domains",
    is_system: true,
    // Audit D-1 (owner decision 2026-11-19): admin holds every
    // permission, including users.manage — so admin can see and use
    // Staff & Roles. Migration 0014 grants users.manage to the admin
    // role on existing databases; this keeps fresh installs in sync.
    permissions: SEED_PERMISSIONS.map((p) => p.key),
  },
  {
    id: "00000000-0000-4000-8000-000000000203",
    key: "finance_manager",
    name: "Finance Manager",
    description: "Orders, manual payment verification, invoices, and subscriptions",
    is_system: true,
    permissions: [
      "products.read",
      "customers.read",
      "customers.manage",
      "orders.read",
      "orders.create",
      "orders.manage",
      "payments.read",
      "payments.methods.manage",
      "payments.approve",
      "payments.reject",
      "subscriptions.read",
      "subscriptions.manage",
      "licenses.read",
      // Expense module (migration 0019): finance owns expense recording.
      "expenses.read",
      "expenses.manage",
      "expense_categories.manage",
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000204",
    key: "license_manager",
    name: "License Manager",
    description: "License issuance, suspension, revocation, and activation management",
    is_system: true,
    permissions: [
      "products.read",
      "customers.read",
      "orders.read",
      "subscriptions.read",
      "licenses.read",
      "licenses.manage",
      "licenses.revoke",
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000205",
    key: "product_manager",
    name: "Product Manager",
    description: "Product catalog, feature definitions, packages, and pricing",
    is_system: true,
    permissions: [
      "products.read",
      "products.create",
      "products.update",
      "features.manage",
      "packages.manage",
      "packages.publish",
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000206",
    key: "support_staff",
    name: "Support Staff",
    description: "Customer lookup, order/license inspection, and support operations",
    is_system: true,
    permissions: [
      "products.read",
      "customers.read",
      "customers.manage",
      "orders.read",
      "payments.read",
      "subscriptions.read",
      "licenses.read",
      "tickets.view",
      "tickets.manage",
      "leads.view",
      "leads.manage",
      "media.view",
      "media.manage",
      // Expense module (migration 0019): read-only view of expenses.
      "expenses.read",
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000207",
    key: "marketing_manager",
    name: "Marketing Manager",
    description: "External website integrations, Meta Pixel/CAPI tracking, and webhooks",
    is_system: true,
    permissions: [
      "products.read",
      "integrations.manage",
      "integrations.rotate_credentials",
      "tracking.manage",
      // L-6 (audit fix, migration 0016): read-only view of tracking
      // events for the role that configures tracking.
      "tracking.read",
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000208",
    key: "read_only",
    name: "Read Only",
    description: "Authorized read-only access across operational views",
    is_system: true,
    permissions: [
      "products.read",
      "customers.read",
      "orders.read",
      "payments.read",
      "subscriptions.read",
      "licenses.read",
      "audit_logs.read",
      "tickets.view",
      "leads.view",
      "media.view",
      // L-6 (audit fix, migration 0016): read-only view of integrations
      // (webhooks/deliveries/outbox) and tracking events.
      "integrations.read",
      "tracking.read",
      // Expense module (migration 0019): read-only view of expenses + P&L.
      "expenses.read",
    ],
  },
];

export const SEED_PAYMENT_PROVIDERS = [
  {
    id: "00000000-0000-4000-8000-000000000301",
    provider_key: "bkash_manual",
    display_name: "bKash (Manual MFS)",
    provider_type: "manual_mfs" as const,
    adapter_key: "manual_mfs_adapter",
    status: "enabled" as const,
  },
  {
    id: "00000000-0000-4000-8000-000000000302",
    provider_key: "nagad_manual",
    display_name: "Nagad (Manual MFS)",
    provider_type: "manual_mfs" as const,
    adapter_key: "manual_mfs_adapter",
    status: "enabled" as const,
  },
  {
    id: "00000000-0000-4000-8000-000000000303",
    provider_key: "rocket_manual",
    display_name: "Rocket (Manual MFS)",
    provider_type: "manual_mfs" as const,
    adapter_key: "manual_mfs_adapter",
    status: "enabled" as const,
  },
  {
    id: "00000000-0000-4000-8000-000000000304",
    provider_key: "bank_transfer_bd",
    display_name: "Bank Transfer (Bangladesh)",
    provider_type: "manual_bank" as const,
    adapter_key: "manual_bank_adapter",
    status: "enabled" as const,
  },
];
