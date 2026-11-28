/**
 * Live re-test defects 2026-11-17 22:37–22:54 +06 (staging commit 1321f016).
 *
 * (1) Customer profile intermittently crashed with the error boundary
 *     "Cannot read properties of undefined (reading 'length')" on first
 *     load of a freshly created customer, recovering on reload.
 *     Root cause: GET /api/v1/admin/customers/:id returned `payments`
 *     as a BARE ARRAY of payment submissions, while CustomerDetailDto
 *     declares `payments: { submissions, transactions }` and the UI
 *     reads `customer.payments.submissions.length` as the tab-count
 *     fallback while the /payments sub-query is still pending. On
 *     first load the sub-query has no cache, so the fallback runs and
 *     throws; on reload the warm cache hides it — hence intermittent.
 *
 * (2) Order wizard navigated to /orders/undefined after creating an
 *     order. Root cause: POST /api/v1/admin/orders returns
 *     `{ order, invoice }`, but the wizard typed the response as
 *     OrderDto and read `created.id` (undefined) for the navigate,
 *     the first-payment claim and the order number.
 *
 * (3) Ticket assign from the detail page: proves the assign endpoint
 *     exists and works (POST /api/v1/admin/tickets/:id/assign) — the
 *     UI select is replaced by a DOM listbox in the same batch because
 *     the native select popup was not operable in the live browser.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_live_defects`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const DB_NAME = "stackmate_test_live_defects";
const API_BASE = "http://localhost:8787";
const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN = "test-setup-token-that-is-at-least-32-chars-long";

describe.skipIf(!DATABASE_URL)("live re-test defects — customer detail payments shape, order create shape, ticket assign", () => {
  let envStaging: import("../src/env.ts").StackMateBindings;
  let app: import("../src/app.ts").StackMateAppInstance;
  let store: any;
  let adminClient: Client;
  let sessionCookie = "";
  let adminUserId = "";

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
        name: "Live Defects Admin",
        email: "live-defects@example.com",
        password: "SuperAdminPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    adminUserId = dataOf(boot).user?.id ?? dataOf(boot).id ?? "";
    assert.ok(adminUserId, "bootstrap must return the admin user id");
    const signedIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "live-defects@example.com", password: "SuperAdminPass123!" },
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

  it("(1) fresh customer detail returns payments as {submissions, transactions}", async () => {
    const created = await authed("/api/v1/admin/customers", {
      method: "POST",
      body: {
        name: "Fresh Detail",
        customer_type: "person",
        email: null,
        phone: "+8801711111111",
        whatsapp: null,
        company_name: null,
        country_code: "BD",
        website: null,
        notes: null,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const customerId = dataOf(created).id as string;

    const detail = await authed(`/api/v1/admin/customers/${customerId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const d = dataOf(detail);
    // The UI reads d.payments.submissions.length as the Payments tab
    // count fallback while the /payments sub-query is pending — a bare
    // array here crashed the profile with "Cannot read properties of
    // undefined (reading 'length')".
    assert.ok(
      d.payments !== null && typeof d.payments === "object" && !Array.isArray(d.payments),
      `payments must be an object, got ${JSON.stringify(d.payments)}`
    );
    assert.ok(Array.isArray(d.payments.submissions), "payments.submissions must be an array");
    assert.ok(Array.isArray(d.payments.transactions), "payments.transactions must be an array");
    assert.equal(d.payments.submissions.length, 0);
    assert.equal(d.payments.transactions.length, 0);
    // Every other tab-count fallback must also be an array.
    for (const key of ["orders", "subscriptions", "licenses", "installations", "tickets", "activity", "contacts", "reports", "addresses"]) {
      assert.ok(Array.isArray(d[key]), `${key} must be an array on the detail`);
    }
  }, 60_000);

  it("(2) create order returns {order: {id, order_number, currency_code}, invoice}", async () => {
    const product = await authed("/api/v1/admin/products", {
      method: "POST",
      body: {
        code: "LIVEDEF-001",
        slug: "livedef-test-product",
        name: "Livedef Test Product",
        product_type: "wordpress_plugin",
        fulfillment_type: "software_license",
        distribution_channels: ["direct_download"],
      },
    });
    assert.equal(product.status, 201, `product create: ${JSON.stringify(product.body)}`);

    const pkg = await authed(`/api/v1/admin/products/${dataOf(product).id}/packages`, {
      method: "POST",
      body: { package_key: "livedef-standard", name: "Livedef Standard", features: [] },
    });
    assert.equal(pkg.status, 201, `package create: ${JSON.stringify(pkg.body)}`);
    const versionId = dataOf(pkg).version.id as string;

    const price = await authed(`/api/v1/admin/package-versions/${versionId}/prices`, {
      method: "POST",
      body: { price_key: "livedef-once", price_kind: "one_time", amount_minor: 100000 },
    });
    assert.equal(price.status, 201, `price create: ${JSON.stringify(price.body)}`);

    const publishedVersion = await authed(
      `/api/v1/admin/package-versions/${versionId}/publish`,
      { method: "POST", body: {} }
    );
    assert.equal(publishedVersion.status, 200, JSON.stringify(publishedVersion.body));
    const publishedProduct = await authed(
      `/api/v1/admin/products/${dataOf(product).id}/publish`,
      { method: "POST", body: {} }
    );
    assert.equal(publishedProduct.status, 200, JSON.stringify(publishedProduct.body));

    const customer = await authed("/api/v1/admin/customers", {
      method: "POST",
      body: {
        name: "Order Buyer",
        customer_type: "person",
        email: "order-buyer@example.com",
        phone: null,
        whatsapp: null,
        company_name: null,
        country_code: "BD",
        website: null,
        notes: null,
      },
    });
    assert.equal(customer.status, 201, JSON.stringify(customer.body));

    const order = await authed("/api/v1/admin/orders", {
      method: "POST",
      body: {
        customer_id: dataOf(customer).id,
        product_id: dataOf(product).id,
        item_kind: "package",
        package_version_id: versionId,
        package_price_id: dataOf(price).id,
        payment_plan: { kind: "full", due_date: "2026-12-01" },
      },
    });
    assert.equal(order.status, 201, `expected 201, got ${order.status}: ${JSON.stringify(order.body)}`);
    const d = dataOf(order);
    // The wizard used to read d.id / d.order_number / d.currency_code —
    // all undefined on this shape — and navigated to /orders/undefined.
    // Pin the contract: there is NO top-level id; the UI must read order.id.
    assert.equal(d.id, undefined, "top-level id must NOT exist — the wizard must read order.id");
    assert.ok(d.order && typeof d.order.id === "string" && d.order.id.length > 0, "order.id must be present");
    assert.ok(typeof d.order.order_number === "string" && d.order.order_number.length > 0, "order.order_number must be present");
    assert.equal(d.order.currency_code, "BDT", "order.currency_code must be BDT");
    assert.ok(d.invoice && typeof d.invoice.id === "string", "invoice must be present");

    // The created order is directly reachable at the id the wizard
    // must navigate to.
    const detail = await authed(`/api/v1/admin/orders/${d.order.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(dataOf(detail).id, d.order.id);
  }, 120_000);

  it("(3) ticket assign endpoint changes the assignee from the detail page", async () => {
    const ticket = await authed("/api/v1/admin/tickets", {
      method: "POST",
      body: {
        title: "Assign from detail check",
        description: "The detail-page assignee control must be able to change the assignee.",
        priority: "medium",
        category: "other",
      },
    });
    assert.equal(ticket.status, 201, `ticket create: ${JSON.stringify(ticket.body)}`);
    const ticketId = dataOf(ticket).id as string;

    const assigned = await authed(`/api/v1/admin/tickets/${ticketId}/assign`, {
      method: "POST",
      body: { assignee_user_id: adminUserId },
    });
    assert.equal(assigned.status, 200, `assign: ${JSON.stringify(assigned.body)}`);
    assert.equal(dataOf(assigned).assignee_user_id, adminUserId);

    const detail = await authed(`/api/v1/admin/tickets/${ticketId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(dataOf(detail).assignee_user_id, adminUserId);

    // Unassign again — null is a valid assignee (back to Unassigned).
    const unassigned = await authed(`/api/v1/admin/tickets/${ticketId}/assign`, {
      method: "POST",
      body: { assignee_user_id: null },
    });
    assert.equal(unassigned.status, 200, `unassign: ${JSON.stringify(unassigned.body)}`);
    assert.equal(dataOf(unassigned).assignee_user_id, null);
  }, 60_000);
});
