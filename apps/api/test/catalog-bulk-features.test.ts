/**
 * Catalog bulk features + feature→package usage (product-flow fix batch).
 *
 * In-memory test adapter (NOT Postgres) — drives the real HTTP app the
 * way stackmate-e2e.test.ts does:
 *   POST /api/v1/admin/products/:productId/features/bulk
 *   GET  /api/v1/admin/products/:productId/features (+ detail) with
 *        used_by_packages[]
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app";
import { resolveRuntimeConfig } from "../src/env";
import { StackMateDataStore } from "../src/platform/db/store";

describe("Catalog bulk features + feature usage (in-memory)", () => {
  // Test-only fixture value (never a real secret): the operator-set
  // SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
  const TEST_SETUP_TOKEN =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;

  beforeEach(() => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    app = createStackMateApp(store);
  });

  async function apiRequest(
    path: string,
    init: RequestInit = {},
    cookie?: string,
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers(init.headers || {});
    if (cookie) headers.set("Cookie", cookie);
    const res = await app.fetch(
      new Request(`http://localhost:8787${path}`, { ...init, headers }),
      env,
    );
    return { status: res.status, body: await res.json(), headers: res.headers };
  }


  // A-01: the session token is cookie-only — sign-in JSON no longer
  // carries session_token, so the cookie comes from Set-Cookie.
  function sessionCookieFromHeaders(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    const pair = setCookies.find((c) => c.startsWith("stackmate_session="));
    assert.ok(pair, "sign-in must set a stackmate_session cookie");
    return pair!.split(";")[0]!;
  }

  async function bootstrapAndLoginSuperAdmin(): Promise<string> {
    const bootRes = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bulk Test Admin",
        email: "bulk-admin@stackmate.local",
        password: "StackMate#SuperAdmin2026!",
        setupToken: TEST_SETUP_TOKEN,
      }),
    });
    assert.equal(bootRes.status, 201);
    const signInRes = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bulk-admin@stackmate.local",
        password: "StackMate#SuperAdmin2026!",
      }),
    });
    assert.equal(signInRes.status, 200);
    return sessionCookieFromHeaders(signInRes.headers);
  }

  async function createProduct(cookie: string): Promise<string> {
    const res = await apiRequest(
      "/api/v1/admin/products",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "BULKPROD",
          slug: "bulk-prod",
          name: "Bulk Product",
          product_type: "wordpress_plugin",
          fulfillment_type: "software_license",
          default_activation_limit: 3,
          offline_grace_hours: 168,
        }),
      },
      cookie,
    );
    assert.equal(res.status, 201, `product create failed: ${JSON.stringify(res.body)}`);
    return res.body.data.id as string;
  }

  function bulkRow(key: string, name: string, valueType = "boolean") {
    return { feature_key: key, name, value_type: valueType };
  }

  it("1. Bulk-creates several features at once under one product", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const productId = await createProduct(cookie);

    const res = await apiRequest(
      `/api/v1/admin/products/${productId}/features/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: [
            bulkRow("pos_module", "POS Integration"),
            bulkRow("monthly_orders", "Monthly orders", "quota"),
            bulkRow("seats", "Seats", "limit"),
          ],
        }),
      },
      cookie,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.created.length, 3);
    assert.deepEqual(res.body.data.errors, []);
    assert.equal(res.body.data.created[0].feature_key, "pos_module");
    assert.equal(res.body.data.created[0].status, "active");
    assert.deepEqual(res.body.data.created[0].used_by_packages, []);

    const list = await apiRequest(
      `/api/v1/admin/products/${productId}/features`,
      { method: "GET" },
      cookie,
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.data.items.length, 3);

    // One summary audit entry, not one per feature.
    const bulkAudits = (store.state.audit_logs as unknown as Array<Record<string, unknown>>).filter(
      (a) => a.action === "catalog.feature.bulk_created",
    );
    assert.equal(bulkAudits.length, 1);
    assert.equal((bulkAudits[0]!.changes as Record<string, unknown>).created_count, 3);
  });

  it("2. Partial failure: valid rows land, bad rows are reported per-row (never silent)", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const productId = await createProduct(cookie);

    const res = await apiRequest(
      `/api/v1/admin/products/${productId}/features/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: [
            bulkRow("good_one", "Good one"),
            bulkRow("good_one", "Duplicate of row 0"),
            { feature_key: "Bad-Key!", name: "Bad key", value_type: "boolean" },
            { feature_key: "no_name", name: "x", value_type: "boolean" },
          ],
        }),
      },
      cookie,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.created.length, 1);
    assert.equal(res.body.data.created[0].feature_key, "good_one");
    assert.equal(res.body.data.errors.length, 3);
    assert.deepEqual(
      res.body.data.errors.map((e: { index: number }) => e.index),
      [1, 2, 3],
    );
    assert.match(res.body.data.errors[0].error, /already exists/);
    assert.equal(res.body.data.errors[1].feature_key, "Bad-Key!");

    const list = await apiRequest(
      `/api/v1/admin/products/${productId}/features`,
      { method: "GET" },
      cookie,
    );
    assert.equal(list.body.data.items.length, 1);
    assert.equal(list.body.data.items[0].feature_key, "good_one");
  });

  it("3. All-invalid bulk is a 422 with per-row errors — nothing is created", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const productId = await createProduct(cookie);

    const res = await apiRequest(
      `/api/v1/admin/products/${productId}/features/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: [{ feature_key: "Bad-Key!", name: "Bad", value_type: "boolean" }],
        }),
      },
      cookie,
    );
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
    assert.ok(Array.isArray(res.body.error.details.errors));
    assert.equal(res.body.error.details.errors[0].index, 0);

    const list = await apiRequest(
      `/api/v1/admin/products/${productId}/features`,
      { method: "GET" },
      cookie,
    );
    assert.equal(list.body.data.items.length, 0);
  });

  it("4. Envelope rules: empty array and >100 rows are rejected, missing product is 404", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const productId = await createProduct(cookie);

    const empty = await apiRequest(
      `/api/v1/admin/products/${productId}/features/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: [] }),
      },
      cookie,
    );
    assert.equal(empty.status, 422);

    const tooMany = await apiRequest(
      `/api/v1/admin/products/${productId}/features/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: Array.from({ length: 101 }, (_, i) => bulkRow(`f_${i}`, `F ${i}`)),
        }),
      },
      cookie,
    );
    assert.equal(tooMany.status, 422);

    const missing = await apiRequest(
      "/api/v1/admin/products/00000000-0000-0000-0000-000000000000/features/bulk",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: [bulkRow("x_one", "X one")] }),
      },
      cookie,
    );
    assert.equal(missing.status, 404);
  });

  it("5. used_by_packages: empty until a package version grants the feature", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const productId = await createProduct(cookie);

    const featRes = await apiRequest(
      `/api/v1/admin/products/${productId}/features`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bulkRow("pos_module", "POS Integration")),
      },
      cookie,
    );
    assert.equal(featRes.status, 201);
    const featureId = featRes.body.data.id as string;
    assert.deepEqual(featRes.body.data.used_by_packages, []);

    // Second feature, never granted anywhere.
    const feat2Res = await apiRequest(
      `/api/v1/admin/products/${productId}/features`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bulkRow("unused_one", "Unused one")),
      },
      cookie,
    );
    const feature2Id = feat2Res.body.data.id as string;

    const pkgRes = await apiRequest(
      `/api/v1/admin/products/${productId}/packages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          package_key: "agency-plan",
          name: "Agency Plan",
          features: [
            {
              product_feature_id: featureId,
              entitlement_value: { value_type: "boolean", value: true },
            },
          ],
          change_summary: "Initial Agency Plan release",
        }),
      },
      cookie,
    );
    assert.equal(pkgRes.status, 201);
    const packageId = pkgRes.body.data.package.id as string;
    const versionId = pkgRes.body.data.version.id as string;

    const list = await apiRequest(
      `/api/v1/admin/products/${productId}/features`,
      { method: "GET" },
      cookie,
    );
    const used = list.body.data.items.find((f: { id: string }) => f.id === featureId);
    assert.equal(used.used_by_packages.length, 1);
    assert.equal(used.used_by_packages[0].package_id, packageId);
    assert.equal(used.used_by_packages[0].package_name, "Agency Plan");
    assert.equal(used.used_by_packages[0].package_key, "agency-plan");
    assert.equal(used.used_by_packages[0].version_number, 1);
    assert.equal(used.used_by_packages[0].version_status, "draft");
    const unused = list.body.data.items.find((f: { id: string }) => f.id === feature2Id);
    assert.deepEqual(unused.used_by_packages, []);

    // Detail carries the same association.
    const detail = await apiRequest(
      `/api/v1/admin/products/${productId}/features/${featureId}`,
      { method: "GET" },
      cookie,
    );
    assert.equal(detail.body.data.used_by_packages.length, 1);

    // Publishing the version flips the reported version status.
    const pub = await apiRequest(
      `/api/v1/admin/package-versions/${versionId}/publish`,
      { method: "POST" },
      cookie,
    );
    assert.equal(pub.status, 200);
    const afterPublish = await apiRequest(
      `/api/v1/admin/products/${productId}/features/${featureId}`,
      { method: "GET" },
      cookie,
    );
    assert.equal(afterPublish.body.data.used_by_packages[0].version_status, "published");

    // A new version (v2) granting the same feature moves the entry to v2.
    const v2 = await apiRequest(
      `/api/v1/admin/packages/${packageId}/versions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: [
            {
              product_feature_id: featureId,
              entitlement_value: { value_type: "boolean", value: true },
            },
          ],
          change_summary: "v2",
        }),
      },
      cookie,
    );
    assert.equal(v2.status, 201);
    const afterV2 = await apiRequest(
      `/api/v1/admin/products/${productId}/features/${featureId}`,
      { method: "GET" },
      cookie,
    );
    assert.equal(afterV2.body.data.used_by_packages.length, 1);
    assert.equal(afterV2.body.data.used_by_packages[0].version_number, 2);
    assert.equal(afterV2.body.data.used_by_packages[0].version_status, "draft");
  });

  it("6. Bulk rejects a bad entitlement value per-row while good rows land", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const productId = await createProduct(cookie);

    const res = await apiRequest(
      `/api/v1/admin/products/${productId}/features/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: [
            {
              feature_key: "bad_default",
              name: "Bad default",
              value_type: "boolean",
              // value_type says boolean but the default is a limit object.
              default_value: { value_type: "limit", value: 5 },
            },
            bulkRow("good_two", "Good two"),
          ],
        }),
      },
      cookie,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.created.length, 1);
    assert.equal(res.body.data.created[0].feature_key, "good_two");
    assert.equal(res.body.data.errors.length, 1);
    assert.equal(res.body.data.errors[0].index, 0);
    assert.match(res.body.data.errors[0].error, /does not match/);
  });
});
