/**
 * Fix batch 2026-11-17 (ADR-0009 decision 11) — null-payload regression.
 *
 * LIVE FAILURE: every "Add customer" submission failed with the generic
 * toast "One or more fields failed validation." (6 attempts, 2026-11-17
 * 16:18–16:38 +06). Root cause: the admin UI's `customerFormToCreateBody`
 * sends JSON `null` for every empty optional field, but the valibot
 * schemas declared those fields `.optional()` — which accepts
 * `undefined`, NOT `null` — so `CreateCustomerSchema.parse` 422'd every
 * submission. The vitest suite never caught it because tests called the
 * service with omitted/`undefined` fields, never the UI's null payload.
 *
 * These tests post the EXACT UI payload shape (all optional fields
 * present as `null`) through the REAL HTTP dispatcher and assert 201:
 *   (1) Add Customer, name + phone only, every optional field null.
 *   (2) Add Customer with values incl. website — website is stored and
 *       returned on the detail (migration 0011; it used to be stripped).
 *   (3) Address create with the UI's fixed schema keys + nulls — lines
 *       are stored (the old short keys were stripped) and the detail
 *       returns the line1/line2 DTO shape (the old raw record read
 *       blank in the UI).
 *   (4) Order wizard inline `new_customer` with nulls → 201. The
 *       package order is built end to end through the API (product →
 *       package draft → price → publish version → publish product),
 *       which also proves the publish path the staging re-test needs:
 *       the wizard's product picker only lists `active` products with
 *       a published version, and TEST_PRODUCT_001 was Draft.
 *   (5) Ticket assignee disambiguation: two staff sharing one name —
 *       the ticket detail embeds the assignee's email + roles.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_null_payload`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const DB_NAME = "stackmate_test_null_payload";
const API_BASE = "http://localhost:8787";
const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN = "0123456789abcdef".repeat(4);

describe.skipIf(!DATABASE_URL)("customer create — UI null payloads accepted (ADR-0009 decision 11)", () => {
  let envStaging: import("../src/env.ts").StackMateBindings;
  let app: import("../src/app.ts").StackMateAppInstance;
  let store: any;
  let adminClient: Client;
  let sessionCookie = "";

  async function apiRequest(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      origin?: string;
    } = {}
  ): Promise<{ status: number; headers: Headers; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.origin !== undefined) headers.set("Origin", options.origin);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(new Request(`${API_BASE}${path}`, init), envStaging);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  }

  function cookiePairs(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    return setCookies.map((c) => c.split(";")[0]!).join("; ");
  }

  async function authed(path: string, options: { method?: string; body?: unknown } = {}) {
    return apiRequest(path, { ...options, cookie: sessionCookie, origin: STAGING_ORIGIN });
  }

  // Admin API responses are enveloped ({ data, meta }); collections nest
  // items under data.items. Better Auth plugin routes are raw.
  const dataOf = (res: { body: any }) => res.body.data;

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const url = new URL(DATABASE_URL);
    assert.ok(
      url.pathname.replace(/^\//, "").includes("test"),
      "Refusing to run: DATABASE_URL database name must contain 'test'.",
    );

    const { createStackMateApp } = await import("../src/app.ts");
    const { resolveRuntimeConfig } = await import("../src/env.ts");
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");

    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    const maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await maintenanceClient.query(`CREATE DATABASE "${DB_NAME}"`);
    await maintenanceClient.end();

    const dbUrl = new URL(DATABASE_URL);
    dbUrl.pathname = `/${DB_NAME}`;

    const hex64 = "0123456789abcdef".repeat(4);
    envStaging = resolveRuntimeConfig({
      APP_ENV: "staging",
      BETTER_AUTH_SECRET: hex64,
      ENCRYPTION_KEY_V1: hex64,
      LICENSE_VERIFIER_SECRET: hex64,
      CHECKOUT_TOKEN_SECRET: hex64,
      SETUP_TOKEN: TEST_SETUP_TOKEN,
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl.toString() },
      BETTER_AUTH_URL: STAGING_ORIGIN,
      TRUSTED_ORIGINS: STAGING_ORIGIN,
      API_URL: STAGING_ORIGIN,
      APP_URL: STAGING_ORIGIN,
    });

    adminClient = new Client({ connectionString: dbUrl.toString() });
    await adminClient.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      await adminClient.query(sql);
    }

    store = await DrizzleStore.create({ connectionString: dbUrl.toString() });
    app = createStackMateApp(store);

    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Null Payload Admin",
        email: "null-payload@example.com",
        password: "SuperAdminPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signedIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "null-payload@example.com", password: "SuperAdminPass123!" },
    });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    sessionCookie = cookiePairs(signedIn.headers);
    assert.ok(sessionCookie.length > 0, "sign-in must set a session cookie");
  }, 120_000);

  afterAll(async () => {
    try {
      await store?.close();
    } catch {}
    try {
      await adminClient?.end();
    } catch {}
    try {
      const maintenanceUrl = new URL(DATABASE_URL!);
      maintenanceUrl.pathname = "/postgres";
      const mc = new Client({ connectionString: maintenanceUrl.toString() });
      await mc.connect();
      await mc.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
      await mc.end();
    } catch {}
  });

  it("(1) exact UI payload — name + phone only, every optional field null → 201", async () => {
    // Byte-for-byte the shape customerFormToCreateBody emits for a
    // minimal form ("" → null on every optional field).
    const res = await authed("/api/v1/admin/customers", {
      method: "POST",
      body: {
        name: "Null Payload",
        customer_type: "person",
        email: null,
        phone: "+8801712345678",
        whatsapp: null,
        company_name: null,
        country_code: "BD",
        website: null,
        notes: null,
      },
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(dataOf(res).customer_number, "response must carry a customer number");
    assert.equal(dataOf(res).email, null);
    assert.equal(dataOf(res).website, null);
    assert.equal(dataOf(res).phone, "+8801712345678");

    const detail = await authed(`/api/v1/admin/customers/${dataOf(res).id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(dataOf(detail).website, null);
    assert.equal(dataOf(detail).phone, "+8801712345678");
  }, 60_000);

  it("(2) UI payload with values incl. website → 201 and website is stored + returned", async () => {
    const res = await authed("/api/v1/admin/customers", {
      method: "POST",
      body: {
        name: "Website Owner",
        customer_type: "business",
        email: "website-owner@example.com",
        phone: null,
        whatsapp: null,
        company_name: "Website Co",
        country_code: "BD",
        website: "https://website-owner.example.com",
        notes: null,
      },
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(dataOf(res).website, "https://website-owner.example.com");

    const detail = await authed(`/api/v1/admin/customers/${dataOf(res).id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(dataOf(detail).website, "https://website-owner.example.com");
  }, 60_000);

  it("(3) address with schema keys + nulls → 201, lines stored, detail returns line1 shape", async () => {
    const customer = await authed("/api/v1/admin/customers", {
      method: "POST",
      body: {
        name: "Address Owner",
        customer_type: "person",
        email: "address-owner@example.com",
        phone: null,
        whatsapp: null,
        company_name: null,
        country_code: "BD",
        website: null,
        notes: null,
      },
    });
    assert.equal(customer.status, 201, JSON.stringify(customer.body));

    const created = await authed(
      `/api/v1/admin/customers/${dataOf(customer).id}/addresses`,
      {
        method: "POST",
        body: {
          address_line_1: "House 12, Road 5",
          address_line_2: null,
          city: "Dhaka",
          state_or_region: null,
          postal_code: null,
          country_code: "BD",
          is_default: true,
        },
      }
    );
    assert.equal(created.status, 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    // The response is the UI's DTO shape, not the raw DB record.
    assert.equal(dataOf(created).line1, "House 12, Road 5");
    assert.equal(dataOf(created).line2, null);
    assert.equal(dataOf(created).city, "Dhaka");

    const detail = await authed(`/api/v1/admin/customers/${dataOf(customer).id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(dataOf(detail).addresses.length, 1);
    assert.equal(dataOf(detail).addresses[0].line1, "House 12, Road 5");
    assert.equal(dataOf(detail).addresses[0].city, "Dhaka");
  }, 60_000);

  it("(4) wizard inline new_customer with nulls → 201 (publish path end to end)", async () => {
    const product = await authed("/api/v1/admin/products", {
      method: "POST",
      body: {
        code: "NULLPAY-001",
        slug: "nullpay-test-product",
        name: "Nullpay Test Product",
        product_type: "wordpress_plugin",
        fulfillment_type: "software_license",
        distribution_channels: ["direct_download"],
      },
    });
    assert.equal(product.status, 201, `product create: ${JSON.stringify(product.body)}`);

    const pkg = await authed(`/api/v1/admin/products/${dataOf(product).id}/packages`, {
      method: "POST",
      body: { package_key: "nullpay-standard", name: "Nullpay Standard", features: [] },
    });
    assert.equal(pkg.status, 201, `package create: ${JSON.stringify(pkg.body)}`);
    const versionId = dataOf(pkg).version.id as string;

    const price = await authed(`/api/v1/admin/package-versions/${versionId}/prices`, {
      method: "POST",
      body: { price_key: "nullpay-once", price_kind: "one_time", amount_minor: 50000 },
    });
    assert.equal(price.status, 201, `price create: ${JSON.stringify(price.body)}`);
    assert.equal(dataOf(price).status, "active", "a new price must be active");

    const publishedVersion = await authed(
      `/api/v1/admin/package-versions/${versionId}/publish`,
      { method: "POST", body: {} }
    );
    assert.equal(publishedVersion.status, 200, `publish version: ${JSON.stringify(publishedVersion.body)}`);
    assert.equal(dataOf(publishedVersion).status, "published");

    const publishedProduct = await authed(
      `/api/v1/admin/products/${dataOf(product).id}/publish`,
      { method: "POST", body: {} }
    );
    assert.equal(publishedProduct.status, 200, `publish product: ${JSON.stringify(publishedProduct.body)}`);
    assert.equal(dataOf(publishedProduct).status, "active");

    // The wizard's product picker only lists active products — the
    // published product must now appear there.
    const products = await authed("/api/v1/admin/products");
    assert.equal(products.status, 200, JSON.stringify(products.body));
    const listed = dataOf(products).items as Array<{ id: string; status: string }>;
    assert.ok(
      listed.some((p) => p.id === dataOf(product).id && p.status === "active"),
      "published product must be listed as active"
    );

    // The order wizard's exact inline-customer shape: the same null
    // payload as (1), nested under new_customer.
    const order = await authed("/api/v1/admin/orders", {
      method: "POST",
      body: {
        new_customer: {
          name: "Wizard Buyer",
          customer_type: "person",
          email: null,
          phone: "+8801912345678",
          whatsapp: null,
          company_name: null,
          country_code: "BD",
          website: null,
          notes: null,
        },
        product_id: dataOf(product).id,
        item_kind: "package",
        package_version_id: versionId,
        package_price_id: dataOf(price).id,
        payment_plan: { kind: "full", due_date: "2026-12-01" },
      },
    });
    assert.equal(order.status, 201, `expected 201, got ${order.status}: ${JSON.stringify(order.body)}`);
    assert.ok(dataOf(order).order.customer_id, "order must carry the inline customer");
    const buyer = await authed(`/api/v1/admin/customers/${dataOf(order).order.customer_id}`);
    assert.equal(buyer.status, 200, JSON.stringify(buyer.body));
    assert.equal(dataOf(buyer).name, "Wizard Buyer");
    assert.equal(dataOf(buyer).phone, "+8801912345678");
  }, 120_000);

  it("(5) ticket assignee disambiguation — same name, different email/role on the detail", async () => {
    const second = await authed("/api/v1/admin/users", {
      method: "POST",
      body: {
        name: "Null Payload Admin",
        email: "null-payload-second@example.com",
        password: "SecondAdminPass123!",
        role_keys: ["admin"],
      },
    });
    assert.equal(second.status, 201, `second staff create: ${JSON.stringify(second.body)}`);
    const secondId = dataOf(second).user.id as string;
    assert.ok(secondId, "created staff must have an id");

    const ticket = await authed("/api/v1/admin/tickets", {
      method: "POST",
      body: {
        title: "Same-name assignee check",
        description: "The assignee picker showed two identical names.",
        priority: "medium",
        category: "other",
        assignee_user_id: secondId,
      },
    });
    assert.equal(ticket.status, 201, `ticket create: ${JSON.stringify(ticket.body)}`);

    const detail = await authed(`/api/v1/admin/tickets/${dataOf(ticket).id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(dataOf(detail).assignee_name, "Null Payload Admin");
    assert.equal(dataOf(detail).assignee_email, "null-payload-second@example.com");
    assert.ok(
      Array.isArray(dataOf(detail).assignee_roles) && dataOf(detail).assignee_roles.includes("admin"),
      `assignee roles must include admin, got ${JSON.stringify(dataOf(detail).assignee_roles)}`
    );
  }, 60_000);
});
