/**
 * B-01 query batching — batched targeted reads (2026-11-26).
 *
 * Proves the batched implementations return EXACTLY the same shapes as
 * the old per-table reads, while issuing exactly ONE pg query each:
 *  - DrizzleStore.findLicenseForValidation (was 1 + 5 serialized
 *    lookups: license, snapshots, snapshot items, activations, product
 *    code, subscription status)
 *  - DrizzleStore.loadPublicCatalog (was 7: channels, products,
 *    features, packages, versions, version grants, prices)
 *  - DrizzleStore.findIntegratedSiteByKey (was 1 + 2: site, site
 *    products, site domains)
 *
 * Expected values are built from the seed inputs (fixed literals where
 * ordering matters), NOT by re-running the old queries — so a mapping
 * regression fails here even though the old code is gone.
 *
 * Runs on its own fresh database (stackmate_test_b01batched) via
 * setupTestDb; the shared stackmate_test database is never touched.
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
  seedSubscription,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import type { StackMateDataStore } from "../src/platform/db/store.ts";
import { authContext } from "../src/middleware/auth.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import type { AppEnv } from "../src/types/context.ts";

/** Count pg queries while installed; reset() zeroes the counter. */
function installCounter() {
  let total = 0;
  const orig = Client.prototype.query as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]) {
    total += 1;
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
  Client.prototype.query = patched as never;
  return {
    reset: () => {
      total = 0;
    },
    count: () => total,
    restore: () => {
      Client.prototype.query = orig as never;
    },
  };
}

