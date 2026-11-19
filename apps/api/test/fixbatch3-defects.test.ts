/**
 * Fix batch 3 — live re-test defects 2026-11-18 09:13-09:27 +06
 * (staging commit d8ed4523, deploy 762add93).
 *
 * Defect 2: the order wizard's Custom offer path failed server-side on
 * ALL 4 live attempts with the banner "An unexpected internal error
 * occurred." (the API's generic 500) — no order created, no
 * commerce.order.created in the Audit Log.
 *
 * Root cause: the wizard sends each custom feature's entitlement value
 * as a BARE value via parseFeatureValue ("true" -> true, "10" -> 10),
 * but validateFeatureEntitlementValue (contracts, catalog.ts) requires
 * a STRUCTURED object { value_type, value } and throws a plain Error
 * for anything else. The commerce service calls it UNWRAPPED (custom
 * offer path), so the plain Error reaches the dispatcher's catch-all
 * and becomes a 500. The catalog service wraps the same call in
 * try/catch -> AppError 422 — commerce did not.
 *
 * Fix: (a) the wizard sends structured values (looks up each feature's
 * value_type from the loaded product features); (b) the commerce service
 * wraps the validator call -> AppError 422, so a malformed entitlement
 * is a client error, never a 500.
 *
 * (2a) pins (b): bare values from the old wizard payload must return
 * 422 VALIDATION_ERROR, never 500.
 * (2b) pins (a)'s contract: the structured payload the fixed wizard
 * sends must create the order (201) through the real dispatcher.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_fixbatch3`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const DB_NAME = "stackmate_test_fixbatch3";
const API_BASE = "http://localhost:8787";
const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN = "test-setup-token-that-is-at-least-32-chars-long";

describe.skipIf(!DATABASE_URL)("fix batch 3 — custom-offer order creation", () => {
  let envStaging: import("../src/env.ts").StackMateBindings;
  let app: import("../src/app.ts").StackMateAppInstance;
  let store: any;
  let adminClient: Client;
  let sessionCookie = "";
  let adminUserId = "";
  let productId = "";
  let boolFeatureId = "";
  let limitFeatureId = "";
  let customerId = "";

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

    // Product mirroring staging TEST_PRODUCT_001: one boolean feature,
    // one limit feature — the wizard's custom offer lists both.
    const product = await authed("/api/v1/admin/products", {
      method: "POST",
      body: {
        code: "FIXB3-001",
        slug: "fixb3-test-product",
        name: "FixB3 Test Product",
        product_type: "wordpress_plugin",
        fulfillment_type: "software_license",
        distribution_channels: ["direct_download"],
      },
    });
    assert.equal(product.status, 201, `product create: ${JSON.stringify(product.body)}`);
    productId = dataOf(product).id as string;

    const boolFeat = await authed(`/api/v1/admin/products/${productId}/features`, {
      method: "POST",
      body: { feature_key: "flow_test_a", name: "Flow Test A", value_type: "boolean" },
    });
    assert.equal(boolFeat.status, 201, JSON.stringify(boolFeat.body));
    boolFeatureId = dataOf(boolFeat).id as string;

    const limitFeat = await authed(`/api/v1/admin/products/${productId}/features`, {
      method: "POST",
      body: { feature_key: "flow_test_b", name: "Flow Test B", value_type: "limit" },
    });
    assert.equal(limitFeat.status, 201, JSON.stringify(limitFeat.body));
    limitFeatureId = dataOf(limitFeat).id as string;

    const customer = await authed("/api/v1/admin/customers", {
      method: "POST",
      body: {
        name: "Custom Offer Buyer",
        customer_type: "person",
        email: "custom-offer-buyer@example.com",
        phone: null,
        whatsapp: null,
        company_name: null,
        country_code: "BD",
        website: null,
        notes: null,
      },
    });
    assert.equal(customer.status, 201, JSON.stringify(customer.body));
    customerId = dataOf(customer).id as string;
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

  /** The exact custom-offer body the wizard POSTs, modulo the feature values. */
  function customOrderBody(features: Array<{ product_feature_id: string; entitlement_value: unknown }>) {
    return {
      customer_id: customerId,
      product_id: productId,
      item_kind: "custom",
      custom_offer: {
        label: "Wizard Test Package",
        price_kind: "one_time",
        unit_amount_minor: 100000,
        currency_code: "BDT",
        activation_limit: 1,
        features,
      },
      quantity: 1,
      discount_minor: 0,
      tax_minor: 0,
      payment_plan: { kind: "full", due_date: "2026-12-01" },
      activation_mode: "on_full_payment",
      suspend_on_missed_schedule: false,
      grace_days: 3,
    };
  }

  it("(2a) bare entitlement values (old wizard payload) must 422, never 500", async () => {
    // parseFeatureValue("true") -> true, parseFeatureValue("10") -> 10.
    const order = await authed("/api/v1/admin/orders", {
      method: "POST",
      body: customOrderBody([
        { product_feature_id: boolFeatureId, entitlement_value: true },
        { product_feature_id: limitFeatureId, entitlement_value: 10 },
      ]),
    });
    assert.notEqual(order.status, 500, `must never 500: ${JSON.stringify(order.body)}`);
    assert.equal(order.status, 422, `expected 422, got ${order.status}: ${JSON.stringify(order.body)}`);
    assert.equal(order.body.error.code, "VALIDATION_ERROR");
  }, 60_000);

  it("(2b) structured entitlement values (fixed wizard payload) create the order (201)", async () => {
    const order = await authed("/api/v1/admin/orders", {
      method: "POST",
      body: customOrderBody([
        { product_feature_id: boolFeatureId, entitlement_value: { value_type: "boolean", value: true } },
        { product_feature_id: limitFeatureId, entitlement_value: { value_type: "limit", value: 10 } },
      ]),
    });
    assert.equal(order.status, 201, `expected 201, got ${order.status}: ${JSON.stringify(order.body)}`);
    const d = dataOf(order);
    assert.ok(d.order && typeof d.order.id === "string" && d.order.id.length > 0, "order.id must be present");
    assert.ok(typeof d.order.order_number === "string" && d.order.order_number.length > 0, "order.order_number must be present");
    assert.ok(d.invoice && typeof d.invoice.id === "string", "invoice must be present");
    // The granted entitlements must carry the structured values.
    const stored = await adminClient.query(
      `SELECT si.feature_key_snapshot, si.entitlement_value
         FROM order_items oi
         JOIN order_item_entitlement_snapshots s ON s.order_item_id = oi.id
         JOIN order_item_entitlement_snapshot_items si ON si.snapshot_id = s.id
        WHERE oi.order_id = $1 ORDER BY si.feature_key_snapshot`,
      [d.order.id],
    );
    assert.equal(stored.rows.length, 2, `expected 2 snapshot items, got ${stored.rows.length}`);
    assert.deepEqual(stored.rows[0].entitlement_value, { value_type: "boolean", value: true });
    assert.deepEqual(stored.rows[1].entitlement_value, { value_type: "limit", value: 10 });
  }, 60_000);
});
