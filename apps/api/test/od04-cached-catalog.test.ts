/**
 * OD-04 — public catalog wired to a real HYPERDRIVE_CACHED client.
 *
 * Proves, on a createTargeted store against a scratch database:
 *  1. A catalog read through a genuinely distinct cached connection
 *     string goes through the cached client: `cachedQueries`
 *     increments exactly once per read, `uncachedQueries` does not move.
 *  2. The cached path returns data identical to the uncached path
 *     (same SQL, same mapping — only the transport differs).
 *  3. Auth / license / site reads stay NO_CACHE: they never move
 *     `cachedQueries` (only `uncachedQueries`).
 *  4. The counter is honest about fallbacks: an aliased cached string
 *     (identical to the store's own connection string — the env.ts
 *     default when HYPERDRIVE_CACHED is unconfigured), a cached
 *     string naming a DIFFERENT database, and an unreachable cached
 *     binding all fall back to the authoritative connection, counted
 *     as uncached, serving the same data.
 *  5. End to end through the HTTP route: the public catalog routes
 *     pass env.HYPERDRIVE_CACHED through, so a catalog GET moves
 *     `cachedQueries` by exactly one while the site lookup in the
 *     same request stays uncached.
 *
 * The "cached" client here is a second pg Client to the SAME local
 * database via a distinct connection string (localhost -> 127.0.0.1):
 * locally there is no Hyperdrive edge cache in front, so this proves
 * the wiring (client selection + counter), not a cache-hit latency —
 * the 60s edge-cache win only exists on staging (ADR-0005 §2).
 *
 * Runs on its own fresh database (stackmate_test_od04) via
 * setupTestDb; the shared stackmate_test database is never touched
 * and no rows are deleted from it. The scratch database is dropped
 * afterwards by the helper's cleanup, as in the other integration
 * suites.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  DATABASE_URL,
  setupTestDb,
  seedProduct,
  seedSite,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import type { StackMateDataStore } from "../src/platform/db/store.ts";
import { drainConnectionCache } from "../src/platform/db/connection-cache.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { onErrorHandler } from "../src/middleware/error-handler.ts";
import { registerPublicRoutes } from "../src/routes/public/index.ts";
import type { AppEnv } from "../src/types/context.ts";

describe("OD-04 — public catalog on a real HYPERDRIVE_CACHED client", () => {
  let seedStore: DrizzleStore;
  let targeted: DrizzleStore;
  let cleanup: () => Promise<void>;
  let dbUrl: string;
  /** Distinct connection string, SAME database (localhost -> 127.0.0.1). */
  let cachedUrl: string;
  /** Same host, DIFFERENT database name — must never be read. */
  let otherDbUrl: string;
  /** Unreachable cached binding — must fall back, not fail. */
  let deadUrl: string;
  let siteKey = "";
  let productSlug = "";
  let versionId = "";

  beforeAll(async () => {
    const setup = await setupTestDb("stackmate_test_od04");
    seedStore = setup.store;
    cleanup = setup.cleanup;
    const url = new URL(DATABASE_URL!);
    url.pathname = "/stackmate_test_od04";
    dbUrl = url.toString();
    const cached = new URL(dbUrl);
    cached.hostname = "127.0.0.1";
    cachedUrl = cached.toString();
    const otherDb = new URL(DATABASE_URL!);
    otherDb.pathname = "/stackmate_test";
    otherDbUrl = otherDb.toString();
    const dead = new URL(cachedUrl);
    dead.port = "59999";
    deadUrl = dead.toString();

    await seedStore.withTransaction((state) => {
      const product = seedProduct(state, {
        code: "OD04PROD",
        slug: "od04-product",
        name: "OD04 Product",
        status: "active",
      });
      productSlug = product.slug;
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
    });

    targeted = await DrizzleStore.createTargeted({ connectionString: dbUrl });
  }, 120_000);

  afterAll(async () => {
    try {
      await targeted.close();
    } catch {}
    try {
      await seedStore.close();
    } catch {}
    // End parked clients (main + cached) before cleanup drops the
    // scratch database — a parked backend would block DROP DATABASE.
    drainConnectionCache();
    await cleanup?.();
  });

  it("catalog via the cached client: cachedQueries +1 per read, uncached untouched", async () => {
    const before = { ...targeted.queryMetrics };
    const catalog = await targeted.loadPublicCatalog({
      cachedConnectionString: cachedUrl,
    });
    assert.equal(catalog.products.length, 1);
    assert.equal(catalog.products[0]?.slug, "od04-product");
    assert.equal(catalog.package_versions[0]?.id, versionId);
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries + 1);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries);

    const again = await targeted.loadPublicCatalog({
      cachedConnectionString: cachedUrl,
    });
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries + 2);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries);
    assert.deepEqual(again, catalog);
  });

  it("cached path returns data identical to the uncached path", async () => {
    const viaCached = await targeted.loadPublicCatalog({
      cachedConnectionString: cachedUrl,
    });
    const before = { ...targeted.queryMetrics };
    const viaUncached = await targeted.loadPublicCatalog();
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries + 1);
    assert.deepEqual(viaCached, viaUncached);
  });

  it("auth / license / site reads stay NO_CACHE (cachedQueries never moves)", async () => {
    const before = { ...targeted.queryMetrics };
    assert.equal(await targeted.findUserByEmail("nobody@example.com"), null);
    assert.equal(
      await targeted.findLicenseForValidation("0".repeat(64)),
      null
    );
    assert.equal(await targeted.findIntegratedSiteByKey("no-such-site"), null);
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries + 3);
  });

  it("aliased cached string (== store connection) falls back to uncached", async () => {
    const before = { ...targeted.queryMetrics };
    const catalog = await targeted.loadPublicCatalog({
      cachedConnectionString: dbUrl,
    });
    assert.equal(catalog.products.length, 1);
    assert.equal(catalog.products[0]?.slug, "od04-product");
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries + 1);
  });

  it("cached string naming a different database falls back to uncached (no cross-DB read)", async () => {
    const before = { ...targeted.queryMetrics };
    const catalog = await targeted.loadPublicCatalog({
      cachedConnectionString: otherDbUrl,
    });
    // Still THIS database's catalog — never the other database's rows.
    assert.equal(catalog.products.length, 1);
    assert.equal(catalog.products[0]?.slug, "od04-product");
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries + 1);
  });

  it("unreachable cached binding falls back to uncached instead of failing", async () => {
    const before = { ...targeted.queryMetrics };
    const catalog = await targeted.loadPublicCatalog({
      cachedConnectionString: deadUrl,
    });
    assert.equal(catalog.products.length, 1);
    assert.equal(catalog.products[0]?.slug, "od04-product");
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries + 1);
  });

  it("HTTP: public catalog routes pass HYPERDRIVE_CACHED through; site lookup stays uncached", async () => {
    const env = {
      ...resolveRuntimeConfig({ APP_ENV: "test" }),
      HYPERDRIVE_CACHED: { connectionString: cachedUrl },
    };
    const app = new Hono<AppEnv>();
    app.onError(onErrorHandler);
    app.use("*", async (c, next) => {
      c.set("store", targeted as StackMateDataStore);
      c.set("env", env);
      c.set("requestId", `req_od04_${randomUUID().slice(0, 8)}`);
      c.set("principal", null);
      await next();
    });
    registerPublicRoutes(app);

    const get = async (path: string) => {
      const res = await app.fetch(new Request(`http://localhost:8787${path}`, { method: "GET" }), env);
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, body, headers: res.headers };
    };

    const before = { ...targeted.queryMetrics };
    const list = await get(`/api/v1/public/sites/${siteKey}/products`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    // One cached catalog read + one uncached site lookup.
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries + 1);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries + 1);

    const detail = await get(
      `/api/v1/public/sites/${siteKey}/products/${productSlug}`
    );
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries + 2);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries + 2);

    const version = await get(
      `/api/v1/public/sites/${siteKey}/packages/${versionId}`
    );
    assert.equal(version.status, 200, JSON.stringify(version.body));
    assert.equal(targeted.queryMetrics.cachedQueries, before.cachedQueries + 3);
    assert.equal(targeted.queryMetrics.uncachedQueries, before.uncachedQueries + 3);
  });
});
