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
    permissions: SEED_PERMISSIONS.filter((p) => p.key !== "users.manage").map((p) => p.key),
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
