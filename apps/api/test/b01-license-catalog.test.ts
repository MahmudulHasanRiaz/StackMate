/**
 * B-01 wiring — license validate + public catalog on a createTargeted store.
 *
 * Proves the WIRED handlers (POST /api/v1/licenses/validate and the four
 * GET /api/v1/public/sites/:siteKey/... catalog routes) return the CORRECT
 * responses when the request store is a `DrizzleStore.createTargeted`
 * store whose state holds only seed rows — i.e. they never touch the
 * full-state load. Each HTTP test runs inside a full-load query counter:
 * the combined full-state load is a single SELECT carrying the per-table
 * json_agg aliases (`AS "audit"`, `AS "users"`), so a zero count proves
 * no full load happened on that request. A bare json_agg match would NOT
 * prove it: the batched targeted reads use json_agg too.
 *
 * Runs on its own fresh database (stackmate_test_b01) via setupTestDb;
 * the shared stackmate_test database is never touched and no rows are
 * deleted from it. The scratch database is dropped afterwards by the
 * helper's cleanup, as in the other integration suites.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Hono } from "hono";
import {
  DATABASE_URL,
  setupTestDb,
  seedCustomer,
  seedProduct,
  seedLicense,
  seedSite,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import type { StackMateDataStore } from "../src/platform/db/store.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { onErrorHandler } from "../src/middleware/error-handler.ts";
import { registerLicensesRoutes } from "../src/routes/licenses/index.ts";
import { registerPublicRoutes } from "../src/routes/public/index.ts";
import {
  computeInstallationIdHash,
  computeLicenseKeyVerifier,
  computeLicenseKeyVerifierV2,
  generateFormattedLicenseKey,
} from "../src/platform/crypto/index.ts";
import type { AppEnv } from "../src/types/context.ts";

const INSTALLATION_ID = "b01-installation-1";
const SEED_LAST_SEEN = new Date(Date.now() - 3_600_000).toISOString();

/**
 * Count pg queries while patched; returns full-state-load hits. The
 * combined full-state load is a single SELECT whose columns are the
 * per-table json_agg aliases (`AS "audit"`, `AS "users"`, …) — match
 * that fingerprint, not the json_agg function name: the batched
 * targeted reads (findLicenseForValidation, loadPublicCatalog,
 * findIntegratedSiteByKey) use json_agg too. Same fingerprint as
 * b01-measure.test.ts.
 */
function countFullLoadQueries() {
  let total = 0;
  let fullLoad = 0;
  const orig = Client.prototype.query as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]) {
    total += 1;
    const sql = String(
      (args[0] as { text?: unknown } | undefined)?.text ?? args[0] ?? ""
    );
    if (sql.includes('AS "audit"') && sql.includes('AS "users"')) fullLoad += 1;
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
  Client.prototype.query = patched as never;
  return {
    counts: () => ({ total, fullLoad }),
    restore: () => {
      Client.prototype.query = orig as never;
    },
  };
}

