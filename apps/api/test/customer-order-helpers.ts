/**
 * Shared harness for the Customer + Order batch suites (ADR-0009).
 *
 * Each suite gets its own fresh database (own name, migrations applied
 * from db/migrations/meta/_journal.json, dropped afterwards) and a
 * single DrizzleStore. Seeds push literal records into
 * `store.withTransaction` — the store's SyncSpecs persist them.
 *
 * Seeded numbers are literal test values (CUS-T-… / ORD-T-…); they never
 * touch the sequence counters. No real secrets anywhere (HEX64 is a
 * test-only fixture value).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type {
  CustomerRecord,
  DatabaseState,
  IntegratedSiteRecord,
  InvoiceRecord,
  LicenseRecord,
  OrderRecord,
  PaymentMethodRecord,
  ProductRecord,
  SubscriptionRecord,
} from "../src/platform/db/store.ts";
import type { StaffPrincipal } from "../src/modules/identity/service.ts";

export const DATABASE_URL = process.env.DATABASE_URL ?? "";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);

export const SUPER_ACTOR: StaffPrincipal = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Test Super Admin",
    email: "super@stackmate.local",
    status: "active",
    avatar_url: null,
  },
  session_id: "test-session",
  roles: ["super_admin"],
  permissions: [],
  two_factor_enabled: false,
  two_factor_setup_required: false,
};

export function testNow(): string {
  return new Date().toISOString();
}

export async function setupTestDb(dbName: string): Promise<{
  store: import("../src/platform/db/drizzle-store.ts").DrizzleStore;
  adminClient: Client;
  cleanup: () => Promise<void>;
}> {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
  const url = new URL(DATABASE_URL);
  assert.ok(
    url.pathname.replace(/^\//, "").includes("test"),
    "Refusing to run: DATABASE_URL database name must contain 'test'.",
  );

  const maintenanceUrl = new URL(DATABASE_URL);
  maintenanceUrl.pathname = "/postgres";
  const maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
  await maintenanceClient.connect();
  await maintenanceClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await maintenanceClient.query(`CREATE DATABASE "${dbName}"`);
  await maintenanceClient.end();

  const dbUrl = new URL(DATABASE_URL);
  dbUrl.pathname = `/${dbName}`;

  const adminClient = new Client({ connectionString: dbUrl.toString() });
  await adminClient.connect();
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
    await adminClient.query(sql);
  }

  const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
  const store = await DrizzleStore.create({ connectionString: dbUrl.toString() });

  // The suites drive services with SUPER_ACTOR; audit rows (and report /
  // comment author ids) FK-reference users, so the actor must exist as a
  // user row or every audited write fails on audit_logs_actor_user_id_fkey.
  await store.withTransaction((state) => {
    state.users.push({
      id: SUPER_ACTOR.user.id,
      name: SUPER_ACTOR.user.name,
      email: SUPER_ACTOR.user.email,
      email_verified: true,
      password_hash: "test-only-hash",
      two_factor_enabled: false,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  const cleanup = async () => {
    try {
      await store.close();
    } catch {}
    try {
      await adminClient.end();
    } catch {}
    try {
      const mc = new Client({ connectionString: maintenanceUrl.toString() });
      await mc.connect();
      await mc.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await mc.end();
    } catch {}
  };

  return { store, adminClient, cleanup };
}

/* ------------------------------------------------------------------ */
/* Seeds (take the in-transaction state, return the pushed record)     */
/* ------------------------------------------------------------------ */
export function seedProduct(
  state: DatabaseState,
  overrides: Partial<ProductRecord> = {},
): ProductRecord {
  const now = testNow();
  const product: ProductRecord = {
    id: randomUUID(),
    code: `TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
    slug: `test-product-${randomUUID().slice(0, 8)}`,
    name: "Test Product",
    description: null,
    product_type: "wordpress_plugin",
    fulfillment_type: "digital_service",
    distribution_channels: [],
    default_activation_limit: 3,
    offline_grace_hours: 72,
    status: "active",
    website_url: null,
    documentation_url: null,
    created_by_user_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  state.products.push(product);
  return product;
}

export function seedPaymentMethod(state: DatabaseState): PaymentMethodRecord {
  const now = testNow();
  let provider = state.payment_providers.find((p) => p.status === "enabled");
  if (!provider) {
    provider = {
      id: randomUUID(),
      provider_key: "test_manual",
      display_name: "Test Manual",
      provider_type: "manual_bank",
      adapter_key: "manual",
      status: "enabled",
    };
    state.payment_providers.push(provider);
  }
  const method: PaymentMethodRecord = {
    id: randomUUID(),
    provider_id: provider.id,
    method_key: `test_manual_account_${randomUUID().slice(0, 8)}`,
    display_name: "Test Manual Account",
    method_kind: "bank_account",
    account_type: "personal",
    account_label: "Test account",
    instructions: null,
    configuration: {
      account_number: "0123456789",
      // Test-only method: no transaction id required, so claims in the
      // suites can focus on amounts/allocation instead of receipts.
      transaction_id_requirement: "disabled",
    },
    transfer_rails: ["npsb"],
    is_enabled: true,
    sort_order: 1,
    created_at: now,
  };
  state.payment_methods.push(method);
  return method;
}

export function seedCustomer(
  state: DatabaseState,
  overrides: Partial<CustomerRecord> = {},
): CustomerRecord {
  const now = testNow();
  const n = randomUUID().slice(0, 8).toUpperCase();
  const customer: CustomerRecord = {
    id: randomUUID(),
    customer_number: `CUS-T-${n}`,
    customer_type: "person",
    name: "Test Customer",
    email: null,
    normalized_email: null,
    phone: null,
    normalized_phone: null,
    whatsapp: null,
    credit_balance_minor: 0,
    company_name: null,
    website: null,
    country_code: "BD",
    status: "active",
    registration_source: "admin",
    notes: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  state.customers.push(customer);
  return customer;
}

/** A custom-offer order (no package), total configurable via overrides. */
export function seedOrder(
  state: DatabaseState,
  customerId: string,
  product: ProductRecord,
  overrides: Partial<OrderRecord> = {},
): OrderRecord {
  const now = testNow();
  const n = randomUUID().slice(0, 8).toUpperCase();
  const itemId = randomUUID();
  const order: OrderRecord = {
    id: randomUUID(),
    order_number: `ORD-T-${n}`,
    public_reference: `ord_test_${n.toLowerCase()}`,
    customer_id: customerId,
    source: "admin",
    integrated_site_id: null,
    status: "awaiting_payment",
    payment_status: "unpaid",
    currency_code: "BDT",
    subtotal_minor: 100000,
    discount_minor: 0,
    tax_minor: 0,
    total_minor: 100000,
    customer_note: null,
    internal_note: null,
    items: [
      {
        id: itemId,
        order_id: "",
        product_id: product.id,
        package_id: null,
        package_version_id: null,
        package_price_id: null,
        item_kind: "custom",
        fulfillment_type_snapshot: "digital_service",
        product_name_snapshot: product.name,
        package_name_snapshot: null,
        package_version_snapshot: null,
        price_kind_snapshot: "one_time",
        interval_unit_snapshot: null,
        interval_count_snapshot: null,
        activation_limit_snapshot: product.default_activation_limit,
        quantity: 1,
        unit_amount_minor: 100000,
        line_subtotal_minor: 100000,
        line_discount_minor: 0,
        line_tax_minor: 0,
        line_total_minor: 100000,
        currency_code: "BDT",
        entitlement_snapshot: {
          id: randomUUID(),
          order_item_id: itemId,
          source_type: "custom_offer",
          source_package_version_id: null,
          schema_version: 1,
          snapshot_hash: "test-hash",
          items: [],
          created_at: now,
        },
        created_at: now,
      },
    ],
    attribution: null,
    created_by_user_id: null,
    activation_mode: "on_full_payment",
    activation_percent: null,
    activation_date: null,
    suspend_on_missed_schedule: false,
    grace_days: 3,
    payment_method_id: null,
    lead_id: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    cancelled_at: null,
    ...overrides,
  };
  order.items[0]!.order_id = order.id;
  state.orders.push(order);
  return order;
}

export function seedInvoice(
  state: DatabaseState,
  order: OrderRecord,
  customerId: string,
): InvoiceRecord {
  const now = testNow();
  const invoice: InvoiceRecord = {
    id: randomUUID(),
    invoice_number: `INV-T-${randomUUID().slice(0, 8).toUpperCase()}`,
    customer_id: customerId,
    order_id: order.id,
    subscription_id: null,
    invoice_type: "initial",
    status: "open",
    currency_code: order.currency_code,
    subtotal_minor: order.subtotal_minor,
    discount_minor: order.discount_minor,
    tax_minor: order.tax_minor,
    total_minor: order.total_minor,
    amount_paid_minor: 0,
    amount_due_minor: order.total_minor,
    issued_at: now,
    paid_at: null,
    items: [],
    created_at: now,
  };
  state.invoices.push(invoice);
  return invoice;
}

export function seedSubscription(
  state: DatabaseState,
  overrides: Partial<SubscriptionRecord> & {
    customer_id: string;
    product_id: string;
  },
): SubscriptionRecord {
  const now = testNow();
  const { customer_id, product_id, ...rest } = overrides;
  const sub: SubscriptionRecord = {
    id: randomUUID(),
    subscription_number: `SUB-T-${randomUUID().slice(0, 8).toUpperCase()}`,
    customer_id,
    product_id,
    source_order_item_id: null,
    source_package_version_id: null,
    status: "active",
    billing_kind: "recurring",
    interval_unit: "month",
    interval_count: 1,
    currency_code: "BDT",
    unit_amount_minor: 100000,
    grace_days: 3,
    current_period_start: now,
    current_period_end: now,
    next_renewal_at: null,
    cancel_at_period_end: false,
    cancelled_at: null,
    periods: [],
    created_at: now,
    updated_at: now,
    ...rest,
  };
  state.subscriptions.push(sub);
  return sub;
}

export function seedLicense(
  state: DatabaseState,
  overrides: Partial<LicenseRecord> & {
    product_id: string;
    customer_id: string;
  },
): LicenseRecord {
  const now = testNow();
  const { product_id, customer_id, ...rest } = overrides;
  const licenseId = randomUUID();
  // F-14: the license points at a REAL snapshot row. The FK is
  // DEFERRABLE INITIALLY DEFERRED (migration 0014) because the store
  // persists the license row before its snapshot in one transaction;
  // a random UUID with no row fails the check at COMMIT.
  const snapshotId = randomUUID();
  const license: LicenseRecord = {
    id: licenseId,
    license_number: `LIC-T-${randomUUID().slice(0, 8).toUpperCase()}`,
    product_id,
    customer_id,
    source_order_item_id: null,
    subscription_id: null,
    license_key_hash: `test-hash-${randomUUID()}`,
    license_key_hint: "TEST-****",
    status: "active",
    activation_limit: 3,
    valid_from: now,
    expires_at: null,
    grace_until: null,
    current_entitlement_snapshot_id: snapshotId,
    snapshots: [
      {
        id: snapshotId,
        license_id: licenseId,
        version_number: 1,
        source_type: "manual_grant",
        effective_at: now,
        reason: null,
        snapshot_hash: `test-${randomUUID().replace(/-/g, "")}`,
        items: [],
        created_by_user_id: null,
        created_at: now,
      },
    ],
    activations: [],
    issued_at: now,
    created_at: now,
    updated_at: now,
    ...rest,
  };
  state.licenses.push(license);
  return license;
}

export function seedSite(state: DatabaseState): IntegratedSiteRecord {
  const now = testNow();
  const site: IntegratedSiteRecord = {
    id: randomUUID(),
    site_key: `site_test_${randomUUID().slice(0, 8)}`,
    name: "Test Site",
    environment: "staging",
    status: "active",
    api_version: "v1",
    allowed_capabilities: ["leads.create", "checkout.create", "tracking.events.write"],
    product_ids: [],
    domains: [],
    created_at: now,
    updated_at: now,
  };
  state.integrated_sites.push(site);
  return site;
}