describe("B-01 batched targeted reads", () => {
  let targeted: DrizzleStore;
  let adminClient: Client;
  let cleanup: () => Promise<void>;
  let dbUrl = "";

  const L1_HASH = "b01bat-hash-L1";
  const L2_HASH = "b01bat-hash-L2";
  const L2_NUMBER = "LIC-B01BAT-L2";

  // Seeded rows (held for expected-value construction).
  let license1: ReturnType<typeof seedLicense>;
  let license1Number = "";
  let license1CreatedAt = "";
  let license1SubscriptionId = "";
  let product1Id = "";
  let product2Id = "";
  let siteKey = "";
  let siteId = "";
  const domain1Id = randomUUID();
  const domain2Id = randomUUID();

  beforeAll(async () => {
    const setup = await setupTestDb("stackmate_test_b01batched");
    const seedStore = setup.store;
    adminClient = setup.adminClient;
    cleanup = setup.cleanup;
    const url = new URL(DATABASE_URL!);
    url.pathname = "/stackmate_test_b01batched";
    dbUrl = url.toString();

    targeted = await DrizzleStore.createTargeted({ connectionString: dbUrl });

    // Empty-database edge case first: no rows anywhere, still exactly
    // one query, all arrays empty.
    {
      const counter = installCounter();
      try {
        counter.reset();
        const empty = await targeted.loadPublicCatalog();
        assert.equal(counter.count(), 1, "empty catalog must take 1 query");
        assert.deepEqual(empty, {
          products: [],
          product_features: [],
          product_packages: [],
          package_versions: [],
          package_prices: [],
        });
        counter.reset();
        assert.equal(
          await targeted.findLicenseForValidation("b01bat-no-such-hash"),
          null
        );
        assert.equal(counter.count(), 1, "unknown hash must take 1 query");
        counter.reset();
        assert.equal(await targeted.findIntegratedSiteByKey("b01bat-no-site"), null);
        assert.equal(counter.count(), 1, "unknown site must take 1 query");
      } finally {
        counter.restore();
      }
    }

    await seedStore.withTransaction((state) => {
      const customer = seedCustomer(state, { email: "b01batched@example.com" });

      const p1 = seedProduct(state, {
        code: "B01BAT-P1",
        slug: "b01bat-p1",
        name: "B01 Batched P1",
        status: "active",
        distribution_channels: ["wordpress", "api"],
        created_at: "2026-11-20T10:00:00.000Z",
        updated_at: "2026-11-20T10:00:00.000Z",
      });
      product1Id = p1.id;
      const p2 = seedProduct(state, {
        code: "B01BAT-P2",
        slug: "b01bat-p2",
        name: "B01 Batched P2",
        status: "active",
        distribution_channels: [],
        created_at: "2026-11-20T10:05:00.000Z",
        updated_at: "2026-11-20T10:05:00.000Z",
      });
      product2Id = p2.id;
      // Draft product: the catalog's products query filters it out, but
      // the features query has no product filter — its feature still loads.
      const p3 = seedProduct(state, {
        code: "B01BAT-P3",
        slug: "b01bat-p3",
        name: "B01 Batched P3",
        status: "draft",
        distribution_channels: [],
        created_at: "2026-11-20T10:06:00.000Z",
        updated_at: "2026-11-20T10:06:00.000Z",
      });

      const f1 = randomUUID();
      const f2 = randomUUID();
      const f3 = randomUUID();
      const f4 = randomUUID();
      state.product_features.push(
        {
          id: f1,
          product_id: p1.id,
          feature_key: "seats",
          name: "Seats",
          description: "Seat limit",
          value_type: "limit",
          unit: "seats",
          default_value: 3,
          status: "active",
          created_at: "2026-11-20T10:00:00.000Z",
          updated_at: "2026-11-20T10:00:00.000Z",
        },
        {
          id: f2,
          product_id: p1.id,
          feature_key: "sso",
          name: "SSO",
          description: null,
          value_type: "boolean",
          unit: null,
          default_value: false,
          status: "active",
          created_at: "2026-11-20T10:01:00.000Z",
          updated_at: "2026-11-20T10:01:00.000Z",
        },
        {
          id: f3,
          product_id: p2.id,
          feature_key: "seats",
          name: "Seats",
          description: null,
          value_type: "limit",
          unit: "seats",
          default_value: 1,
          status: "active",
          created_at: "2026-11-20T10:02:00.000Z",
          updated_at: "2026-11-20T10:02:00.000Z",
        },
        {
          id: f4,
          product_id: p3.id,
          feature_key: "seats",
          name: "Seats",
          description: null,
          value_type: "limit",
          unit: "seats",
          default_value: 1,
          status: "active",
          created_at: "2026-11-20T10:03:00.000Z",
          updated_at: "2026-11-20T10:03:00.000Z",
        }
      );

      const pkg1 = randomUUID();
      const pkg2 = randomUUID();
      const v1 = randomUUID();
      const v2 = randomUUID();
      const v3 = randomUUID();
      state.product_packages.push(
        {
          id: pkg1,
          product_id: p1.id,
          package_key: "starter",
          name: "Starter",
          description: "Starter package",
          status: "active",
          current_version_id: v1,
          created_at: "2026-11-20T10:00:00.000Z",
          updated_at: "2026-11-20T10:00:00.000Z",
        },
        {
          id: pkg2,
          product_id: p1.id,
          package_key: "pro",
          name: "Pro",
          description: null,
          status: "active",
          current_version_id: v2,
          created_at: "2026-11-20T10:05:00.000Z",
          updated_at: "2026-11-20T10:05:00.000Z",
        },
        {
          id: randomUUID(),
          product_id: p1.id,
          package_key: "hidden",
          name: "Hidden",
          description: null,
          status: "draft",
          current_version_id: null,
          created_at: "2026-11-20T10:06:00.000Z",
          updated_at: "2026-11-20T10:06:00.000Z",
        }
      );
      state.package_versions.push(
        {
          id: v1,
          package_id: pkg1,
          product_id: p1.id,
          version_number: 1,
          status: "published",
          change_summary: null,
          // Inserted out of key order on purpose: the read must return
          // grants ordered by feature_key_snapshot (seats before sso).
          features: [
            {
              id: randomUUID(),
              package_version_id: v1,
              product_id: p1.id,
              product_feature_id: f2,
              feature_key_snapshot: "sso",
              value_type_snapshot: "boolean",
              entitlement_value: true,
              unit_snapshot: null,
            },
            {
              id: randomUUID(),
              package_version_id: v1,
              product_id: p1.id,
              product_feature_id: f1,
              feature_key_snapshot: "seats",
              value_type_snapshot: "limit",
              entitlement_value: 5,
              unit_snapshot: "seats",
            },
          ],
          published_at: "2026-11-20T10:00:00.000Z",
          created_at: "2026-11-20T10:00:00.000Z",
        },
        {
          id: v2,
          package_id: pkg2,
          product_id: p1.id,
          version_number: 1,
          status: "published",
          change_summary: null,
          features: [],
          published_at: "2026-11-20T10:05:00.000Z",
          created_at: "2026-11-20T10:05:00.000Z",
        },
        {
          id: v3,
          package_id: pkg1,
          product_id: p1.id,
          version_number: 2,
          status: "draft",
          change_summary: null,
          features: [],
          published_at: null,
          created_at: "2026-11-20T10:07:00.000Z",
        }
      );
      state.package_prices.push(
        {
          id: randomUUID(),
          package_version_id: v1,
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
          created_at: "2026-11-20T10:00:00.000Z",
        },
        {
          id: randomUUID(),
          package_version_id: v1,
          price_key: "old",
          price_kind: "one_time",
          amount_minor: 100_000,
          currency_code: "BDT",
          interval_unit: null,
          interval_count: null,
          trial_days: 0,
          setup_fee_minor: 0,
          status: "inactive",
          used_in_orders: false,
          created_at: "2026-11-20T10:01:00.000Z",
        },
        {
          id: randomUUID(),
          package_version_id: v2,
          price_key: "monthly",
          price_kind: "recurring",
          amount_minor: 99_000,
          currency_code: "BDT",
          interval_unit: "month",
          interval_count: 1,
          trial_days: 7,
          setup_fee_minor: 5000,
          status: "active",
          used_in_orders: false,
          created_at: "2026-11-20T10:05:00.000Z",
        }
      );

      const site = seedSite(state);
      site.product_ids = [p1.id, p2.id];
      // Domains are inserted by raw SQL below with explicit created_at
      // literals: the state domain shape carries no created_at, and the
      // read orders by created_at ASC — same-ms defaultNow() values
      // would make the order random. d2 is created earlier than d1.
      siteKey = site.site_key;
      siteId = site.id;

      const sub = seedSubscription(state, {
        customer_id: customer.id,
        product_id: p1.id,
        status: "cancelled",
      });

      license1 = seedLicense(state, {
        product_id: p1.id,
        customer_id: customer.id,
        subscription_id: sub.id,
        license_key_hash: L1_HASH,
        valid_from: "2026-11-20T00:00:00.000Z",
      });
      license1Number = license1.license_number;
      license1CreatedAt = license1.created_at;
      license1SubscriptionId = license1.subscription_id ?? "";
      const snap1 = randomUUID();
      const snap2 = randomUUID();
      license1.current_entitlement_snapshot_id = snap1;
      license1.snapshots = [
        {
          id: snap1,
          license_id: license1.id,
          version_number: 1,
          source_type: "manual_grant",
          effective_at: "2026-11-20T10:00:00.000Z",
          reason: null,
          snapshot_hash: "b01bat-snaphash-1",
          // Inserted out of key order: read must order by
          // feature_key_snapshot (alpha before zebra).
          items: [
            {
              feature_key_snapshot: "zebra",
              value_type_snapshot: "limit",
              entitlement_value: 7,
              unit_snapshot: "seats",
            },
            {
              feature_key_snapshot: "alpha",
              value_type_snapshot: "boolean",
              entitlement_value: true,
              unit_snapshot: null,
            },
          ],
          created_by_user_id: null,
          created_at: "2026-11-20T10:00:00.000Z",
        },
        {
          id: snap2,
          license_id: license1.id,
          version_number: 2,
          source_type: "order_item",
          effective_at: "2026-11-21T10:00:00.000Z",
          reason: "upgrade",
          snapshot_hash: "b01bat-snaphash-2",
          items: [],
          created_by_user_id: null,
          created_at: "2026-11-21T10:00:00.000Z",
        },
      ];
      // a2 pushed first but activated earlier: read must order by
      // activated_at ASC. a2's last_seen_at is nulled by raw SQL after
      // persist (see below), so the read must fall back to activated_at
      // (same rule as the old mapping).
      license1.activations = [
        {
          id: randomUUID(),
          license_id: license1.id,
          installation_id_hash: "b01bat-install-b",
          domain_normalized: "example.com",
          environment: "production",
          status: "deactivated",
          activated_at: "2026-11-21T08:00:00.000Z",
          last_seen_at: "2026-11-21T09:00:00.000Z",
          deactivated_at: "2026-11-23T08:00:00.000Z",
          metadata: {},
          created_at: "2026-11-21T08:00:00.000Z",
        },
        {
          id: randomUUID(),
          license_id: license1.id,
          installation_id_hash: "b01bat-install-a",
          domain_normalized: null,
          environment: "staging",
          status: "active",
          activated_at: "2026-11-22T08:00:00.000Z",
          last_seen_at: "2026-11-22T09:00:00.000Z",
          deactivated_at: null,
          metadata: { device: "laptop" },
          created_at: "2026-11-22T08:00:00.000Z",
        },
      ];
    });

    // The state type requires last_seen_at: string, so the NULL case
    // is arranged here: a2's stored last_seen is nulled after persist,
    // and the read must fall back to activated_at.
    await adminClient.query(
      `UPDATE license_activations SET last_seen_at = NULL WHERE installation_id_hash = 'b01bat-install-b'`
    );

    // Site domains with explicit created_at (see note at the seed site).
    await adminClient.query(
      `INSERT INTO site_domains (id, integrated_site_id, domain,
          verification_method, verification_challenge,
          verification_status, verified_at, is_primary, created_at)
       VALUES ($1, $2, 'example.com', 'dns_txt', 'b01bat-challenge-1',
          'verified', '2026-11-20T11:00:00.000Z', true,
          '2026-11-20T11:00:00.000Z'),
         ($3, $2, 'shop.example.com', 'http_file', 'b01bat-challenge-2',
          'pending', NULL, false, '2026-11-20T10:30:00.000Z')`,
      [domain1Id, siteId, domain2Id]
    );

    // License with NO snapshots, NO activations, NULL subscription and
    // NULL issued_at — raw INSERT because seedLicense always creates
    // one snapshot. Exercises the empty-array + null fallbacks.
    const cust = await adminClient.query(`SELECT id FROM customers LIMIT 1`);
    const customerId = String(cust.rows[0].id);
    await adminClient.query(
      `INSERT INTO licenses (id, license_number, product_id, customer_id,
          source_order_item_id, subscription_id, license_key_hash,
          license_key_hint, status, activation_limit, valid_from,
          expires_at, grace_until, current_entitlement_snapshot_id,
          issued_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, 'L2-****', 'active', 1,
          '2026-11-20T00:00:00.000Z', NULL, NULL, NULL, NULL,
          '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`,
      [randomUUID(), L2_NUMBER, product2Id, customerId, L2_HASH]
    );
  }, 120_000);

  afterAll(async () => {
    try {
      await targeted.close();
    } catch {}
    await cleanup?.();
  });

  it("findLicenseForValidation: 1 query, full shape + ordering + subscription status", async () => {
    const counter = installCounter();
    let found: Awaited<ReturnType<typeof targeted.findLicenseForValidation>>;
    try {
      counter.reset();
      found = await targeted.findLicenseForValidation(L1_HASH);
    } finally {
      const n = counter.count();
      counter.restore();
      assert.equal(n, 1, `findLicenseForValidation took ${n} queries, want 1`);
    }
    assert.ok(found);
    assert.equal(found.productCode, "B01BAT-P1");
    assert.equal(found.subscriptionStatus, "cancelled");
    const lic = found.license;
    assert.equal(lic.license_number, license1Number);
    assert.equal(lic.status, "active");
    assert.equal(lic.subscription_id, license1SubscriptionId);
    assert.equal(lic.valid_from, "2026-11-20T00:00:00.000Z");
    assert.equal(lic.current_entitlement_snapshot_id, lic.snapshots[0]!.id);
    assert.equal(lic.created_at, license1CreatedAt);
    // Snapshots ordered by version_number; items by feature_key_snapshot.
    assert.deepEqual(
      lic.snapshots.map((s) => s.version_number),
      [1, 2]
    );
    assert.deepEqual(
      lic.snapshots[0]!.items.map((i) => i.feature_key_snapshot),
      ["alpha", "zebra"]
    );
    assert.deepEqual(lic.snapshots[0]!.items, [
      {
        feature_key_snapshot: "alpha",
        value_type_snapshot: "boolean",
        entitlement_value: true,
        unit_snapshot: null,
      },
      {
        feature_key_snapshot: "zebra",
        value_type_snapshot: "limit",
        entitlement_value: 7,
        unit_snapshot: "seats",
      },
    ]);
    assert.equal(lic.snapshots[1]!.source_type, "order_item");
    assert.equal(lic.snapshots[1]!.reason, "upgrade");
    assert.deepEqual(lic.snapshots[1]!.items, []);
    // Activations ordered by activated_at; null last_seen falls back.
    assert.deepEqual(
      lic.activations.map((a) => a.installation_id_hash),
      ["b01bat-install-b", "b01bat-install-a"]
    );
    assert.equal(lic.activations[0]!.status, "deactivated");
    assert.equal(lic.activations[0]!.last_seen_at, "2026-11-21T08:00:00.000Z");
    assert.equal(lic.activations[0]!.deactivated_at, "2026-11-23T08:00:00.000Z");
    assert.equal(lic.activations[1]!.last_seen_at, "2026-11-22T09:00:00.000Z");
    assert.deepEqual(lic.activations[1]!.metadata, { device: "laptop" });
  });

  it("findLicenseForValidation: no snapshots/activations/subscription → empty arrays + nulls", async () => {
    const counter = installCounter();
    let found: Awaited<ReturnType<typeof targeted.findLicenseForValidation>>;
    try {
      counter.reset();
      found = await targeted.findLicenseForValidation(L2_HASH);
    } finally {
      const n = counter.count();
      counter.restore();
      assert.equal(n, 1, `findLicenseForValidation took ${n} queries, want 1`);
    }
    assert.ok(found);
    assert.equal(found.license.license_number, L2_NUMBER);
    assert.equal(found.productCode, "B01BAT-P2");
    assert.equal(found.subscriptionStatus, null);
    assert.deepEqual(found.license.snapshots, []);
    assert.deepEqual(found.license.activations, []);
    assert.equal(found.license.current_entitlement_snapshot_id, "");
    // NULL issued_at falls back to created_at.
    assert.equal(found.license.issued_at, "2026-11-20T00:00:00.000Z");
  });

  it("loadPublicCatalog: 1 query, filters + ordering exact", async () => {
    const counter = installCounter();
    let catalog: Awaited<ReturnType<typeof targeted.loadPublicCatalog>>;
    try {
      counter.reset();
      catalog = await targeted.loadPublicCatalog();
    } finally {
      const n = counter.count();
      counter.restore();
      assert.equal(n, 1, `loadPublicCatalog took ${n} queries, want 1`);
    }
    // Draft product excluded; channels attached to the right product
    // (channel order is unspecified — compare as a set).
    assert.deepEqual(
      catalog.products.map((p) => p.code),
      ["B01BAT-P1", "B01BAT-P2"]
    );
    assert.deepEqual([...catalog.products[0]!.distribution_channels].sort(), [
      "api",
      "wordpress",
    ]);
    assert.deepEqual(catalog.products[1]!.distribution_channels, []);
    assert.equal(catalog.products[0]!.default_activation_limit, 3);
    assert.equal(catalog.products[0]!.offline_grace_hours, 72);
    // Features: NO product filter (draft product's feature still loads).
    assert.equal(catalog.product_features.length, 4);
    assert.deepEqual(
      catalog.product_features.map((f) => f.feature_key),
      ["seats", "sso", "seats", "seats"]
    );
    // Draft package excluded; current_version_id carried.
    assert.deepEqual(
      catalog.product_packages.map((p) => p.package_key),
      ["starter", "pro"]
    );
    // Draft version excluded; grants ordered; empty-grant version kept.
    assert.deepEqual(
      catalog.package_versions.map((v) => v.version_number),
      [1, 1]
    );
    assert.deepEqual(
      catalog.package_versions[0]!.features.map((g) => g.feature_key_snapshot),
      ["seats", "sso"]
    );
    assert.equal(catalog.package_versions[0]!.features[0]!.entitlement_value, 5);
    assert.equal(catalog.package_versions[0]!.features[1]!.entitlement_value, true);
    assert.deepEqual(catalog.package_versions[1]!.features, []);
    // Inactive price excluded.
    assert.deepEqual(
      catalog.package_prices.map((p) => p.price_key),
      ["once", "monthly"]
    );
    assert.equal(catalog.package_prices[1]!.price_kind, "recurring");
    assert.equal(catalog.package_prices[1]!.interval_unit, "month");
    assert.equal(catalog.package_prices[1]!.trial_days, 7);
    assert.equal(catalog.package_prices[1]!.setup_fee_minor, 5000);
  });

  it("findIntegratedSiteByKey: 1 query, site + product ids + ordered domains", async () => {
    const counter = installCounter();
    let site: Awaited<ReturnType<typeof targeted.findIntegratedSiteByKey>>;
    try {
      counter.reset();
      site = await targeted.findIntegratedSiteByKey(siteKey);
    } finally {
      const n = counter.count();
      counter.restore();
      assert.equal(n, 1, `findIntegratedSiteByKey took ${n} queries, want 1`);
    }
    assert.ok(site);
    assert.equal(site.id, siteId);
    assert.equal(site.name, "Test Site");
    assert.equal(site.status, "active");
    assert.deepEqual(site.allowed_capabilities, [
      "leads.create",
      "checkout.create",
      "tracking.events.write",
    ]);
    // product_ids order is unspecified (old query had no ORDER BY) —
    // compare as a set.
    assert.deepEqual([...site.product_ids].sort(), [product1Id, product2Id].sort());
    // Domains ordered by created_at ASC (shop.example.com first).
    assert.deepEqual(
      site.domains.map((d) => d.domain),
      ["shop.example.com", "example.com"]
    );
    assert.equal(site.domains[0]!.verification_status, "pending");
    assert.equal(site.domains[0]!.verified_at, null);
    assert.equal(site.domains[0]!.is_primary, false);
    assert.equal(site.domains[1]!.verification_status, "verified");
    assert.equal(site.domains[1]!.verified_at, "2026-11-20T11:00:00.000Z");
    assert.equal(site.domains[1]!.is_primary, true);
  });

  it("authContext gate: no Cookie/Authorization → zero pg queries; unrelated cookie → builds auth", async () => {
    // The auth-config cache key carries a `?b01gate=1` marker so
    // loadAuthConfig starts cold here — otherwise a warm 30s cache
    // would hide the queries the gate is meant to skip.
    const probeEnv = {
      ...resolveRuntimeConfig({ APP_ENV: "test" }),
      HYPERDRIVE_NO_CACHE: { connectionString: `${dbUrl}?b01gate=1` },
    };
    const probe = new Hono<AppEnv>();
    probe.use("*", async (c, next) => {
      c.set("store", targeted as StackMateDataStore);
      c.set("env", probeEnv);
      await next();
    });
    probe.use(authContext(async () => targeted as StackMateDataStore));
    probe.get("/probe", (c) => c.json({ principal: c.var.principal }));

    const counter = installCounter();
    try {
      // No credential headers at all: the gate skips buildBetterAuth,
      // so nothing touches the database.
      counter.reset();
      const bare = await probe.fetch(
        new Request("http://localhost:8787/probe"),
        probeEnv
      );
      const bareText = await bare.text();
      assert.equal(bare.status, 200, bareText);
      assert.deepEqual(JSON.parse(bareText), { principal: null });
      assert.equal(counter.count(), 0, "credential-less authContext queried the DB");

      // An unrelated cookie still builds Better Auth (conservative
      // gate): loadAuthConfig runs its selects on a cold cache.
      counter.reset();
      const withCookie = await probe.fetch(
        new Request("http://localhost:8787/probe", {
          headers: { Cookie: "foo=bar" },
        }),
        probeEnv
      );
      const cookieText = await withCookie.text();
      assert.equal(withCookie.status, 200, cookieText);
      assert.deepEqual(JSON.parse(cookieText), { principal: null });
      assert.ok(
        counter.count() >= 1,
        "cookie-carrying authContext should have built Better Auth (loadAuthConfig)"
      );
    } finally {
      counter.restore();
    }
  });
});