describe("B-01 wiring — license validate + public catalog on a targeted store", () => {
  let seedStore: DrizzleStore;
  let targeted: DrizzleStore;
  let adminClient: Client;
  let cleanup: () => Promise<void>;
  let dbUrl: string;
  let app: Hono<AppEnv>;
  let env: ReturnType<typeof resolveRuntimeConfig>;

  let siteKey = "";
  let productSlug = "";
  let productCode = "";
  let otherSlug = "";
  let versionId = "";
  let rawKeyV2 = "";
  let rawKeyV1 = "";
  let licenseNumber = "";
  let activationId = "";

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(new Request(`http://localhost:8787${path}`, init), env);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  beforeAll(async () => {
    const setup = await setupTestDb("stackmate_test_b01");
    seedStore = setup.store;
    adminClient = setup.adminClient;
    cleanup = setup.cleanup;
    const url = new URL(DATABASE_URL!);
    url.pathname = "/stackmate_test_b01";
    dbUrl = url.toString();
    env = resolveRuntimeConfig({ APP_ENV: "test" });

    await seedStore.withTransaction((state) => {
      const customer = seedCustomer(state, { email: "b01@example.com" });
      const product = seedProduct(state, {
        code: "B01PROD",
        slug: "b01-product",
        name: "B01 Product",
        status: "active",
      });
      productSlug = product.slug;
      productCode = product.code;
      const other = seedProduct(state, {
        code: "B01OTHER",
        slug: "b01-other-product",
        name: "B01 Other Product",
        status: "active",
      });
      otherSlug = other.slug;

      const featureId = randomUUID();
      state.product_features.push({
        id: featureId,
        product_id: product.id,
        feature_key: "seats",
        name: "Seats",
        description: "Seat limit",
        value_type: "limit",
        unit: "seats",
        default_value: 3,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const pkgId = randomUUID();
      versionId = randomUUID();
      state.product_packages.push({
        id: pkgId,
        product_id: product.id,
        package_key: "starter",
        name: "Starter",
        description: "Starter package",
        status: "active",
        current_version_id: versionId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      state.package_versions.push({
        id: versionId,
        package_id: pkgId,
        product_id: product.id,
        version_number: 1,
        status: "published",
        change_summary: null,
        features: [
          {
            id: randomUUID(),
            package_version_id: versionId,
            product_id: product.id,
            product_feature_id: featureId,
            feature_key_snapshot: "seats",
            value_type_snapshot: "limit",
            entitlement_value: 5,
            unit_snapshot: "seats",
          },
        ],
        published_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
      state.package_prices.push({
        id: randomUUID(),
        package_version_id: versionId,
        price_key: "once",
        price_kind: "one_time",
        amount_minor: 250_000,
        currency_code: "BDT",
        interval_unit: null,
        interval_count: null,
        trial_days: 0,
        setup_fee_minor: 0,
        status: "active",
        used_in_orders: false,
        created_at: new Date().toISOString(),
      });

      const site = seedSite(state);
      site.product_ids = [product.id];
      siteKey = site.site_key;

      // v2 license (current minter) + v1 license (legacy verifier):
      // the targeted validate must accept both, like the old scan did.
      const v2 = generateFormattedLicenseKey(product.code);
      rawKeyV2 = v2.rawKey;
      const licenseV2 = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        license_key_hash: computeLicenseKeyVerifierV2(rawKeyV2, env.LICENSE_VERIFIER_SECRET),
      });
      licenseNumber = licenseV2.license_number;
      activationId = randomUUID();
      licenseV2.activations.push({
        id: activationId,
        license_id: licenseV2.id,
        installation_id_hash: computeInstallationIdHash(licenseV2.id, INSTALLATION_ID),
        domain_normalized: null,
        environment: "production",
        status: "active",
        activated_at: SEED_LAST_SEEN,
        last_seen_at: SEED_LAST_SEEN,
        deactivated_at: null,
        metadata: {},
        created_at: SEED_LAST_SEEN,
      });

      const v1 = generateFormattedLicenseKey(product.code);
      rawKeyV1 = v1.rawKey;
      const licenseV1 = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        license_key_hash: computeLicenseKeyVerifier(rawKeyV1, env.LICENSE_VERIFIER_SECRET),
      });
      licenseV1.activations.push({
        id: randomUUID(),
        license_id: licenseV1.id,
        installation_id_hash: computeInstallationIdHash(licenseV1.id, INSTALLATION_ID),
        domain_normalized: null,
        environment: "production",
        status: "active",
        activated_at: SEED_LAST_SEEN,
        last_seen_at: SEED_LAST_SEEN,
        deactivated_at: null,
        metadata: {},
        created_at: SEED_LAST_SEEN,
      });
    });

    // The store under test: targeted only, signing keys loaded (the
    // validate path must sign entitlement tokens). Its state holds
    // only seed rows — no licenses, no products.
    targeted = await DrizzleStore.createTargeted({
      connectionString: dbUrl,
      loadSigningKey: true,
    });
    assert.equal(targeted.state.licenses.length, 0);
    assert.equal(targeted.state.products.length, 0);

    app = new Hono<AppEnv>();
    app.onError(onErrorHandler);
    app.use("*", async (c, next) => {
      c.set("store", targeted as StackMateDataStore);
      c.set("env", env);
      c.set("requestId", `req_b01_${randomUUID().slice(0, 8)}`);
      c.set("principal", null);
      await next();
    });
    registerLicensesRoutes(app);
    registerPublicRoutes(app);
  }, 120_000);

  afterAll(async () => {
    try {
      await targeted.close();
    } catch {}
    await cleanup?.();
  });

  it("license validate (v2 key): 200 + entitlement token, no full-state load, heartbeat persisted", async () => {
    const counter = countFullLoadQueries();
    let res: Awaited<ReturnType<typeof apiRequest>>;
    try {
      res = await apiRequest("/api/v1/licenses/validate", {
        method: "POST",
        body: {
          license_key: rawKeyV2,
          product_code: productCode,
          installation_id: INSTALLATION_ID,
        },
      });
    } finally {
      const { total, fullLoad } = counter.counts();
      counter.restore();
      assert.equal(fullLoad, 0, "validate ran the combined full-state load");
      // B-01 batching: 1 batched license lookup + 1 heartbeat UPDATE.
      assert.ok(total > 0 && total <= 4, `validate took ${total} queries`);
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.valid, true);
    assert.equal(res.body.data.license_number, licenseNumber);
    assert.equal(res.body.data.license_status, "active");
    assert.equal(res.body.data.entitlement_version, 1);
    assert.equal(typeof res.body.data.entitlement_token, "string");
    assert.ok(res.body.data.entitlement_token.length > 0);
    // No full load leaked into the targeted store's state.
    assert.equal(targeted.state.licenses.length, 0);
    assert.equal(targeted.state.products.length, 0);
    // The heartbeat write landed: last_seen_at moved off the seed value.
    const row = await adminClient.query(
      `SELECT last_seen_at FROM license_activations WHERE id = $1`,
      [activationId]
    );
    assert.equal(row.rows.length, 1);
    assert.ok(
      new Date(String(row.rows[0].last_seen_at)).getTime() >
        new Date(SEED_LAST_SEEN).getTime(),
      "validate must update activation last_seen_at"
    );
  });

  it("license validate (v1 key): legacy verifier still accepted", async () => {
    const res = await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: rawKeyV1,
        product_code: productCode,
        installation_id: INSTALLATION_ID,
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.valid, true);
  });

  it("license validate: unknown key → 401 LICENSE_INVALID", async () => {
    const unknown = generateFormattedLicenseKey(productCode).rawKey;
    const res = await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: unknown,
        product_code: productCode,
        installation_id: INSTALLATION_ID,
      },
    });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "LICENSE_INVALID");
  });

  it("license validate: wrong product → 403 PRODUCT_MISMATCH; unknown installation → 403 INSTALLATION_NOT_ACTIVE", async () => {
    const wrongProduct = await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: rawKeyV2,
        product_code: "NOPE",
        installation_id: INSTALLATION_ID,
      },
    });
    assert.equal(wrongProduct.status, 403, JSON.stringify(wrongProduct.body));
    assert.equal(wrongProduct.body.error.code, "PRODUCT_MISMATCH");

    const noInstall = await apiRequest("/api/v1/licenses/validate", {
      method: "POST",
      body: {
        license_key: rawKeyV2,
        product_code: productCode,
        installation_id: "b01-never-activated",
      },
    });
    assert.equal(noInstall.status, 403, JSON.stringify(noInstall.body));
    assert.equal(noInstall.body.error.code, "INSTALLATION_NOT_ACTIVE");
  });

  it("public catalog: products list is site-scoped, cacheable, no full-state load", async () => {
    const counter = countFullLoadQueries();
    let res: Awaited<ReturnType<typeof apiRequest>>;
    try {
      res = await apiRequest(`/api/v1/public/sites/${siteKey}/products`, {
        headers: { "X-StackMate-Site-Key": siteKey },
      });
    } finally {
      const { total, fullLoad } = counter.counts();
      counter.restore();
      assert.equal(fullLoad, 0, "catalog list ran the combined full-state load");
      // B-01 batching: 1 batched site lookup + 1 batched catalog load.
      assert.ok(total > 0 && total <= 4, `catalog list took ${total} queries`);
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      res.headers.get("Cache-Control"),
      "public, max-age=60, stale-while-revalidate=15"
    );
    const slugs = (res.body.data.items as Array<{ slug: string }>).map((p) => p.slug);
    assert.deepEqual(slugs, [productSlug]);
    assert.equal(targeted.state.products.length, 0);
  });

  it("public catalog: product detail carries features + packages + prices", async () => {
    const res = await apiRequest(
      `/api/v1/public/sites/${siteKey}/products/${productSlug}`
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.slug, productSlug);
    assert.equal(res.body.data.code, productCode);
    assert.equal(res.body.data.features.length, 1);
    assert.equal(res.body.data.features[0].feature_key, "seats");
    assert.equal(res.body.data.packages.length, 1);
    const pkg = res.body.data.packages[0];
    assert.equal(pkg.package_key, "starter");
    assert.equal(pkg.package_version_id, versionId);
    assert.equal(pkg.version_number, 1);
    assert.equal(pkg.features[0].feature_key, "seats");
    assert.equal(pkg.features[0].entitlement_value, 5);
    assert.equal(pkg.prices.length, 1);
    assert.equal(pkg.prices[0].price_key, "once");
    assert.equal(pkg.prices[0].amount_minor, 250_000);
    assert.equal(pkg.prices[0].currency_code, "BDT");
  });

  it("public catalog: packages list + package-version detail", async () => {
    const list = await apiRequest(
      `/api/v1/public/sites/${siteKey}/products/${productSlug}/packages`
    );
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.items.length, 1);
    assert.equal(list.body.data.items[0].package_key, "starter");
    assert.equal(list.body.data.items[0].prices[0].amount_minor, 250_000);

    const detail = await apiRequest(
      `/api/v1/public/sites/${siteKey}/packages/${versionId}`
    );
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.package_version_id, versionId);
    assert.equal(detail.body.data.product_slug, productSlug);
    assert.equal(detail.body.data.product_code, productCode);
    assert.equal(detail.body.data.prices.length, 1);
  });

  it("public catalog: unknown site → 401, product not on site → 404, header mismatch → 403", async () => {
    const badSite = await apiRequest("/api/v1/public/sites/b01_no_such_site/products");
    assert.equal(badSite.status, 401, JSON.stringify(badSite.body));
    assert.equal(badSite.body.error.code, "UNAUTHORIZED");

    const notOnSite = await apiRequest(
      `/api/v1/public/sites/${siteKey}/products/${otherSlug}`
    );
    assert.equal(notOnSite.status, 404, JSON.stringify(notOnSite.body));
    assert.equal(notOnSite.body.error.code, "NOT_FOUND");

    const mismatch = await apiRequest(`/api/v1/public/sites/${siteKey}/products`, {
      headers: { "X-StackMate-Site-Key": "sm_site_wrongkey0000000000000000" },
    });
    assert.equal(mismatch.status, 403, JSON.stringify(mismatch.body));
    assert.equal(mismatch.body.error.code, "FORBIDDEN");
  });
});
