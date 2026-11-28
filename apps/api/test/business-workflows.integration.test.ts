/**
 * Business-workflow integration tests (Postgres-backed, hermetic).
 *
 * Drives the FULL business workflow end to end over HTTP against the real
 * DrizzleStore + createStackMateApp factory, asserting PostgreSQL state
 * directly after every step — not just HTTP status codes:
 *
 *   staff auth + RBAC -> product + plan -> customer -> order ->
 *   manual payment submission -> staff verification (concurrent race) ->
 *   subscription activation -> license issuance -> license activation ->
 *   activation-limit enforcement -> renewal -> expiry ->
 *   suspension + revocation -> external-site auth (site key + HMAC S2S) ->
 *   idempotency -> transactional outbox + webhooks ->
 *   verified-purchase Meta Purchase event -> rollback safety.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres, e.g.:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test
 * The suite creates its OWN fresh database `stackmate_test_biz` on the
 * same server (derived from DATABASE_URL), applies every journal
 * migration there, and DROPS it afterwards. Without DATABASE_URL the
 * whole suite SKIPS cleanly.
 *
 * Deliberately NOT covered here (no such feature exists in the code):
 * - Automatic subscription expiry: there is no scheduled job or endpoint
 *   that transitions a subscription to `expired` (the scheduled handler
 *   only processes the transactional outbox). Expiry is enforced at
 *   license-validation time from `licenses.expires_at` / `grace_until`
 *   (see `assertLicenseIsUsable`, apps/api/src/modules/licensing/service.ts).
 *   The expiry test therefore time-travels those columns (the same state
 *   an expiry job would observe) and asserts validation denies access.
 * - License `status = 'expired'` is never persisted by validation: the
 *   status flip happens inside `withTransaction` just before the
 *   LICENSE_EXPIRED throw, so the transaction rolls it back. The test
 *   asserts the 403 AND documents the surviving DB status.
 */
import { describe, it, beforeAll, afterAll, vi } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import {
  issueCheckoutAccessToken,
  signCanonicalServerRequest,
} from "../src/platform/crypto/index.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const BIZ_DB_NAME = "stackmate_test_biz";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);

if (!DATABASE_URL) {
  console.log(
    "[business-workflows.integration] DATABASE_URL is not set — skipping. " +
      "Set DATABASE_URL to a local test Postgres to run it."
  );
}

const uniq = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const SUPER_EMAIL = "biz-super-admin@stackmate.local";
const SUPER_PASSWORD = "BizSuperAdminPass123!";
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FINANCE_EMAIL = "biz-finance@stackmate.local";
const FINANCE_PASSWORD = "BizFinancePass123!";
const READONLY_EMAIL = "biz-readonly@stackmate.local";
const READONLY_PASSWORD = "BizReadOnlyPass123!";

