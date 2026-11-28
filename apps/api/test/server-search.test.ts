/**
 * Server-side search (PLAN §29 / ADR-0010).
 *
 * Owner hard rule: no search anywhere may miss a result because it sits
 * beyond some loaded amount — searching "abc" must find it even if it is
 * #500+ in the list. These tests prove the server `?q=` filter runs over
 * the FULL dataset: 60 seeded rows, the query names the 55th, and the
 * response contains exactly that row. Pre-fix there was no `q` param on
 * these endpoints, so the same queries return the whole unfiltered list
 * and the assertions fail.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_server_search`, dropped afterwards. HTTP-level tests
 * (full dispatcher + real Better Auth sign-in, same pattern as
 * live-retest-defects.test.ts); permission gating of the global search
 * is proved at the service level with a limited principal.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  seedCustomer,
  seedLicense,
  seedOrder,
  seedProduct,
  seedSubscription,
} from "./customer-order-helpers.ts";
import { searchGlobal } from "../src/modules/search/service.ts";
import type { StaffPrincipal } from "../src/modules/identity/service.ts";

const DB_NAME = "stackmate_test_server_search";
const API_BASE = "http://localhost:8787";
const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN = "test-setup-token-that-is-long-enough-0123456789";

const pad2 = (n: number): string => String(n).padStart(2, "0");

describe.skipIf(!DATABASE_URL)(
  "server-side search — q over the full dataset, global search groups",
  () => {
    let envStaging: import("../src/env.ts").StackMateBindings;
    let app: import("../src/app.ts").StackMateAppInstance;
    let store: import("../src/platform/db/drizzle-store.ts").DrizzleStore;
    let adminClient: Client;
    let sessionCookie = "";

    async function apiRequest(
      path: string,
      options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {},
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

    const dataOf = (res: { body: any }) => res.body.data;
    const itemsOf = (res: { body: any }) => res.body.data.items as any[];

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
        await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
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
          name: "Search Test Admin",
          email: "search-test@example.com",
          password: "SuperAdminPass123!",
          setupToken: TEST_SETUP_TOKEN,
        },
      });
      assert.equal(boot.status, 201, JSON.stringify(boot.body));
      const signedIn = await apiRequest("/api/auth/sign-in", {
        method: "POST",
        body: { email: "search-test@example.com", password: "SuperAdminPass123!" },
      });
      assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
      sessionCookie = cookiePairs(signedIn.headers);
      assert.ok(sessionCookie.length > 0, "sign-in must set a session cookie");

      // Seed 60 of each entity in ONE transaction each — the 55th row is
      // the probe: it sits beyond any first page a client would load.
      await store.withTransaction((state) => {
        const customer = seedCustomer(state, {
          name: "SearchProbe Base Customer",
          email: "base-probe@example.com",
          phone: "01700000000",
          normalized_phone: "01700000000",
        });
        const product = seedProduct(state, {
          name: "SearchProbe Base Product",
          code: "SEARCH-PROBE-BASE",
        });
        for (let i = 1; i <= 60; i++) {
          const n = pad2(i);
          seedCustomer(state, {
            name: `SearchProbe Customer ${n}`,
            email: `probe${n}@example.com`,
            phone: `017100000${n}`,
            normalized_phone: `017100000${n}`,
          });
          seedProduct(state, {
            name: `SearchProbe Product ${n}`,
            code: `SEARCH-PROBE-${n}`,
          });
          seedOrder(state, customer.id, product, {
            order_number: `ORD-PROBE-${n}`,
            public_reference: `ord_probe_${n}`,
          });
        }
        seedLicense(state, {
          product_id: product.id,
          customer_id: customer.id,
          license_number: "LIC-PROBE-055",
        });
        seedSubscription(state, {
          product_id: product.id,
          customer_id: customer.id,
          subscription_number: "SUB-PROBE-055",
        });
      });
    }, 180_000);

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

    it("customers q finds the 55th customer by name (beyond any first page)", async () => {
      const res = await authed(
        "/api/v1/admin/customers?q=" + encodeURIComponent("probe customer 55"),
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const items = itemsOf(res);
      assert.equal(items.length, 1, `expected exactly 1 match, got ${items.length}`);
      assert.equal(items[0].name, "SearchProbe Customer 55");
    });

    it("customers q finds the 55th customer by phone fragment", async () => {
      const res = await authed("/api/v1/admin/customers?q=01710000055");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const items = itemsOf(res);
      assert.equal(items.length, 1, `expected exactly 1 match, got ${items.length}`);
      assert.equal(items[0].name, "SearchProbe Customer 55");
    });

    it("customers without q: page 1 holds 25 of 61 (total), pages walk to all 61", async () => {
      // M-1: lists are server-paged (default limit 25) — no hidden cap,
      // but no single page returns everything either. The total is
      // pre-limit; walking pages 1-3 collects all 61 rows.
      const seen = new Set<string>();
      for (const page of [1, 2, 3]) {
        const res = await authed(`/api/v1/admin/customers?page=${page}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.total, 61, JSON.stringify(res.body.data));
        for (const item of itemsOf(res)) seen.add(item.id as string);
      }
      assert.equal(seen.size, 61);
      const first = await authed("/api/v1/admin/customers");
      assert.equal(itemsOf(first).length, 25);
    });

    it("customers q + limit caps AFTER filtering, not before", async () => {
      const res = await authed("/api/v1/admin/customers?q=probe%20customer&limit=2");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(itemsOf(res).length, 2);
    });

    it("products q finds the 55th product by code", async () => {
      const res = await authed("/api/v1/admin/products?q=search-probe-55");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const items = itemsOf(res);
      assert.equal(items.length, 1, `expected exactly 1 match, got ${items.length}`);
      assert.equal(items[0].name, "SearchProbe Product 55");
    });

    it("orders q finds the 55th order by order number", async () => {
      const res = await authed("/api/v1/admin/orders?q=ord-probe-55");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const items = itemsOf(res);
      assert.equal(items.length, 1, `expected exactly 1 match, got ${items.length}`);
      assert.equal(items[0].order_number, "ORD-PROBE-55");
    });

    it("licenses q finds a license by number", async () => {
      const res = await authed("/api/v1/admin/licenses?q=lic-probe-055");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const items = itemsOf(res);
      assert.equal(items.length, 1, `expected exactly 1 match, got ${items.length}`);
      assert.equal(items[0].license_number, "LIC-PROBE-055");
    });

    it("subscriptions q finds a subscription by number", async () => {
      const res = await authed("/api/v1/admin/subscriptions?q=sub-probe-055");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const items = itemsOf(res);
      assert.equal(items.length, 1, `expected exactly 1 match, got ${items.length}`);
      assert.equal(items[0].subscription_number, "SUB-PROBE-055");
    });

    it("global search returns grouped results with detail routes", async () => {
      const res = await authed("/api/v1/admin/search?q=probe%20customer%2055");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = dataOf(res);
      assert.equal(data.query, "probe customer 55");
      const customers = data.groups.find((g: any) => g.key === "customers");
      assert.ok(customers, "customers group must be present");
      assert.equal(customers.items.length, 1);
      assert.equal(customers.items[0].label, "SearchProbe Customer 55");
      assert.equal(customers.items[0].to, `/customers/${customers.items[0].id}`);
      for (const group of data.groups) {
        assert.ok(
          group.items.length <= 8,
          `group ${group.key} exceeds the 8-per-group cap`,
        );
      }
    });

    it("global search staff item carries email + role as separate widget fields", async () => {
      const res = await authed("/api/v1/admin/search?q=search%20test");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = dataOf(res);
      const staff = data.groups.find((g: any) => g.key === "staff");
      assert.ok(staff, "staff group must be present");
      const item = staff.items.find((i: any) => i.label === "Search Test Admin");
      assert.ok(item, "bootstrapped admin must be in the staff group");
      assert.equal(item.sublabel, "search-test@example.com");
      assert.equal(item.badge, "Super Admin");
      assert.equal(item.to, `/staff/${item.id}`);
    });

    it("global search returns empty groups for a 1-char query and for no match", async () => {
      const short = await authed("/api/v1/admin/search?q=a");
      assert.equal(short.status, 200, JSON.stringify(short.body));
      assert.deepEqual(dataOf(short).groups, []);
      const nomatch = await authed("/api/v1/admin/search?q=zzz-no-such-record");
      assert.equal(nomatch.status, 200, JSON.stringify(nomatch.body));
      assert.deepEqual(dataOf(nomatch).groups, []);
    });

    it("global search requires a staff session", async () => {
      const res = await apiRequest("/api/v1/admin/search?q=probe");
      assert.equal(res.status, 401, JSON.stringify(res.body));
    });

    it("searchGlobal gates groups by permission (service level)", () => {
      const limited: StaffPrincipal = {
        ...SUPER_ACTOR,
        roles: ["admin"],
        permissions: ["customers.read"],
      };
      const groups = searchGlobal(store.state, limited, "probe customer 55");
      assert.deepEqual(
        groups.map((g) => g.key),
        ["customers"],
        "a customers-only principal sees only the customers group",
      );
      const all = searchGlobal(store.state, SUPER_ACTOR, "probe customer 55");
      assert.ok(
        all.some((g) => g.key === "customers"),
        "super admin sees the customers group",
      );
      assert.deepEqual(searchGlobal(store.state, limited, "x"), []);
    });
  },
);