describe.skipIf(!DATABASE_URL)("Business workflows (Postgres)", () => {
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let app: ReturnType<typeof createStackMateApp>;
  let store: any;
  let adminClient: Client;
  let bizDbUrl: string;

  // Shared workflow state, built up test by test in order.
  let superCookie = "";
  let financeCookie = "";
  let readOnlyCookie = "";
  let productId = "";
  let featureId = "";
  let versionId = "";
  let priceId = "";
  let customerId = "";
  let workflowCustomerId = ""; // customer the public checkout created (see test 8 note)
  let adminOrderId = "";
  let siteId = "";
  let siteKey = "";
  let hmacKeyId = "";
  let hmacSharedSecret = "";
  let publicOrderId = "";
  let publicReference = "";
  let checkoutToken = "";
  let submissionId = "";
  let subscriptionId = "";
  let licenseId = "";
  let licenseKey = "";
  let period1End = "";
  let grantLicenseId = "";
  let grantLicenseKey = "";
  let renewalOrderId = "";
  let renewalReference = "";
  let b1CancelKeyId = ""; // Batch 1: credential minted with orders.cancel:own
  let b1CancelSecret = "";

  type ApiOpts = {
    method?: string;
    body?: unknown;
    cookie?: string;
    token?: string;
    headers?: Record<string, string>;
  };

  async function apiRequest(
    reqPath: string,
    options: ApiOpts = {}
  ): Promise<{ status: number; headers: Headers; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(new Request(`http://localhost:8787${reqPath}`, init), env);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  }

  function extractSessionCookie(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    const pair = setCookies.find((c) => c.startsWith("better-auth.session_token="));
    assert.ok(pair, "sign-in must set a better-auth.session_token cookie");
    return pair!.split(";")[0]!;
  }

  async function signIn(email: string, password: string): Promise<string> {
    const res = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(res.status, 200, `sign-in failed for ${email}: ${JSON.stringify(res.body)}`);
    return extractSessionCookie(res.headers);
  }

  // NOTE: node-postgres returns bigint columns (all *_minor money
  // columns) as strings — assertions on them use Number(...) explicitly.
  async function rows(sql: string, params: unknown[] = []): Promise<any[]> {
    return (await adminClient.query(sql, params)).rows;
  }

  async function one(sql: string, params: unknown[] = []): Promise<any> {
    const r = await rows(sql, params);
    assert.equal(r.length, 1, `expected exactly 1 row for ${sql}, got ${r.length}`);
    return r[0];
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const r = await rows(sql, params);
    return Number(r[0].count);
  }

  async function countWhere(table: string, where: string, params: unknown[] = []): Promise<number> {
    return count(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, params);
  }

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const url = new URL(DATABASE_URL);
    assert.ok(
      url.pathname.replace(/^\//, "").includes("test"),
      "Refusing to run: DATABASE_URL database name must contain 'test'."
    );
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });

    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    const maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${BIZ_DB_NAME}"`);
    await maintenanceClient.query(`CREATE DATABASE "${BIZ_DB_NAME}"`);
    await maintenanceClient.end();

    const bizUrl = new URL(DATABASE_URL);
    bizUrl.pathname = `/${BIZ_DB_NAME}`;
    bizDbUrl = bizUrl.toString();

    adminClient = new Client({ connectionString: bizDbUrl });
    await adminClient.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      await adminClient.query(sql);
    }

    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
    store = await DrizzleStore.create({ connectionString: bizDbUrl });
    app = createStackMateApp(store);
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
      await mc.query(`DROP DATABASE IF EXISTS "${BIZ_DB_NAME}"`);
      await mc.end();
    } catch {}
  });

  it("1. staff auth + RBAC: unauthenticated 401, read-only/finance forbidden from writes, super_admin allowed", async () => {
    // No session at all -> 401 on admin endpoints.
    const anonMe = await apiRequest("/api/v1/admin/me");
    assert.equal(anonMe.status, 401);
    const anonCreate = await apiRequest("/api/v1/admin/products", {
      method: "POST",
      body: { code: "NOPE", slug: "nope", name: "Nope", product_type: "wordpress_plugin" },
    });
    assert.equal(anonCreate.status, 401);

    // Bootstrap the first super admin (fresh DB: no staff exists yet).
    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: { name: "Biz Super Admin", email: SUPER_EMAIL, password: SUPER_PASSWORD, setupToken: TEST_SETUP_TOKEN },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    superCookie = await signIn(SUPER_EMAIL, SUPER_PASSWORD);
    const me = await apiRequest("/api/v1/admin/me", { cookie: superCookie });
    assert.equal(me.status, 200);
    assert.ok(me.body.data.roles.includes("super_admin"));

    // Second bootstrap must fail: exactly one super admin can be bootstrapped.
    const bootAgain = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: { name: "Second", email: "second@stackmate.local", password: "SecondPass123!", setupToken: TEST_SETUP_TOKEN },
    });
    assert.notEqual(bootAgain.status, 201, "bootstrap must be one-time only");

    // Create a read-only user and a finance manager via the admin API.
    for (const [name, email, password, roleKeys] of [
      ["Biz Read Only", READONLY_EMAIL, READONLY_PASSWORD, ["read_only"]],
      ["Biz Finance", FINANCE_EMAIL, FINANCE_PASSWORD, ["finance_manager"]],
    ] as const) {
      const created = await apiRequest("/api/v1/admin/users", {
        method: "POST",
        cookie: superCookie,
        body: { name, email, password, role_keys: roleKeys },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      // OD-06: admin-created staff start UNVERIFIED and cannot sign in
      // until they verify. This suite exercises business workflows, not
      // verification, so the fixture marks the row verified directly
      // (the test-only equivalent of clicking the link). The Better Auth
      // sign-in path reads emailVerified from this DB row, so the SQL
      // flip is enough even if the store's in-memory state is stale.
      await adminClient.query("UPDATE users SET email_verified = true WHERE id = $1", [
        created.body.data.user.id,
      ]);
    }
    readOnlyCookie = await signIn(READONLY_EMAIL, READONLY_PASSWORD);
    financeCookie = await signIn(FINANCE_EMAIL, FINANCE_PASSWORD);

    const productBody = {
      code: "BIZMATE",
      slug: "biz-mate-plugin",
      name: "BizMate WooCommerce Plugin",
      product_type: "wordpress_plugin",
    };
    // Read-only role: may read, may NOT write.
    const roRead = await apiRequest("/api/v1/admin/products", { cookie: readOnlyCookie });
    assert.equal(roRead.status, 200, "read_only must be able to read the catalog");
    const roWrite = await apiRequest("/api/v1/admin/products", {
      method: "POST",
      cookie: readOnlyCookie,
      body: productBody,
    });
    assert.equal(roWrite.status, 403, JSON.stringify(roWrite.body));
    assert.equal(
      await countWhere("products", "code = $1", ["BIZMATE"]),
      0,
      "a forbidden write must leave no product row behind"
    );

    // Finance manager has payments.approve but NOT products.create.
    const finWrite = await apiRequest("/api/v1/admin/products", {
      method: "POST",
      cookie: financeCookie,
      body: productBody,
    });
    assert.equal(finWrite.status, 403, JSON.stringify(finWrite.body));
    assert.equal(await countWhere("products", "code = $1", ["BIZMATE"]), 0);
  }, 30_000);

  it("2. product + plan creation: DB rows exist with the submitted values", async () => {
    const prod = await apiRequest("/api/v1/admin/products", {
      method: "POST",
      cookie: superCookie,
      body: {
        code: "BIZMATE",
        slug: "biz-mate-plugin",
        name: "BizMate WooCommerce Plugin",
        product_type: "wordpress_plugin",
        fulfillment_type: "software_license",
        default_activation_limit: 3,
        offline_grace_hours: 168,
      },
    });
    assert.equal(prod.status, 201, JSON.stringify(prod.body));
    productId = prod.body.data.id;
    const productRow = await one("SELECT * FROM products WHERE id = $1", [productId]);
    assert.equal(productRow.code, "BIZMATE");
    assert.equal(productRow.slug, "biz-mate-plugin");
    assert.equal(productRow.product_type, "wordpress_plugin");
    assert.equal(productRow.default_activation_limit, 3);
    assert.equal(productRow.offline_grace_hours, 168);
    assert.equal(productRow.status, "draft");

    const feat = await apiRequest(`/api/v1/admin/products/${productId}/features`, {
      method: "POST",
      cookie: superCookie,
      body: { feature_key: "pos_module", name: "POS Integration", value_type: "boolean" },
    });
    assert.equal(feat.status, 201, JSON.stringify(feat.body));
    featureId = feat.body.data.id;
    const featRow = await one("SELECT * FROM product_features WHERE id = $1", [featureId]);
    assert.equal(featRow.feature_key, "pos_module");
    assert.equal(featRow.value_type, "boolean");

    const pkg = await apiRequest(`/api/v1/admin/products/${productId}/packages`, {
      method: "POST",
      cookie: superCookie,
      body: {
        package_key: "agency-plan",
        name: "Agency Plan",
        features: [
          {
            product_feature_id: featureId,
            entitlement_value: { value_type: "boolean", value: true },
          },
        ],
        change_summary: "Initial Agency Plan release",
      },
    });
    assert.equal(pkg.status, 201, JSON.stringify(pkg.body));
    versionId = pkg.body.data.version.id;
    const pkgRow = await one("SELECT * FROM product_packages WHERE product_id = $1", [productId]);
    assert.equal(pkgRow.package_key, "agency-plan");
    const verRow = await one("SELECT * FROM package_versions WHERE id = $1", [versionId]);
    assert.equal(verRow.status, "draft");

    const price = await apiRequest(`/api/v1/admin/package-versions/${versionId}/prices`, {
      method: "POST",
      cookie: superCookie,
      body: {
        price_key: "bdt-yearly",
        price_kind: "recurring",
        amount_minor: 499900,
        currency_code: "BDT",
        interval_unit: "year",
        interval_count: 1,
      },
    });
    assert.equal(price.status, 201, JSON.stringify(price.body));
    priceId = price.body.data.id;
    const priceRow = await one("SELECT * FROM package_prices WHERE id = $1", [priceId]);
    assert.equal(Number(priceRow.amount_minor), 499900);
    assert.equal(priceRow.currency_code, "BDT");
    assert.equal(priceRow.price_kind, "recurring");
    assert.equal(priceRow.interval_unit, "year");
    assert.equal(priceRow.interval_count, 1);
    assert.equal(priceRow.status, "active");

    const pubVer = await apiRequest(`/api/v1/admin/package-versions/${versionId}/publish`, {
      method: "POST",
      cookie: superCookie,
    });
    assert.equal(pubVer.status, 200, JSON.stringify(pubVer.body));
    assert.equal(
      (await one("SELECT status FROM package_versions WHERE id = $1", [versionId])).status,
      "published"
    );
    const pubProd = await apiRequest(`/api/v1/admin/products/${productId}/publish`, {
      method: "POST",
      cookie: superCookie,
    });
    assert.equal(pubProd.status, 200, JSON.stringify(pubProd.body));
    assert.equal(
      (await one("SELECT status FROM products WHERE id = $1", [productId])).status,
      "active"
    );
  }, 30_000);

  it("3. customer creation: DB row exists with the submitted values", async () => {
    const created = await apiRequest("/api/v1/admin/customers", {
      method: "POST",
      cookie: superCookie,
      body: {
        name: "Tanvir Rahman",
        email: "tanvir@agency.bd",
        phone: "01711223344",
        country_code: "BD",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    customerId = created.body.data.id;
    const row = await one("SELECT * FROM customers WHERE id = $1", [customerId]);
    assert.equal(row.name, "Tanvir Rahman");
    assert.equal(row.normalized_email, "tanvir@agency.bd");
    assert.equal(row.normalized_phone, "+8801711223344");
    assert.equal(row.country_code, "BD");
    assert.equal(row.status, "active");
    assert.ok(/^CUST-\d+$/.test(row.customer_number));
  }, 30_000);

  it("4. order creation (admin): snapshot totals in minor units, status awaiting_payment/unpaid", async () => {
    const created = await apiRequest("/api/v1/admin/orders", {
      method: "POST",
      cookie: superCookie,
      body: {
        customer_id: customerId,
        product_id: productId,
        item_kind: "package",
        package_version_id: versionId,
        package_price_id: priceId,
        quantity: 1,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    adminOrderId = created.body.data.order.id;
    const orderRow = await one("SELECT * FROM orders WHERE id = $1", [adminOrderId]);
    assert.equal(orderRow.customer_id, customerId);
    assert.equal(orderRow.status, "awaiting_payment");
    assert.equal(orderRow.payment_status, "unpaid");
    assert.equal(orderRow.currency_code, "BDT");
    assert.equal(Number(orderRow.subtotal_minor), 499900);
    assert.equal(Number(orderRow.total_minor), 499900);
    assert.equal(Number(orderRow.discount_minor), 0);
    assert.equal(Number(orderRow.tax_minor), 0);
    const itemRow = await one("SELECT * FROM order_items WHERE order_id = $1", [adminOrderId]);
    assert.equal(itemRow.product_id, productId);
    assert.equal(itemRow.package_version_id, versionId);
    assert.equal(itemRow.package_price_id, priceId);
    assert.equal(Number(itemRow.line_total_minor), 499900);
    assert.equal(itemRow.quantity, 1);
    assert.equal(itemRow.price_kind_snapshot, "recurring");
    assert.equal(itemRow.activation_limit_snapshot, 3);
    const invoiceRow = await one("SELECT * FROM invoices WHERE order_id = $1", [adminOrderId]);
    assert.equal(invoiceRow.status, "open");
    assert.equal(Number(invoiceRow.total_minor), 499900);
    assert.equal(Number(invoiceRow.amount_due_minor), 499900);
    assert.ok(
      (await countWhere("audit_logs", "action = $1 AND resource_id = $2", [
        "commerce.order.created",
        adminOrderId,
      ])) === 1,
      "order creation must write exactly one audit log row"
    );
  }, 30_000);

  it("5. integrated site + public checkout order (idempotent): site-linked order with snapshot total", async () => {
    // bKash manual payment method (seeded bkash_manual provider).
    const providers = await apiRequest("/api/v1/admin/payment-providers", { cookie: superCookie });
    assert.equal(providers.status, 200);
    const bkash = providers.body.data.items.find((p: any) => p.provider_key === "bkash_manual");
    assert.ok(bkash, "seeded bkash_manual provider missing");
    const method = await apiRequest("/api/v1/admin/payment-methods", {
      method: "POST",
      cookie: superCookie,
      body: {
        provider_id: bkash.id,
        method_key: "bkash-merchant-main",
        display_name: "bKash Merchant Payment",
        method_kind: "mfs_account",
        account_type: "merchant",
        configuration: {
          account_number: "01700000000",
          account_holder_name: "StackMate Technologies Ltd.",
          transaction_id_requirement: "required",
        },
      },
    });
    assert.equal(method.status, 201, JSON.stringify(method.body));
    const methodRow = await one("SELECT * FROM payment_methods WHERE id = $1", [
      method.body.data.id,
    ]);
    assert.equal(methodRow.method_key, "bkash-merchant-main");
    assert.equal(methodRow.is_enabled, true);

    // Register the external website and configure Meta tracking.
    const site = await apiRequest("/api/v1/admin/integrated-sites", {
      method: "POST",
      cookie: superCookie,
      body: {
        name: "BizMate Official Website",
        environment: "production",
        primary_domain: "bizstore.bd",
        product_ids: [productId],
        allowed_capabilities: [
          "catalog.read",
          "checkout.create",
          "orders.read:own",
          "tracking.events.write",
        ],
      },
    });
    assert.equal(site.status, 201, JSON.stringify(site.body));
    siteId = site.body.data.site.id;
    siteKey = site.body.data.site.site_key;
    hmacKeyId = site.body.data.initial_server_credential.key_id;
    hmacSharedSecret = site.body.data.initial_server_credential.raw_secret_once;
    assert.ok(siteKey.length > 0 && hmacKeyId.length > 0 && hmacSharedSecret.length > 0);
    const siteRow = await one("SELECT * FROM integrated_sites WHERE id = $1", [siteId]);
    assert.equal(siteRow.status, "active");
    assert.equal(
      await countWhere("site_credentials", "integrated_site_id = $1 AND key_id = $2", [
        siteId,
        hmacKeyId,
      ]),
      1
    );

    const tracking = await apiRequest(`/api/v1/admin/integrated-sites/${siteId}/tracking`, {
      method: "PUT",
      cookie: superCookie,
      body: {
        provider: "meta",
        pixel_id: "123456789012345",
        access_token: "EAAB_mock_meta_capi_system_user_token_biz",
        enabled_events: ["PageView", "InitiateCheckout", "Purchase"],
        status: "enabled",
      },
    });
    assert.equal(tracking.status, 200, JSON.stringify(tracking.body));
    const trackCfg = await one(
      "SELECT * FROM tracking_configurations WHERE integrated_site_id = $1",
      [siteId]
    );
    assert.equal(trackCfg.provider, "meta");
    assert.equal(trackCfg.pixel_id, "123456789012345");
    assert.equal(trackCfg.status, "enabled");

    // Public checkout order via the site key.
    const checkoutBody = {
      items: [
        {
          product_slug: "biz-mate-plugin",
          package_version_id: versionId,
          price_id: priceId,
          quantity: 1,
        },
      ],
      customer: { name: "Tanvir Rahman", email: "tanvir@agency.bd", phone: "+8801711223344" },
      attribution: { utm_source: "facebook", utm_campaign: "biz_launch" },
    };
    const checkout = await apiRequest(`/api/v1/public/sites/${siteKey}/checkout/orders`, {
      method: "POST",
      headers: { "X-StackMate-Site-Key": siteKey, "Idempotency-Key": "idem-biz-checkout-001" },
      body: checkoutBody,
    });
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    publicOrderId = checkout.body.data.order.id;
    publicReference = checkout.body.data.order.public_reference;
    checkoutToken = checkout.body.data.checkout_access_token;
    assert.equal(checkout.body.data.order.total_minor, 499900);
    assert.ok(checkoutToken.startsWith("smc_v1."));

    // Replaying the same Idempotency-Key returns the SAME order (200, no new row).
    const replay = await apiRequest(`/api/v1/public/sites/${siteKey}/checkout/orders`, {
      method: "POST",
      headers: { "X-StackMate-Site-Key": siteKey, "Idempotency-Key": "idem-biz-checkout-001" },
      body: checkoutBody,
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.order.id, publicOrderId);
    assert.equal(await countWhere("orders", "public_reference = $1", [publicReference]), 1);

    const dbOrder = await one("SELECT * FROM orders WHERE id = $1", [publicOrderId]);
    assert.equal(dbOrder.integrated_site_id, siteId);
    assert.equal(dbOrder.status, "awaiting_payment");
    assert.equal(dbOrder.payment_status, "unpaid");
    assert.equal(Number(dbOrder.total_minor), 499900);
    assert.equal(dbOrder.source, "website");
  }, 30_000);

  it("6. manual payment submission: payment row pending/unverified, order pending_verification, outbox row", async () => {
    const before = await countWhere("payment_submissions", "order_id = $1", [publicOrderId]);
    assert.equal(before, 0);
    const submitBody = {
      payment_method_id: (await one("SELECT id FROM payment_methods WHERE method_key = $1", [
        "bkash-merchant-main",
      ])).id as string,
      amount_minor: 499900,
      currency_code: "BDT",
      sender_phone: "01711223344",
      transaction_id: "BKA-BIZ-001",
      payment_date_display: "15/11/2026",
    };
    const submitted = await apiRequest(
      `/api/v1/public/sites/${siteKey}/checkout/orders/${publicReference}/payment-submissions`,
      {
        method: "POST",
        token: checkoutToken,
        headers: { "Idempotency-Key": "idem-biz-payment-001" },
        body: submitBody,
      }
    );
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    submissionId = submitted.body.data.payment_submission.id;
    assert.equal(submitted.body.data.order.payment_status, "pending_verification");

    // Same Idempotency-Key replays the same submission (200, no duplicate row).
    const replay = await apiRequest(
      `/api/v1/public/sites/${siteKey}/checkout/orders/${publicReference}/payment-submissions`,
      {
        method: "POST",
        token: checkoutToken,
        headers: { "Idempotency-Key": "idem-biz-payment-001" },
        body: submitBody,
      }
    );
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.payment_submission.id, submissionId);
    assert.equal(await countWhere("payment_submissions", "order_id = $1", [publicOrderId]), 1);

    const subRow = await one("SELECT * FROM payment_submissions WHERE id = $1", [submissionId]);
    assert.equal(subRow.status, "submitted");
    assert.equal(Number(subRow.amount_minor), 499900);
    assert.equal(subRow.currency_code, "BDT");
    assert.equal(subRow.normalized_transaction_reference, "BKA-BIZ-001");
    // payment_date is a DATE column; node-postgres returns it as a JS Date at
    // midnight in the runner's local timezone, so compare the calendar date in
    // the app's default timezone (Asia/Dhaka), never via toISOString (UTC).
    const paymentDateDhaka = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(subRow.payment_date);
    assert.equal(paymentDateDhaka, "2026-11-15");
    assert.equal(subRow.reviewed_at, null);
    assert.equal(
      (await one("SELECT payment_status FROM orders WHERE id = $1", [publicOrderId]))
        .payment_status,
      "pending_verification",
      "a submitted claim must NOT count as paid revenue"
    );
    // Unverified payments are never revenue: analytics must still show zero.
    const analytics = await apiRequest("/api/v1/admin/analytics/overview", {
      cookie: superCookie,
    });
    assert.equal(analytics.status, 200);
    assert.equal(analytics.body.data.verified_revenue_minor, 0);
    assert.equal(analytics.body.data.pending_payment_submissions, 1);

    // The submission enqueued a transactional-outbox row in the same transaction.
    const outbox = await one(
      "SELECT * FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2",
      ["payment.submitted", submissionId]
    );
    assert.equal(outbox.status, "pending");
    assert.equal(outbox.aggregate_type, "payment_submission");
  }, 30_000);

  it("7. staff payment verification (concurrent race): exactly one approval wins; order paid, audit logged", async () => {
    const approveBody = {
      verified_amount_minor: 499900,
      currency_code: "BDT",
      verification_reference: "BKASH-STMT-BIZ-001",
      internal_note: "Verified against bKash merchant portal",
    };
    const txBefore = await count("SELECT COUNT(*) AS count FROM payment_transactions");
    const [a, b] = await Promise.all([
      apiRequest(`/api/v1/admin/payment-submissions/${submissionId}/approve`, {
        method: "POST",
        cookie: financeCookie,
        body: approveBody,
      }),
      apiRequest(`/api/v1/admin/payment-submissions/${submissionId}/approve`, {
        method: "POST",
        cookie: financeCookie,
        body: approveBody,
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(
      statuses,
      [200, 409],
      `exactly one approval must succeed (200) and the race loser must fail (409); got ${a.status}/${b.status}: ${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}`
    );
    const winner = a.status === 200 ? a : b;
    assert.equal(winner.body.data.payment_status, "paid");
    assert.equal(winner.body.data.order_status, "completed");
    assert.equal(winner.body.data.subscriptions.length, 1);
    assert.equal(winner.body.data.issued_licenses.length, 1);
    licenseKey = winner.body.data.issued_licenses[0].issued_license_key_once as string;
    assert.ok(licenseKey.startsWith("SM-BIZMAT-"), `unexpected license key format: ${licenseKey}`);

    // DB: exactly one transaction, one verification log, submission approved.
    assert.equal(
      await count("SELECT COUNT(*) AS count FROM payment_transactions"),
      txBefore + 1,
      "the race must create exactly one payment transaction"
    );
    const txRow = await one(
      "SELECT * FROM payment_transactions WHERE payment_submission_id = $1",
      [submissionId]
    );
    assert.equal(txRow.status, "succeeded");
    assert.equal(Number(txRow.amount_minor), 499900);
    assert.equal(txRow.verification_source, "manual_staff");
    const subRow = await one("SELECT * FROM payment_submissions WHERE id = $1", [submissionId]);
    assert.equal(subRow.status, "approved");
    assert.ok(subRow.reviewed_at !== null);
    assert.equal(
      await countWhere(
        "payment_verification_logs",
        "payment_submission_id = $1 AND decision = $2",
        [submissionId, "approved"]
      ),
      1
    );
    const orderRow = await one("SELECT * FROM orders WHERE id = $1", [publicOrderId]);
    assert.equal(orderRow.payment_status, "paid");
    assert.equal(orderRow.status, "completed");
    assert.ok(orderRow.completed_at !== null);
    const invoiceRow = await one("SELECT * FROM invoices WHERE order_id = $1", [publicOrderId]);
    assert.equal(invoiceRow.status, "paid");
    assert.equal(Number(invoiceRow.amount_paid_minor), 499900);
    assert.equal(Number(invoiceRow.amount_due_minor), 0);
    // Audit log row for the approval.
    const audit = await one(
      "SELECT * FROM audit_logs WHERE action = $1 AND resource_id = $2",
      ["payments.submission.approved", submissionId]
    );
    assert.equal(audit.outcome, "success");
    assert.equal(audit.resource_type, "payment_submission");
    // Verified revenue now counts the order.
    const analytics = await apiRequest("/api/v1/admin/analytics/overview", {
      cookie: superCookie,
    });
    assert.equal(analytics.body.data.verified_revenue_minor, 499900);
    assert.equal(analytics.body.data.pending_payment_submissions, 0);
  }, 30_000);

  it("8. subscription activation after verification: active row, correct 1-year period", async () => {
    // ADR-0009 (Decision 3, owner rules 2026-11-17): public checkout now
    // DEDUPES by normalized email/phone — the checkout resolves to the
    // admin-created customer from test 3 instead of creating a second
    // row for the same email. (Before this batch the checkout ALWAYS
    // created a fresh customer row; the old assertion is inverted here.)
    workflowCustomerId = (
      await one("SELECT customer_id FROM orders WHERE id = $1", [publicOrderId])
    ).customer_id as string;
    assert.equal(
      workflowCustomerId,
      customerId,
      "checkout must resolve to the existing customer (ADR-0009 dedupe)"
    );
    assert.equal(
      await countWhere("customers", "normalized_email = $1", ["tanvir@agency.bd"]),
      1,
      "one customer row for the shared email — no duplicate from checkout"
    );
    subscriptionId = (await one("SELECT * FROM subscriptions WHERE customer_id = $1", [workflowCustomerId])).id;
    const subRow = await one("SELECT * FROM subscriptions WHERE id = $1", [subscriptionId]);
    assert.equal(subRow.status, "active");
    assert.equal(subRow.billing_kind, "recurring");
    assert.equal(subRow.interval_unit, "year");
    assert.equal(subRow.interval_count, 1);
    assert.equal(subRow.currency_code, "BDT");
    assert.equal(Number(subRow.unit_amount_minor), 499900);
    assert.equal(subRow.product_id, productId);
    assert.ok(subRow.current_period_start !== null && subRow.current_period_end !== null);
    const startMs = new Date(subRow.current_period_start).getTime();
    const endMs = new Date(subRow.current_period_end).getTime();
    const days = (endMs - startMs) / 86_400_000;
    assert.ok(days >= 364 && days <= 366, `period must span ~1 year, got ${days} days`);
    period1End = new Date(subRow.current_period_end).toISOString();
    assert.equal(
      new Date(subRow.next_renewal_at).getTime(),
      endMs,
      "next renewal must equal the current period end"
    );
    const periodRow = await one(
      "SELECT * FROM subscription_periods WHERE subscription_id = $1 AND period_number = $2",
      [subscriptionId, 1]
    );
    assert.equal(periodRow.status, "active");
    assert.equal(periodRow.renewal_order_id, publicOrderId);
    assert.ok(periodRow.activated_at !== null);
    // Outbox row for the subscription creation, still pending.
    const outbox = await one(
      "SELECT * FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2",
      ["subscription.created", subscriptionId]
    );
    assert.equal(outbox.status, "pending");
  }, 30_000);

  it("9. license issuance: license row + token, issued against the subscription", async () => {
    licenseId = (await one("SELECT * FROM licenses WHERE customer_id = $1", [workflowCustomerId])).id;
    const licRow = await one("SELECT * FROM licenses WHERE id = $1", [licenseId]);
    assert.equal(licRow.status, "active");
    assert.equal(licRow.subscription_id, subscriptionId);
    assert.equal(licRow.product_id, productId);
    assert.equal(licRow.activation_limit, 3);
    assert.equal(licRow.license_key_hint, `SM-BIZMAT-...-${licenseKey.slice(-5)}`);
    assert.ok(licRow.license_key_hash.length > 20, "only a keyed hash is stored, never the raw key");
    assert.equal(new Date(licRow.expires_at).toISOString(), period1End);
    assert.ok(new Date(licRow.grace_until).getTime() > new Date(period1End).getTime());
    const snapCount = await countWhere("license_entitlement_snapshots", "license_id = $1", [
      licenseId,
    ]);
    assert.equal(snapCount, 1, "an initial entitlement snapshot must exist");
    const snapItems = await countWhere(
      "license_entitlement_snapshot_items",
      "snapshot_id = $1",
      [licRow.current_entitlement_snapshot_id]
    );
    assert.equal(snapItems, 1);
    const outbox = await one(
      "SELECT * FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2",
      ["license.created", licenseId]
    );
    assert.equal(outbox.status, "pending");
  }, 30_000);

  it("10. license activation: activation row, activation count 1, validate succeeds", async () => {
    const activated = await apiRequest("/api/v1/licenses/activate", {
      method: "POST",
      body: {
        license_key: licenseKey,
        product_code: "BIZMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-biz-1",
        site_url: "https://shop-1.bd",
        environment: "production",
        product_version: "2.4.0",
      },
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.data.valid, true);
    assert.equal(activated.body.data.activation.active_count, 1);
    assert.equal(activated.body.data.activation.activation_limit, 3);
    assert.equal(activated.body.data.activation.domain_normalized, "shop-1.bd");
    assert.ok(activated.body.data.entitlement_token.length > 50);
    assert.equal(
      await countWhere("license_activations", "license_id = $1 AND status = $2", [
        licenseId,
        "active",
      ]),
      1
    );
    const actRow = await one("SELECT * FROM license_activations WHERE license_id = $1", [
      licenseId,
    ]);
    assert.equal(actRow.environment, "production");
    assert.equal(actRow.domain_normalized, "shop-1.bd");

    const validated = await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: licenseKey,
        product_code: "BIZMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-biz-1",
      },
    });
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    assert.equal(validated.body.data.valid, true);
    assert.equal(validated.body.data.license_status, "active");
  }, 30_000);

  it("11. activation-limit enforcement: 3rd activation ok, 4th fails 409 and adds no row", async () => {
    for (const [installId, expectedCount] of [
      ["wp-biz-2", 2],
      ["wp-biz-3", 3],
    ] as const) {
      const res = await apiRequest("/api/v1/licenses/activate", {
        method: "POST",
        body: {
          license_key: licenseKey,
          product_code: "BIZMATE",
          integration_profile: "wordpress_plugin",
          installation_id: installId,
          site_url: `https://${installId}.bd`,
          environment: "production",
        },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.activation.active_count, expectedCount);
    }
    const over = await apiRequest("/api/v1/licenses/activate", {
      method: "POST",
      body: {
        license_key: licenseKey,
        product_code: "BIZMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-biz-4",
        site_url: "https://wp-biz-4.bd",
        environment: "production",
      },
    });
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.error.code, "ACTIVATION_LIMIT_REACHED");
    assert.equal(
      await countWhere("license_activations", "license_id = $1 AND status = $2", [
        licenseId,
        "active",
      ]),
      3,
      "the rejected activation must add no row"
    );
    // Re-activating an already-active installation is an idempotent heartbeat, not a new seat.
    const heartbeat = await apiRequest("/api/v1/licenses/activate", {
      method: "POST",
      body: {
        license_key: licenseKey,
        product_code: "BIZMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-biz-1",
        environment: "production",
      },
    });
    assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));
    assert.equal(heartbeat.body.data.activation.active_count, 3);
    assert.equal(
      await countWhere("license_activations", "license_id = $1", [licenseId]),
      3
    );
  }, 30_000);

  it("12. subscription renewal: new period, status stays active, license expiry extended", async () => {
    const renewal = await apiRequest(
      `/api/v1/admin/subscriptions/${subscriptionId}/renewal-invoices`,
      {
        method: "POST",
        cookie: financeCookie,
        headers: { "Idempotency-Key": "idem-biz-renewal-001" },
      }
    );
    assert.equal(renewal.status, 201, JSON.stringify(renewal.body));
    renewalOrderId = renewal.body.data.renewal_order.id;
    renewalReference = renewal.body.data.renewal_order.public_reference;
    assert.notEqual(renewalOrderId, publicOrderId);

    // Same Idempotency-Key replays the same renewal order (200, no second order).
    const replay = await apiRequest(
      `/api/v1/admin/subscriptions/${subscriptionId}/renewal-invoices`,
      {
        method: "POST",
        cookie: financeCookie,
        headers: { "Idempotency-Key": "idem-biz-renewal-001" },
      }
    );
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.renewal_order.id, renewalOrderId);
    assert.equal(
      await countWhere("orders", "id = $1", [renewalOrderId]),
      1
    );

    const renewalOrder = await one("SELECT * FROM orders WHERE id = $1", [renewalOrderId]);
    assert.equal(renewalOrder.status, "awaiting_payment");
    assert.equal(renewalOrder.payment_status, "unpaid");
    assert.equal(Number(renewalOrder.total_minor), 499900);
    const pendingPeriod = await one(
      "SELECT * FROM subscription_periods WHERE subscription_id = $1 AND period_number = $2",
      [subscriptionId, 2]
    );
    assert.equal(pendingPeriod.status, "pending");
    assert.equal(pendingPeriod.renewal_order_id, renewalOrderId);

    // Pay the renewal order: mint a checkout token for it (same mechanism
    // the public checkout uses) and submit + verify the manual payment.
    const renewalToken = issueCheckoutAccessToken(
      {
        oid: renewalOrderId,
        ref: renewalReference,
        sid: siteId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      env.CHECKOUT_TOKEN_SECRET
    );
    const methodId = (await one("SELECT id FROM payment_methods WHERE method_key = $1", [
      "bkash-merchant-main",
    ])).id as string;
    const submitted = await apiRequest(
      `/api/v1/public/sites/${siteKey}/checkout/orders/${renewalReference}/payment-submissions`,
      {
        method: "POST",
        token: renewalToken,
        headers: { "Idempotency-Key": "idem-biz-payment-002" },
        body: {
          payment_method_id: methodId,
          amount_minor: 499900,
          currency_code: "BDT",
          sender_phone: "01711223344",
          transaction_id: "BKA-BIZ-002",
          payment_date_display: "15/11/2026",
        },
      }
    );
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const renewalSubmissionId = submitted.body.data.payment_submission.id as string;
    const approved = await apiRequest(
      `/api/v1/admin/payment-submissions/${renewalSubmissionId}/approve`,
      {
        method: "POST",
        cookie: financeCookie,
        body: {
          verified_amount_minor: 499900,
          currency_code: "BDT",
          verification_reference: "BKASH-STMT-BIZ-002",
        },
      }
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    // Period 2 is now active; the subscription period rolled forward ~1 year.
    const subRow = await one("SELECT * FROM subscriptions WHERE id = $1", [subscriptionId]);
    assert.equal(subRow.status, "active");
    const newEndMs = new Date(subRow.current_period_end).getTime();
    const oldEndMs = new Date(period1End).getTime();
    assert.ok(newEndMs > oldEndMs, "renewal must extend the current period end");
    assert.ok(
      (newEndMs - oldEndMs) / 86_400_000 >= 364 &&
        (newEndMs - oldEndMs) / 86_400_000 <= 366,
      "renewal must extend the period by ~1 year"
    );
    const period2 = await one(
      "SELECT * FROM subscription_periods WHERE subscription_id = $1 AND period_number = $2",
      [subscriptionId, 2]
    );
    assert.equal(period2.status, "active");
    assert.ok(period2.activated_at !== null);
    // The linked license validity rolled forward with the subscription.
    const licRow = await one("SELECT * FROM licenses WHERE id = $1", [licenseId]);
    assert.equal(licRow.status, "active");
    assert.equal(new Date(licRow.expires_at).getTime(), newEndMs);
    const renewedOutbox = await one(
      "SELECT * FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2",
      ["subscription.renewed", subscriptionId]
    );
    assert.equal(renewedOutbox.status, "pending");
  }, 30_000);

  it("13. subscription expiry: expired subscription/license no longer grants access", async () => {
    // No automatic expiry job exists in the code (the scheduled handler
    // only processes the outbox), so simulate elapsed time + the state an
    // expiry transition would produce: period end and license expiry in
    // the past, grace period over, subscription marked expired.
    const pastExpiry = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const pastGrace = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await adminClient.query(
      "UPDATE licenses SET expires_at = $1, grace_until = $2 WHERE id = $3",
      [pastExpiry, pastGrace, licenseId]
    );
    await adminClient.query(
      "UPDATE subscriptions SET status = $1, current_period_end = $2 WHERE id = $3",
      ["expired", pastExpiry, subscriptionId]
    );
    const subRow = await one("SELECT * FROM subscriptions WHERE id = $1", [subscriptionId]);
    assert.equal(subRow.status, "expired");
    assert.ok(new Date(subRow.current_period_end).getTime() < Date.now());

    const validated = await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: licenseKey,
        product_code: "BIZMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-biz-1",
      },
    });
    assert.equal(validated.status, 403, JSON.stringify(validated.body));
    assert.equal(validated.body.error.code, "LICENSE_EXPIRED");
    const activated = await apiRequest("/api/v1/licenses/activate", {
      method: "POST",
      body: {
        license_key: licenseKey,
        product_code: "BIZMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-biz-9",
        environment: "production",
      },
    });
    assert.equal(activated.status, 403);
    assert.equal(activated.body.error.code, "LICENSE_EXPIRED");
    // FINDING: the expired status flip happens inside withTransaction just
    // before the LICENSE_EXPIRED throw, so the rollback discards it — the
    // DB row still reads 'active' and expiry is re-derived on every
    // validation instead of being persisted.
    const licRow = await one("SELECT * FROM licenses WHERE id = $1", [licenseId]);
    assert.equal(
      licRow.status,
      "active",
      "validation re-derives expiry but never persists status='expired'"
    );
  }, 30_000);

  it("14. manual license grant + concurrent activation race: exactly 3 of 5 win", async () => {
    const granted = await apiRequest("/api/v1/admin/licenses/manual-grants", {
      method: "POST",
      cookie: superCookie,
      body: {
        customer_id: customerId,
        product_id: productId,
        activation_limit: 3,
        reason: "Biz workflow test grant",
        entitlements: { pos_module: { value_type: "boolean", value: true } },
      },
    });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    grantLicenseId = granted.body.data.license.id;
    grantLicenseKey = granted.body.data.issued_license_key_once;
    assert.ok(grantLicenseKey.startsWith("SM-BIZMAT-"));
    const licRow = await one("SELECT * FROM licenses WHERE id = $1", [grantLicenseId]);
    assert.equal(licRow.status, "active");
    assert.equal(licRow.subscription_id, null);
    assert.equal(licRow.expires_at, null, "a grant without expires_at never expires");
    assert.equal(licRow.activation_limit, 3);

    // Five simultaneous activations against a 3-seat limit.
    const attempts = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        apiRequest("/api/v1/licenses/activate", {
          method: "POST",
          body: {
            license_key: grantLicenseKey,
            product_code: "BIZMATE",
            integration_profile: "wordpress_plugin",
            installation_id: `wp-grant-${n}`,
            site_url: `https://grant-${n}.bd`,
            environment: "production",
          },
        })
      )
    );
    const ok = attempts.filter((r) => r.status === 200);
    const blocked = attempts.filter(
      (r) => r.status === 409 && r.body.error.code === "ACTIVATION_LIMIT_REACHED"
    );
    assert.equal(ok.length, 3, `exactly 3 activations must succeed, got ${ok.length}`);
    assert.equal(blocked.length, 2, `exactly 2 must hit the limit, got ${blocked.length}`);
    assert.equal(
      await countWhere("license_activations", "license_id = $1 AND status = $2", [
        grantLicenseId,
        "active",
      ]),
      3,
      "final DB state must hold exactly 3 active activations"
    );
  }, 30_000);

  it("15. license suspension + revocation: suspended fails validation, revoked fails validation", async () => {
    const suspended = await apiRequest(`/api/v1/admin/licenses/${grantLicenseId}/suspend`, {
      method: "POST",
      cookie: superCookie,
      body: { reason: "Biz workflow test suspension" },
    });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(
      (await one("SELECT status FROM licenses WHERE id = $1", [grantLicenseId])).status,
      "suspended"
    );
    const whileSuspended = await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: grantLicenseKey,
        product_code: "BIZMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-grant-1",
      },
    });
    assert.equal(whileSuspended.status, 403, JSON.stringify(whileSuspended.body));
    assert.equal(whileSuspended.body.error.code, "LICENSE_SUSPENDED");

    const resumed = await apiRequest(`/api/v1/admin/licenses/${grantLicenseId}/resume`, {
      method: "POST",
      cookie: superCookie,
      body: { reason: "Biz workflow test resume" },
    });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(
      (await one("SELECT status FROM licenses WHERE id = $1", [grantLicenseId])).status,
      "active"
    );
    const whileActive = await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: grantLicenseKey,
        product_code: "BIZMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-grant-1",
      },
    });
    assert.equal(whileActive.status, 200, JSON.stringify(whileActive.body));

    const revoked = await apiRequest(`/api/v1/admin/licenses/${grantLicenseId}/revoke`, {
      method: "POST",
      cookie: superCookie,
      body: { reason: "Biz workflow test revocation" },
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const licRow = await one("SELECT * FROM licenses WHERE id = $1", [grantLicenseId]);
    assert.equal(licRow.status, "revoked");
    assert.equal(
      await countWhere("license_activations", "license_id = $1 AND status = $2", [
        grantLicenseId,
        "active",
      ]),
      0,
      "revocation must deactivate every live activation"
    );
    const whileRevoked = await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: grantLicenseKey,
        product_code: "BIZMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-grant-1",
      },
    });
    assert.equal(whileRevoked.status, 403, JSON.stringify(whileRevoked.body));
    assert.equal(whileRevoked.body.error.code, "LICENSE_REVOKED");
  }, 30_000);

  it("16. external website API authentication: site key + HMAC S2S, bad/missing credentials fail", async () => {
    // Public catalog with the correct site key succeeds...
    const catalog = await apiRequest(`/api/v1/public/sites/${siteKey}/products`, {
      headers: { "X-StackMate-Site-Key": siteKey },
    });
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    assert.equal(catalog.body.data.items.length, 1);
    assert.equal(catalog.body.data.items[0].slug, "biz-mate-plugin");
    // ...with a wrong site key it fails 401...
    const wrongKey = await apiRequest(`/api/v1/public/sites/${siteKey}/products`, {
      headers: { "X-StackMate-Site-Key": "sm_site_wrongkey0000000000000000" },
    });
    assert.equal(wrongKey.status, 403, JSON.stringify(wrongKey.body));
    // ...and a site key must never authorize an admin endpoint.
    const siteKeyAdmin = await apiRequest("/api/v1/admin/products", {
      headers: { "X-StackMate-Site-Key": siteKey },
    });
    assert.equal(siteKeyAdmin.status, 403, JSON.stringify(siteKeyAdmin.body));
    // Checkout without the site-key header fails 401.
    const noKeyCheckout = await apiRequest(`/api/v1/public/sites/${siteKey}/checkout/orders`, {
      method: "POST",
      headers: { "Idempotency-Key": "idem-biz-checkout-no-key" },
      body: {
        items: [{ product_slug: "biz-mate-plugin", package_version_id: versionId, price_id: priceId, quantity: 1 }],
        customer: { name: "Nobody", email: "nobody@example.com" },
      },
    });
    assert.equal(noKeyCheckout.status, 401, JSON.stringify(noKeyCheckout.body));

    // Server-to-server HMAC-signed request (STACKMATE-HMAC-SHA256-V1).
    const s2sPath = `/api/v1/integrations/sites/${siteKey}/orders/${publicReference}`;
    const ts = Math.floor(Date.now() / 1000);
    const nonce = `nonce-biz-${Date.now()}`;
    const signed = signCanonicalServerRequest(
      {
        keyId: hmacKeyId,
        timestampUnixSeconds: ts,
        nonce,
        method: "GET",
        host: "localhost:8787",
        rawPathAndQuery: s2sPath,
        rawBody: "",
      },
      hmacSharedSecret
    );
    const s2sHeaders = {
      "X-StackMate-Key-Id": hmacKeyId,
      "X-StackMate-Timestamp": String(ts),
      "X-StackMate-Nonce": nonce,
      "X-StackMate-Content-SHA256": signed.contentSha256Header,
      "X-StackMate-Signature": signed.signatureHeader,
    };
    const s2s = await apiRequest(s2sPath, { headers: s2sHeaders });
    assert.equal(s2s.status, 200, JSON.stringify(s2s.body));
    assert.equal(s2s.body.data.payment_status, "paid");
    assert.equal(s2s.body.data.public_reference, publicReference);
    // Replaying the exact signed request must fail: nonce already used.
    const s2sReplay = await apiRequest(s2sPath, { headers: s2sHeaders });
    assert.equal(s2sReplay.status, 409, JSON.stringify(s2sReplay.body));
    assert.equal(s2sReplay.body.error.code, "NONCE_REPLAYED");
    // No signature headers at all -> 401.
    const unsigned = await apiRequest(s2sPath);
    assert.equal(unsigned.status, 401, JSON.stringify(unsigned.body));

    // A public caller can NEVER spoof a Purchase conversion event.
    const spoof = await apiRequest(`/api/v1/public/sites/${siteKey}/tracking/events`, {
      method: "POST",
      body: {
        event_name: "Purchase",
        event_id: "evt_spoofed_biz_1",
        event_time: new Date().toISOString(),
        event_source_url: "https://bizstore.bd/checkout",
        consent: { status: "granted", policy_version: "v1" },
      },
    });
    assert.equal(spoof.status, 403, JSON.stringify(spoof.body));
  }, 30_000);

  it("17. idempotency / duplicate-request handling: same key replays, different payload conflicts", async () => {
    // Same key + different payload -> 409 IDEMPOTENCY_KEY_REUSED, no new order.
    const ordersBefore = await count("SELECT COUNT(*) AS count FROM orders");
    const conflict = await apiRequest(`/api/v1/public/sites/${siteKey}/checkout/orders`, {
      method: "POST",
      headers: { "X-StackMate-Site-Key": siteKey, "Idempotency-Key": "idem-biz-checkout-001" },
      body: {
        items: [
          {
            product_slug: "biz-mate-plugin",
            package_version_id: versionId,
            price_id: priceId,
            quantity: 2,
          },
        ],
        customer: { name: "Tanvir Rahman", email: "tanvir@agency.bd", phone: "+8801711223344" },
      },
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(
      await count("SELECT COUNT(*) AS count FROM orders"),
      ordersBefore,
      "a conflicting replay must create no order"
    );
    // Idempotency records are persisted per scope in Postgres.
    assert.ok(
      (await countWhere("idempotency_records", "scope_key = $1", [
        `public_checkout:${siteKey}`,
      ])) >= 1,
      "checkout idempotency record missing"
    );
    assert.ok(
      (await countWhere("idempotency_records", "scope_key = $1", [
        `payment_submission:${publicReference}`,
      ])) >= 1,
      "payment-submission idempotency record missing"
    );
    assert.ok(
      (await countWhere("idempotency_records", "scope_key = $1", [
        `subscription_renewal:${subscriptionId}`,
      ])) >= 1,
      "renewal idempotency record missing"
    );
  }, 30_000);

  it("18. webhook + transactional outbox: pending rows exist, dispatch delivers them", async () => {
    // Outbox rows were written in the same transactions as the business events.
    for (const [eventType, aggregateId] of [
      ["payment.approved", submissionId],
      ["subscription.created", subscriptionId],
      ["license.created", licenseId],
      ["tracking.meta_capi.dispatch", null],
    ] as const) {
      const where =
        aggregateId === null
          ? "event_type = $1"
          : "event_type = $1 AND aggregate_id = $2";
      const params = aggregateId === null ? [eventType] : [eventType, aggregateId];
      const n = await count(`SELECT COUNT(*) AS count FROM outbox_events WHERE ${where}`, params);
      assert.ok(n >= 1, `expected a pending/delivered outbox row for ${eventType}, got ${n}`);
    }
    const metaRow = await one(
      "SELECT * FROM outbox_events WHERE event_type = $1 AND payload->>'order_reference' = $2",
      ["tracking.meta_capi.dispatch", publicReference]
    );
    assert.equal(metaRow.aggregate_type, "tracking_event");

    // Register a webhook endpoint subscribed to payment.approved.
    const endpoint = await apiRequest("/api/v1/admin/webhooks", {
      method: "POST",
      cookie: superCookie,
      body: {
        url: "https://hooks.example.com/stackmate",
        description: "Biz workflow test endpoint",
        subscribed_events: ["payment.approved"],
      },
    });
    assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
    const endpointId = endpoint.body.data.endpoint.id as string;
    const epRow = await one("SELECT * FROM webhook_endpoints WHERE id = $1", [endpointId]);
    assert.equal(epRow.url, "https://hooks.example.com/stackmate");
    assert.equal(epRow.status, "active");

    // Dispatch the outbox batch with the REAL transport (C-2): the
    // endpoint is a fake hostname, so stub the outbound fetch (DoH +
    // target) to a public IP / 200 — the same pattern as
    // audit-fix-api-domain-webhooks.test.ts. Without the stub the
    // sandbox DNS sinkhole makes the delivery fail and the row stays
    // pending; the stub proves a 2xx delivery records "delivered".
    // Restored right after the dispatch: test 26 needs the REAL
    // (failing) fetch for its unreachable endpoint.
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, _init?: RequestInit): Promise<Response> => {
        const href = url instanceof Request ? url.url : String(url);
        if (href.startsWith("https://cloudflare-dns.com/dns-query")) {
          return new Response(
            JSON.stringify({ Answer: [{ data: "93.184.216.34", type: 1 }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (href.startsWith("https://graph.facebook.com/")) {
          // E-01: manual dispatch now delivers CAPI for real — answer
          // with a valid Meta success body (events_received >= 1) so
          // the event is recorded delivered, not simulated/queued.
          return new Response(
            JSON.stringify({ events_received: 1, fbtrace_id: "test-fbtrace-biz-19" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("ok", { status: 200 });
      },
    );
    let dispatch: Awaited<ReturnType<typeof apiRequest>>;
    try {
      dispatch = await apiRequest("/api/v1/admin/outbox/dispatch", {
        method: "POST",
        cookie: superCookie,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    assert.equal(dispatch.status, 200, JSON.stringify(dispatch.body));
    assert.ok(dispatch.body.data.claimed > 0, "dispatch must claim pending events");
    assert.ok(dispatch.body.data.delivered > 0, "dispatch must deliver events");
    assert.equal(dispatch.body.data.dead_lettered, 0);
    const approvedOutbox = await one(
      "SELECT * FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2",
      ["payment.approved", submissionId]
    );
    assert.equal(approvedOutbox.status, "delivered");
    assert.ok(approvedOutbox.processed_at !== null);
    const delivery = await one(
      "SELECT * FROM webhook_deliveries WHERE webhook_endpoint_id = $1 AND event_id = $2",
      [endpointId, approvedOutbox.id]
    );
    assert.equal(delivery.status, "delivered");
    assert.equal(delivery.last_http_status, 200);
  }, 30_000);

  it("19. verified-purchase Meta Purchase event: exactly one server-verified Purchase is recorded", async () => {
    // Only the server-verified approval may create a Purchase event; the
    // public spoof attempt in test 16 created none.
    const purchaseRows = await rows(
      "SELECT * FROM tracking_events WHERE integrated_site_id = $1 AND event_name = $2",
      [siteId, "Purchase"]
    );
    assert.equal(purchaseRows.length, 1, `expected exactly 1 Purchase event, got ${purchaseRows.length}`);
    const purchase = purchaseRows[0];
    assert.equal(purchase.event_id, `purchase_${publicReference}`);
    assert.equal(purchase.order_id, publicOrderId);
    assert.equal(purchase.consent_state, "granted");
    assert.equal(purchase.consent_policy_version, "server-verified-v1");
    assert.equal(purchase.sanitized_payload.currency, "BDT");
    assert.equal(purchase.sanitized_payload.value_minor, 499900);
    // The outbox dispatch (test 18) delivered the Meta event for real
    // (E-01, live since 2026-11-27; manual dispatch passes capiDeliver
    // just like the cron drain) — the stubbed Meta answer above carries
    // events_received: 1, so the event is "processed" with delivered_at
    // set, and the outbox row is "delivered". (Before E-01 the same
    // dispatch marked it "simulated" — CAPI was a stub then.)
    assert.equal(purchase.status, "processed");
    assert.ok(purchase.delivered_at !== null, "delivered_at must be set");
    const metaOutbox = await one(
      "SELECT * FROM outbox_events WHERE event_type = $1 AND payload->>'order_reference' = $2",
      ["tracking.meta_capi.dispatch", publicReference]
    );
    assert.equal(metaOutbox.status, "delivered");
    // The renewal order was admin-sourced (no site), so it produced no second Purchase.
    assert.equal(
      await countWhere("tracking_events", "event_name = $1", ["Purchase"]),
      1
    );
  }, 30_000);

  it("20. rollback: failing steps leave no partial business state", async () => {
    const snapshot = async () => ({
      transactions: await count("SELECT COUNT(*) AS count FROM payment_transactions"),
      subscriptions: await count("SELECT COUNT(*) AS count FROM subscriptions"),
      licenses: await count("SELECT COUNT(*) AS count FROM licenses"),
      submissions: await count("SELECT COUNT(*) AS count FROM payment_submissions"),
      outbox: await count("SELECT COUNT(*) AS count FROM outbox_events"),
    });
    const before = await snapshot();

    // Approving a nonexistent submission -> 404, nothing created.
    const ghost = await apiRequest(
      "/api/v1/admin/payment-submissions/00000000-0000-4000-8000-000000000000/approve",
      {
        method: "POST",
        cookie: financeCookie,
        body: {
          verified_amount_minor: 499900,
          currency_code: "BDT",
          verification_reference: "GHOST-001",
        },
      }
    );
    assert.equal(ghost.status, 404, JSON.stringify(ghost.body));
    assert.deepEqual(await snapshot(), before, "a 404 approval must leave zero partial state");

    // Re-approving the already-approved submission -> 409, nothing new.
    const again = await apiRequest(`/api/v1/admin/payment-submissions/${submissionId}/approve`, {
      method: "POST",
      cookie: financeCookie,
      body: {
        verified_amount_minor: 499900,
        currency_code: "BDT",
        verification_reference: "BKASH-STMT-BIZ-001",
      },
    });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.deepEqual(await snapshot(), before, "a duplicate approval must leave zero partial state");

    // A payment claim with a WRONG CURRENCY against the still-unpaid admin
    // order -> 422 PAYMENT_AMOUNT_MISMATCH, no submission row, order untouched.
    // (The public order is already paid, so it cannot exercise this path.)
    // NOTE (ADR-0009): a wrong AMOUNT no longer fails — partial payments are
    // accepted now, so the failing step here is the currency mismatch,
    // which still 422s. The rollback intent is unchanged: a rejected claim
    // must leave zero partial state.
    const adminRef = (await one("SELECT public_reference FROM orders WHERE id = $1", [
      adminOrderId,
    ])).public_reference as string;
    const adminToken = issueCheckoutAccessToken(
      {
        oid: adminOrderId,
        ref: adminRef,
        sid: siteId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      env.CHECKOUT_TOKEN_SECRET
    );
    const wrongAmount = await apiRequest(
      `/api/v1/public/sites/${siteKey}/checkout/orders/${adminRef}/payment-submissions`,
      {
        method: "POST",
        token: adminToken,
        headers: { "Idempotency-Key": "idem-biz-payment-wrong-currency" },
        body: {
          payment_method_id: (await one("SELECT id FROM payment_methods WHERE method_key = $1", [
            "bkash-merchant-main",
          ])).id as string,
          amount_minor: 100,
          currency_code: "USD",
          sender_phone: "01711223344",
          transaction_id: "BKA-BIZ-999",
        },
      }
    );
    assert.equal(wrongAmount.status, 422, JSON.stringify(wrongAmount.body));
    assert.equal(wrongAmount.body.error.code, "PAYMENT_AMOUNT_MISMATCH");
    assert.deepEqual(await snapshot(), before, "a rejected claim must leave zero partial state");
    assert.equal(
      (await one("SELECT payment_status FROM orders WHERE id = $1", [adminOrderId]))
        .payment_status,
      "unpaid"
    );
    assert.equal(
      await countWhere("payment_submissions", "order_id = $1", [adminOrderId]),
      0
    );
  }, 30_000);

  // -------------------------------------------------------------------------
  // Batch 1 — Admin completion (API). Tests 21-29 cover the endpoints added
  // for the admin panel: customer update + per-customer collections,
  // order/invoice lifecycle, payment provider/method writes + staff-recorded
  // claims, subscription/license detail + activation deactivate, site
  // lifecycle/products/credentials/domains, webhook test + outbox replay,
  // public/server detail + cancel, feature/package/price writes, roles and
  // the invitation 503 guard (see test 29 note).
  // -------------------------------------------------------------------------

  it("21. Batch 1 customers: PATCH update + per-customer collections; read-only cannot write", async () => {
    const patched = await apiRequest(`/api/v1/admin/customers/${customerId}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { name: "Tanvir Rahman (Updated)", phone: "+8801812345678" },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.name, "Tanvir Rahman (Updated)");
    assert.equal(
      (await one("SELECT name FROM customers WHERE id = $1", [customerId])).name,
      "Tanvir Rahman (Updated)"
    );
    const forbidden = await apiRequest(`/api/v1/admin/customers/${customerId}`, {
      method: "PATCH",
      cookie: readOnlyCookie,
      body: { name: "Nope" },
    });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));

    const orders = await apiRequest(`/api/v1/admin/customers/${customerId}/orders`, {
      cookie: superCookie,
    });
    assert.equal(orders.status, 200, JSON.stringify(orders.body));
    assert.ok(orders.body.data.items.length >= 1, "admin customer must have orders");
    const subs = await apiRequest(
      `/api/v1/admin/customers/${workflowCustomerId}/subscriptions`,
      { cookie: superCookie }
    );
    assert.equal(subs.status, 200, JSON.stringify(subs.body));
    assert.ok(subs.body.data.items.length >= 1, "checkout customer must have subscriptions");
    const lics = await apiRequest(`/api/v1/admin/customers/${workflowCustomerId}/licenses`, {
      cookie: superCookie,
    });
    assert.equal(lics.status, 200, JSON.stringify(lics.body));
    assert.ok(lics.body.data.items.length >= 1, "checkout customer must have licenses");
    assert.ok(!("license_key_hash" in lics.body.data.items[0]));
    const ghost = await apiRequest(
      "/api/v1/admin/customers/00000000-0000-4000-8000-000000000000/orders",
      { cookie: superCookie }
    );
    assert.equal(ghost.status, 404, JSON.stringify(ghost.body));
  }, 30_000);

  it("22. Batch 1 orders/invoices: invoice 409 while live, void then create, complete guard, cancel", async () => {
    const created = await apiRequest("/api/v1/admin/orders", {
      method: "POST",
      cookie: superCookie,
      body: {
        customer_id: customerId,
        product_id: productId,
        item_kind: "package",
        package_version_id: versionId,
        package_price_id: priceId,
        quantity: 1,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body.data.order.id as string;

    // A second invoice while the initial one is live -> 409.
    const dup = await apiRequest(`/api/v1/admin/orders/${orderId}/invoices`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));

    const list = await apiRequest(`/api/v1/admin/orders/${orderId}/invoices`, {
      cookie: superCookie,
    });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.items.length, 1, "exactly the initial invoice");
    const invoiceId = list.body.data.items[0].id as string;
    const detail = await apiRequest(`/api/v1/admin/invoices/${invoiceId}`, {
      cookie: superCookie,
    });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.order.id, orderId);

    // Void the open initial invoice, then a new one can be created.
    const voided = await apiRequest(`/api/v1/admin/invoices/${invoiceId}/void`, {
      method: "POST",
      cookie: superCookie,
      body: { reason: "B1 test void" },
    });
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    assert.equal(voided.body.data.status, "void");
    const created2 = await apiRequest(`/api/v1/admin/orders/${orderId}/invoices`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(created2.status, 201, JSON.stringify(created2.body));

    // Complete is blocked while the order is unpaid.
    const complete = await apiRequest(`/api/v1/admin/orders/${orderId}/complete`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(complete.status, 409, JSON.stringify(complete.body));

    // Cancel works on an unpaid order and enqueues order.cancelled.
    const cancelled = await apiRequest(`/api/v1/admin/orders/${orderId}/cancel`, {
      method: "POST",
      cookie: superCookie,
      body: { reason: "B1 test cancel" },
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, "cancelled");
    assert.equal(
      (await one("SELECT status FROM orders WHERE id = $1", [orderId])).status,
      "cancelled"
    );
    assert.ok(
      (await countWhere("outbox_events", "event_type = $1 AND aggregate_id = $2", [
        "order.cancelled",
        orderId,
      ])) >= 1
    );
    const again = await apiRequest(`/api/v1/admin/orders/${orderId}/cancel`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(again.status, 409, JSON.stringify(again.body));
  }, 30_000);

  it("23. Batch 1 payment providers/methods + staff-recorded claim", async () => {
    const prov = await apiRequest("/api/v1/admin/payment-providers", {
      method: "POST",
      cookie: superCookie,
      body: {
        provider_key: "nagad-manual-b1",
        display_name: "Nagad Manual B1",
        provider_type: "manual_mfs",
        adapter_key: "nagad_manual",
      },
    });
    assert.equal(prov.status, 201, JSON.stringify(prov.body));
    const providerId = prov.body.data.id as string;
    const patchedProv = await apiRequest(`/api/v1/admin/payment-providers/${providerId}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { display_name: "Nagad Manual B1 (Renamed)" },
    });
    assert.equal(patchedProv.status, 200, JSON.stringify(patchedProv.body));
    assert.equal(patchedProv.body.data.display_name, "Nagad Manual B1 (Renamed)");

    const methodId = (
      await one("SELECT id FROM payment_methods WHERE method_key = $1", [
        "bkash-merchant-main",
      ])
    ).id as string;
    const mDetail = await apiRequest(`/api/v1/admin/payment-methods/${methodId}`, {
      cookie: superCookie,
    });
    assert.equal(mDetail.status, 200, JSON.stringify(mDetail.body));
    const mPatched = await apiRequest(`/api/v1/admin/payment-methods/${methodId}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { display_name: "bKash Merchant Payment (B1)" },
    });
    assert.equal(mPatched.status, 200, JSON.stringify(mPatched.body));
    const disabled = await apiRequest(`/api/v1/admin/payment-methods/${methodId}/disable`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.equal(disabled.body.data.is_enabled, false);
    const enabled = await apiRequest(`/api/v1/admin/payment-methods/${methodId}/enable`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.data.is_enabled, true);

    // Submission detail + verification history (approved submission, tests 6/7).
    const sDetail = await apiRequest(`/api/v1/admin/payment-submissions/${submissionId}`, {
      cookie: superCookie,
    });
    assert.equal(sDetail.status, 200, JSON.stringify(sDetail.body));
    assert.equal(sDetail.body.data.status, "approved");
    const sHistory = await apiRequest(
      `/api/v1/admin/payment-submissions/${submissionId}/history`,
      { cookie: superCookie }
    );
    assert.equal(sHistory.status, 200, JSON.stringify(sHistory.body));
    assert.ok(sHistory.body.data.items.length >= 1);

    // Staff-recorded claim on a fresh unpaid order: lands pending_verification,
    // never paid.
    const created = await apiRequest("/api/v1/admin/orders", {
      method: "POST",
      cookie: superCookie,
      body: {
        customer_id: customerId,
        product_id: productId,
        item_kind: "package",
        package_version_id: versionId,
        package_price_id: priceId,
        quantity: 1,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body.data.order.id as string;
    const claim = await apiRequest(`/api/v1/admin/orders/${orderId}/payment-submissions`, {
      method: "POST",
      cookie: superCookie,
      body: {
        payment_method_id: methodId,
        amount_minor: 499900,
        currency_code: "BDT",
        sender_phone: "01711223344",
        transaction_id: "BKA-BIZ-B1-001",
        payment_date_display: "15/11/2026",
      },
    });
    assert.equal(claim.status, 201, JSON.stringify(claim.body));
    assert.equal(
      (await one("SELECT payment_status FROM orders WHERE id = $1", [orderId]))
        .payment_status,
      "pending_verification"
    );
    assert.ok(
      (await countWhere("outbox_events", "event_type = $1 AND aggregate_id = $2", [
        "payment.submitted",
        claim.body.data.payment_submission.id,
      ])) >= 1
    );
  }, 30_000);

  it("24. Batch 1 subscriptions/licenses detail + activation deactivate", async () => {
    const sub = await apiRequest(`/api/v1/admin/subscriptions/${subscriptionId}`, {
      cookie: superCookie,
    });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.data.id, subscriptionId);
    assert.ok(Array.isArray(sub.body.data.renewal_invoices));

    // NOTE: grantLicenseId (test 14) cannot be used here — test 15 revoked
    // it, and revocation deactivates every live activation. licenseId (the
    // subscription license, tests 9-11) still has 3 active activations.
    const lic = await apiRequest(`/api/v1/admin/licenses/${licenseId}`, {
      cookie: superCookie,
    });
    assert.equal(lic.status, 200, JSON.stringify(lic.body));
    assert.ok(!("license_key_hash" in lic.body.data), "detail must never expose the key hash");
    assert.ok(Array.isArray(lic.body.data.entitlement_snapshots));
    const acts = await apiRequest(`/api/v1/admin/licenses/${licenseId}/activations`, {
      cookie: superCookie,
    });
    assert.equal(acts.status, 200, JSON.stringify(acts.body));
    assert.ok(acts.body.data.items.length >= 1);
    const activeAct = acts.body.data.items.find((a: any) => a.status === "active");
    assert.ok(activeAct, "expected at least one active activation");
    const deactivated = await apiRequest(
      `/api/v1/admin/licenses/${licenseId}/activations/${activeAct.id}/deactivate`,
      { method: "POST", cookie: superCookie, body: { reason: "B1 test deactivate" } }
    );
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.activation.status, "deactivated");
    assert.equal(
      (await one("SELECT status FROM license_activations WHERE id = $1", [activeAct.id]))
        .status,
      "deactivated"
    );
    const again = await apiRequest(
      `/api/v1/admin/licenses/${licenseId}/activations/${activeAct.id}/deactivate`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(again.status, 409, JSON.stringify(again.body));
  }, 30_000);

  it("25. Batch 1 sites: detail, patch, product assign/remove, credentials, domains (never auto-verified)", async () => {
    const detail = await apiRequest(`/api/v1/admin/integrated-sites/${siteId}`, {
      cookie: superCookie,
    });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.ok(Array.isArray(detail.body.data.domains));
    const patched = await apiRequest(`/api/v1/admin/integrated-sites/${siteId}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { name: "BizMate Official Website (B1)" },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.name, "BizMate Official Website (B1)");

    // Second product: assign, duplicate-assign 409, remove.
    const prod2 = await apiRequest("/api/v1/admin/products", {
      method: "POST",
      cookie: superCookie,
      body: {
        code: "BIZMATE2",
        slug: "biz-mate-addon",
        name: "BizMate Add-on",
        product_type: "wordpress_plugin",
        fulfillment_type: "software_license",
        default_activation_limit: 1,
        offline_grace_hours: 24,
      },
    });
    assert.equal(prod2.status, 201, JSON.stringify(prod2.body));
    const prod2Id = prod2.body.data.id as string;
    const assigned = await apiRequest(`/api/v1/admin/integrated-sites/${siteId}/products`, {
      method: "POST",
      cookie: superCookie,
      body: { product_id: prod2Id },
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.ok(assigned.body.data.product_ids.includes(prod2Id));
    const dupAssign = await apiRequest(`/api/v1/admin/integrated-sites/${siteId}/products`, {
      method: "POST",
      cookie: superCookie,
      body: { product_id: prod2Id },
    });
    assert.equal(dupAssign.status, 409, JSON.stringify(dupAssign.body));
    const removed = await apiRequest(
      `/api/v1/admin/integrated-sites/${siteId}/products/${prod2Id}`,
      { method: "DELETE", cookie: superCookie }
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.ok(!removed.body.data.product_ids.includes(prod2Id));

    // Credential with the cancel scope (used by the server-cancel test 27).
    const cred = await apiRequest(`/api/v1/admin/integrated-sites/${siteId}/credentials`, {
      method: "POST",
      cookie: superCookie,
      body: {
        credential_type: "hmac_shared_secret",
        scopes: ["catalog.read", "orders.cancel:own"],
      },
    });
    assert.equal(cred.status, 201, JSON.stringify(cred.body));
    assert.ok(cred.body.data.credential.key_id);
    assert.ok(cred.body.data.raw_secret_once, "raw secret is returned exactly once");
    b1CancelKeyId = cred.body.data.credential.key_id as string;
    b1CancelSecret = cred.body.data.raw_secret_once as string;
    const creds = await apiRequest(`/api/v1/admin/integrated-sites/${siteId}/credentials`, {
      cookie: superCookie,
    });
    assert.equal(creds.status, 200, JSON.stringify(creds.body));
    assert.ok(creds.body.data.items.length >= 2);
    assert.ok(!("secret_ciphertext" in creds.body.data.items[0]));

    // Domains: register -> pending (never auto-verified).
    const domain = await apiRequest(`/api/v1/admin/integrated-sites/${siteId}/domains`, {
      method: "POST",
      cookie: superCookie,
      body: { domain: "shop.bizstore.bd", verification_method: "dns_txt" },
    });
    assert.equal(domain.status, 201, JSON.stringify(domain.body));
    const newDomain = domain.body.data.domains.find((d: any) => d.domain === "shop.bizstore.bd");
    assert.ok(newDomain, "new domain missing from site domains");
    assert.equal(newDomain.verification_status, "pending");
    assert.ok(
      newDomain.verification_challenge.startsWith("stackmate-site-verification=")
    );
    // Automated dns_txt verification is REAL now (H-6, via DoH): a
    // domain with no TXT record fails with 422 — it is never
    // auto-verified. (The old 409 "not implemented" is gone.)
    const autoVerify = await apiRequest(
      `/api/v1/admin/integrated-sites/${siteId}/domains/${newDomain.id}/verify`,
      { method: "POST", cookie: superCookie, body: { method: "dns_txt" } }
    );
    assert.equal(autoVerify.status, 422, JSON.stringify(autoVerify.body));
    assert.equal(autoVerify.body.error.code, "VALIDATION_ERROR");
    assert.ok(
      String(autoVerify.body.error.message).includes("DNS TXT verification failed"),
      JSON.stringify(autoVerify.body),
    );
    // Manual review with a note verifies it.
    const manual = await apiRequest(
      `/api/v1/admin/integrated-sites/${siteId}/domains/${newDomain.id}/verify`,
      {
        method: "POST",
        cookie: superCookie,
        body: { method: "manual_review", reviewer_note: "B1 test: DNS TXT checked by hand." },
      }
    );
    assert.equal(manual.status, 200, JSON.stringify(manual.body));
    assert.equal(
      manual.body.data.domains.find((d: any) => d.domain === "shop.bizstore.bd")
        .verification_status,
      "verified"
    );
    // Challenge regeneration resets to pending.
    const challenge = await apiRequest(
      `/api/v1/admin/integrated-sites/${siteId}/domains/${newDomain.id}/verification-challenge`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
    assert.equal(
      challenge.body.data.domains.find((d: any) => d.domain === "shop.bizstore.bd")
        .verification_status,
      "pending"
    );
    // Delete the extra domain (the primary remains).
    const deleted = await apiRequest(
      `/api/v1/admin/integrated-sites/${siteId}/domains/${newDomain.id}`,
      { method: "DELETE", cookie: superCookie }
    );
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.ok(!deleted.body.data.domains.some((d: any) => d.domain === "shop.bizstore.bd"));

    // Suspend + revoke on a disposable second site (never the main site).
    const site2 = await apiRequest("/api/v1/admin/integrated-sites", {
      method: "POST",
      cookie: superCookie,
      body: {
        name: "B1 Disposable Site",
        environment: "staging",
        primary_domain: "b1-disposable.example",
        product_ids: [productId],
        allowed_capabilities: ["catalog.read"],
      },
    });
    assert.equal(site2.status, 201, JSON.stringify(site2.body));
    const site2Id = site2.body.data.site.id as string;
    const suspended = await apiRequest(
      `/api/v1/admin/integrated-sites/${site2Id}/suspend`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.data.status, "suspended");
    const suspendAgain = await apiRequest(
      `/api/v1/admin/integrated-sites/${site2Id}/suspend`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(suspendAgain.status, 409, JSON.stringify(suspendAgain.body));
    const revoked = await apiRequest(`/api/v1/admin/integrated-sites/${site2Id}/revoke`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.data.status, "revoked");
    const revokeAgain = await apiRequest(`/api/v1/admin/integrated-sites/${site2Id}/revoke`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(revokeAgain.status, 409, JSON.stringify(revokeAgain.body));
  }, 30_000);

  it("26. Batch 1 webhooks: test delivery records a failed delivery; outbox list + replay of dead-letter", async () => {
    const created = await apiRequest("/api/v1/admin/webhooks", {
      method: "POST",
      cookie: superCookie,
      body: {
        // 192.0.2.1 is TEST-NET-1 (RFC 5737 documentation range): it passes
        // the SSRF validator (not private/loopback/link-local) but is
        // guaranteed unroutable, so delivery fails — which is the point:
        // a failed delivery must be recorded, not crash the endpoint.
        // (Loopback targets are blocked by SSRF policy, so 127.0.0.1
        // cannot be used here.)
        url: "https://192.0.2.1/b1-hook",
        description: "B1 test endpoint (unreachable)",
        subscribed_events: ["order.cancelled"],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const webhookId = created.body.data.endpoint.id as string;

    // Test delivery to an unreachable address: 200 envelope, delivered:false.
    const tested = await apiRequest(`/api/v1/admin/webhooks/${webhookId}/test`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.data.delivered, false);
    assert.ok(tested.body.data.error, "unreachable target must produce an error string");
    const deliveries = await apiRequest(`/api/v1/admin/webhooks/${webhookId}/deliveries`, {
      cookie: superCookie,
    });
    assert.equal(deliveries.status, 200, JSON.stringify(deliveries.body));
    assert.equal(deliveries.body.data.items.length, 1);
    assert.equal(deliveries.body.data.items[0].status, "failed");

    const outbox = await apiRequest("/api/v1/admin/outbox-events?status=pending", {
      cookie: superCookie,
    });
    assert.equal(outbox.status, 200, JSON.stringify(outbox.body));
    assert.ok(Array.isArray(outbox.body.data.items));
    // Replaying a pending event is a duplicate risk -> 409.
    const pendingEvent = outbox.body.data.items[0];
    if (pendingEvent) {
      const replayPending = await apiRequest(
        `/api/v1/admin/outbox-events/${pendingEvent.id}/replay`,
        { method: "POST", cookie: superCookie, body: {} }
      );
      assert.equal(replayPending.status, 409, JSON.stringify(replayPending.body));
    }
    // A dead-lettered event replays to pending with a fresh attempt budget.
    const deadId = randomUUID();
    await adminClient.query(
      `INSERT INTO outbox_events (id, event_key, event_type, aggregate_type, aggregate_id, status, attempt_count, available_at, payload)
       VALUES ($1, $2, 'webhook.test', 'webhook_endpoint', $3, 'dead_letter', 3, NOW(), '{}'::jsonb)`,
      [deadId, `b1-dead-letter-${deadId}`, webhookId]
    );
    const replayed = await apiRequest(`/api/v1/admin/outbox-events/${deadId}/replay`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    assert.equal(replayed.body.data.status, "pending");
    assert.equal(replayed.body.data.attempt_count, 0);
  }, 30_000);

  it("27. Batch 1 public/server: product + package detail, signed packages list, signed order cancel", async () => {
    const prodDetail = await apiRequest(
      `/api/v1/public/sites/${siteKey}/products/biz-mate-plugin`,
      { headers: { "X-StackMate-Site-Key": siteKey } }
    );
    assert.equal(prodDetail.status, 200, JSON.stringify(prodDetail.body));
    assert.equal(prodDetail.body.data.slug, "biz-mate-plugin");
    assert.ok(Array.isArray(prodDetail.body.data.packages));

    const currentVersionId = (
      await one("SELECT current_version_id FROM product_packages WHERE product_id = $1", [
        productId,
      ])
    ).current_version_id as string;
    const pkgDetail = await apiRequest(
      `/api/v1/public/sites/${siteKey}/packages/${currentVersionId}`,
      { headers: { "X-StackMate-Site-Key": siteKey } }
    );
    assert.equal(pkgDetail.status, 200, JSON.stringify(pkgDetail.body));
    assert.equal(pkgDetail.body.data.package_version_id, currentVersionId);
    assert.ok(pkgDetail.body.data.prices.length >= 1);
    const wrong = await apiRequest(
      `/api/v1/public/sites/${siteKey}/products/biz-mate-plugin`,
      { headers: { "X-StackMate-Site-Key": "sm_site_wrongkey0000000000000000" } }
    );
    assert.equal(wrong.status, 403, JSON.stringify(wrong.body));

    // Signed server packages list (catalog.read, original credential).
    const s2sPath = `/api/v1/integrations/sites/${siteKey}/products/biz-mate-plugin/packages`;
    const ts = Math.floor(Date.now() / 1000);
    const nonce = `nonce-biz-b1-${Date.now()}`;
    const signed = signCanonicalServerRequest(
      {
        keyId: hmacKeyId,
        timestampUnixSeconds: ts,
        nonce,
        method: "GET",
        host: "localhost:8787",
        rawPathAndQuery: s2sPath,
        rawBody: "",
      },
      hmacSharedSecret
    );
    const s2s = await apiRequest(s2sPath, {
      headers: {
        "X-StackMate-Key-Id": hmacKeyId,
        "X-StackMate-Timestamp": String(ts),
        "X-StackMate-Nonce": nonce,
        "X-StackMate-Content-SHA256": signed.contentSha256Header,
        "X-StackMate-Signature": signed.signatureHeader,
      },
    });
    assert.equal(s2s.status, 200, JSON.stringify(s2s.body));
    assert.ok(s2s.body.data.items.length >= 1);

    // Signed order cancel: the paid public order is guarded -> 409.
    const cancelPaidPath = `/api/v1/integrations/sites/${siteKey}/orders/${publicReference}/cancel`;
    const ts2 = Math.floor(Date.now() / 1000);
    const nonce2 = `nonce-biz-b1c-${Date.now()}`;
    const signed2 = signCanonicalServerRequest(
      {
        keyId: b1CancelKeyId,
        timestampUnixSeconds: ts2,
        nonce: nonce2,
        method: "POST",
        host: "localhost:8787",
        rawPathAndQuery: cancelPaidPath,
        rawBody: JSON.stringify({ reason: "B1 cancel paid" }),
      },
      b1CancelSecret
    );
    const cancelPaid = await apiRequest(cancelPaidPath, {
      method: "POST",
      headers: {
        "X-StackMate-Key-Id": b1CancelKeyId,
        "X-StackMate-Timestamp": String(ts2),
        "X-StackMate-Nonce": nonce2,
        "X-StackMate-Content-SHA256": signed2.contentSha256Header,
        "X-StackMate-Signature": signed2.signatureHeader,
      },
      body: { reason: "B1 cancel paid" },
    });
    assert.equal(cancelPaid.status, 409, JSON.stringify(cancelPaid.body));

    // Fresh unpaid checkout order, then cancel it via the server route.
    const freshCheckout = await apiRequest(`/api/v1/public/sites/${siteKey}/checkout/orders`, {
      method: "POST",
      headers: { "X-StackMate-Site-Key": siteKey, "Idempotency-Key": "idem-biz-b1-cancel-order" },
      body: {
        items: [
          {
            product_slug: "biz-mate-plugin",
            package_version_id: currentVersionId,
            price_id: priceId,
            quantity: 1,
          },
        ],
        customer: { name: "B1 Cancel", email: "b1-cancel@example.com" },
      },
    });
    assert.equal(freshCheckout.status, 201, JSON.stringify(freshCheckout.body));
    const freshRef = freshCheckout.body.data.order.public_reference as string;
    const cancelPath = `/api/v1/integrations/sites/${siteKey}/orders/${freshRef}/cancel`;
    const ts3 = Math.floor(Date.now() / 1000);
    const nonce3 = `nonce-biz-b1c2-${Date.now()}`;
    const signed3 = signCanonicalServerRequest(
      {
        keyId: b1CancelKeyId,
        timestampUnixSeconds: ts3,
        nonce: nonce3,
        method: "POST",
        host: "localhost:8787",
        rawPathAndQuery: cancelPath,
        rawBody: JSON.stringify({ reason: "B1 cancel fresh" }),
      },
      b1CancelSecret
    );
    const cancelled = await apiRequest(cancelPath, {
      method: "POST",
      headers: {
        "X-StackMate-Key-Id": b1CancelKeyId,
        "X-StackMate-Timestamp": String(ts3),
        "X-StackMate-Nonce": nonce3,
        "X-StackMate-Content-SHA256": signed3.contentSha256Header,
        "X-StackMate-Signature": signed3.signatureHeader,
      },
      body: { reason: "B1 cancel fresh" },
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, "cancelled");
    assert.equal(
      (await one("SELECT status FROM orders WHERE public_reference = $1", [freshRef])).status,
      "cancelled"
    );

    // Revoke the cancel-scope credential now that it served its purpose.
    const credRow = await one("SELECT id FROM site_credentials WHERE key_id = $1", [
      b1CancelKeyId,
    ]);
    const revoked = await apiRequest(
      `/api/v1/admin/integrated-sites/${siteId}/credentials/${credRow.id}/revoke`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.data.status, "revoked");
  }, 30_000);

  it("28. Batch 1 features/packages/prices: update, archive, retire", async () => {
    const feat = await apiRequest(`/api/v1/admin/products/${productId}/features`, {
      method: "POST",
      cookie: superCookie,
      body: { feature_key: "b1_extra", name: "B1 Extra", value_type: "boolean" },
    });
    assert.equal(feat.status, 201, JSON.stringify(feat.body));
    const featId = feat.body.data.id as string;
    const fDetail = await apiRequest(
      `/api/v1/admin/products/${productId}/features/${featId}`,
      { cookie: superCookie }
    );
    assert.equal(fDetail.status, 200, JSON.stringify(fDetail.body));
    const fPatched = await apiRequest(
      `/api/v1/admin/products/${productId}/features/${featId}`,
      { method: "PATCH", cookie: superCookie, body: { name: "B1 Extra Renamed" } }
    );
    assert.equal(fPatched.status, 200, JSON.stringify(fPatched.body));
    assert.equal(
      (await one("SELECT name FROM product_features WHERE id = $1", [featId])).name,
      "B1 Extra Renamed"
    );
    const archived = await apiRequest(
      `/api/v1/admin/products/${productId}/features/${featId}/archive`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.data.status, "archived");
    // Archiving a feature referenced by the published version -> 409.
    const archPub = await apiRequest(
      `/api/v1/admin/products/${productId}/features/${featureId}/archive`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(archPub.status, 409, JSON.stringify(archPub.body));

    const packageId = (
      await one("SELECT id FROM product_packages WHERE product_id = $1", [productId])
    ).id as string;
    const pDetail = await apiRequest(`/api/v1/admin/packages/${packageId}`, {
      cookie: superCookie,
    });
    assert.equal(pDetail.status, 200, JSON.stringify(pDetail.body));
    const pPatched = await apiRequest(`/api/v1/admin/packages/${packageId}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { name: "Agency Plan (B1)" },
    });
    assert.equal(pPatched.status, 200, JSON.stringify(pPatched.body));

    // Price: create -> get -> patch -> disable; the order-used price cannot be patched.
    const price2 = await apiRequest(`/api/v1/admin/package-versions/${versionId}/prices`, {
      method: "POST",
      cookie: superCookie,
      body: {
        price_key: "bdt-monthly-b1",
        price_kind: "recurring",
        amount_minor: 49900,
        currency_code: "BDT",
        interval_unit: "month",
        interval_count: 1,
      },
    });
    assert.equal(price2.status, 201, JSON.stringify(price2.body));
    const price2Id = price2.body.data.id as string;
    const prDetail = await apiRequest(`/api/v1/admin/prices/${price2Id}`, {
      cookie: superCookie,
    });
    assert.equal(prDetail.status, 200, JSON.stringify(prDetail.body));
    const prPatched = await apiRequest(`/api/v1/admin/prices/${price2Id}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { amount_minor: 54900 },
    });
    assert.equal(prPatched.status, 200, JSON.stringify(prPatched.body));
    assert.equal(
      Number((await one("SELECT amount_minor FROM package_prices WHERE id = $1", [price2Id])).amount_minor),
      54900
    );
    const prDisabled = await apiRequest(`/api/v1/admin/prices/${price2Id}/disable`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(prDisabled.status, 200, JSON.stringify(prDisabled.body));
    assert.equal(prDisabled.body.data.status, "inactive");
    const usedPatch = await apiRequest(`/api/v1/admin/prices/${priceId}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { amount_minor: 1 },
    });
    assert.equal(usedPatch.status, 409, JSON.stringify(usedPatch.body));

    // Version: create v2 -> publish -> retire (package back to draft).
    const v2 = await apiRequest(`/api/v1/admin/packages/${packageId}/versions`, {
      method: "POST",
      cookie: superCookie,
      body: {
        features: [
          {
            product_feature_id: featureId,
            entitlement_value: { value_type: "boolean", value: true },
          },
        ],
        change_summary: "B1 v2",
      },
    });
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    const v2Id = v2.body.data.id as string;
    const pubV2 = await apiRequest(`/api/v1/admin/package-versions/${v2Id}/publish`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(pubV2.status, 200, JSON.stringify(pubV2.body));
    const retired = await apiRequest(`/api/v1/admin/package-versions/${v2Id}/retire`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    assert.equal(
      (await one("SELECT status FROM product_packages WHERE id = $1", [packageId])).status,
      "draft"
    );
    assert.equal(
      (await one("SELECT current_version_id FROM product_packages WHERE id = $1", [packageId]))
        .current_version_id,
      null
    );
    const again = await apiRequest(`/api/v1/admin/package-versions/${v2Id}/retire`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(again.status, 409, JSON.stringify(again.body));
  }, 30_000);

  it("29. Batch 1 roles + invitations: role CRUD works; invitations persist via DrizzleStore wiring (migration 0005)", async () => {
    const role = await apiRequest("/api/v1/admin/roles", {
      method: "POST",
      cookie: superCookie,
      body: {
        key: "support_agent_b1",
        name: "Support Agent B1",
        permissions: ["customers.read", "orders.read"],
      },
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const roleId = role.body.data.id as string;
    const patched = await apiRequest(`/api/v1/admin/roles/${roleId}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { name: "Support Agent B1 (Renamed)" },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.name, "Support Agent B1 (Renamed)");
    // The super_admin role is unmodifiable.
    const superRole = (await one("SELECT id FROM roles WHERE key = $1", ["super_admin"]))
      .id as string;
    const superPatch = await apiRequest(`/api/v1/admin/roles/${superRole}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { name: "Nope" },
    });
    assert.equal(superPatch.status, 403, JSON.stringify(superPatch.body));

    // Invitations: the DrizzleStore wiring for staff_invitations landed
    // with the batch1 invitations patch (migration 0005), so creating an
    // invitation must now succeed (201) AND persist — the row must survive
    // a fresh request (state reload) and show up in the invitations list.
    // The pre-wiring 503 fail-closed behavior is covered by the in-memory
    // suite (apps/api/test/staff-invitations.test.ts), which probes the
    // supportsStaffInvitations flag on an unwired store.
    const invite = await apiRequest("/api/v1/admin/users/invitations", {
      method: "POST",
      cookie: superCookie,
      body: {
        email: "invite-b1@stackmate.local",
        name: "B1 Invitee",
        role_keys: ["support_agent_b1"],
      },
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    assert.equal(invite.body.data.invitation.email, "invite-b1@stackmate.local");
    assert.equal(invite.body.data.invitation.status, "pending");
    assert.equal(typeof invite.body.data.token_once, "string");
    assert.ok(invite.body.data.token_once.length > 0);
    assert.equal(await count("SELECT COUNT(*) AS count FROM staff_invitations"), 1);
    const listed = await apiRequest("/api/v1/admin/users/invitations", {
      method: "GET",
      cookie: superCookie,
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(
      (listed.body.data.items as Array<{ email: string }>).some(
        (row) => row.email === "invite-b1@stackmate.local"
      ),
      JSON.stringify(listed.body)
    );
  }, 30_000);
});
