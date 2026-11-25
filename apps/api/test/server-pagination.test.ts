/**
 * Server offset pagination tests (audit fix-all follow-up, 2026-11-19).
 *
 * The API-core batch added `parseListQuery` (limit defaults to 25) and
 * `pagedCollectionResponse` (pre-limit `data.total`), but no `?page=`
 * support — the SPA could only fetch a `?limit=100` window, so rows
 * past 100 were unreachable by browsing. This file proves the offset
 * fix: `?page=` slices the (page-1)*limit window AFTER filtering,
 * `total` stays the full filtered count, and every endpoint that
 * already used `pagedCollectionResponse` gains it (products here,
 * customers as the second witness).
 *
 * In-memory store only (no Postgres needed). Fixtures are seeded
 * directly into the store — the list handlers only read the fields
 * below, and the API-created fixtures in api-core-batch.test.ts
 * already cover the create path.
 */
import { describe, it, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";

const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Server offset pagination (?page=)", () => {
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let superCookie = "";

  async function apiRequest(
    path: string,
    options: { cookie?: string } = {},
  ): Promise<{ status: number; body: any }> {
    const headers = new Headers();
    if (options.cookie) headers.set("Cookie", options.cookie);
    const res = await app.fetch(
      new Request(`http://localhost:8787${path}`, { method: "GET", headers }),
      env,
    );
    return { status: res.status, body: JSON.parse(await res.text()) };
  }

  async function list(path: string) {
    const res = await apiRequest(path, { cookie: superCookie });
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
    return res.body.data as { items: { id: string }[]; total: number };
  }

  beforeAll(async () => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    app = createStackMateApp(store);
    const bootRes = await app.fetch(
      new Request("http://localhost:8787/api/auth/bootstrap-super-admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Pagination Super Admin",
          email: "page-admin@stackmate.local",
          password: "PageSuperPass123!",
          setupToken: TEST_SETUP_TOKEN,
        }),
      }),
      env,
    );
    assert.equal(bootRes.status, 201, await bootRes.text());
    const signIn = await app.fetch(
      new Request("http://localhost:8787/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "page-admin@stackmate.local",
          password: "PageSuperPass123!",
        }),
      }),
      env,
    );
    const signInText = await signIn.text();
    assert.equal(signIn.status, 200, signInText);
    const signInBody = JSON.parse(signInText) as any;
    // A-01: the session token is cookie-only — sign-in JSON no longer
    // carries session_token, so the cookie comes from Set-Cookie.
    const setCookies =
      typeof signIn.headers.getSetCookie === "function" ? signIn.headers.getSetCookie() : [];
    const sessionPair = setCookies.find((c) => c.startsWith("stackmate_session="));
    assert.ok(sessionPair, "sign-in must set a stackmate_session cookie");
    superCookie = sessionPair!.split(";")[0]!;

    // 30 products + 30 customers, insertion order = list order.
    const now = new Date().toISOString();
    for (let i = 1; i <= 30; i++) {
      const n = String(i).padStart(2, "0");
      store.state.products.push({
        id: `pg-prod-${n}`,
        name: `Pagination Product ${n}`,
        code: `PG_PROD_${n}`,
        slug: `pg-prod-${n}`,
        product_type: "saas_application",
        status: "active",
        created_at: now,
      } as any);
      store.state.customers.push({
        id: `pg-cust-${n}`,
        name: `Pagination Customer ${n}`,
        email: `pg-customer-${n}@example.local`,
        customer_number: `PG-CUST-${n}`,
        status: "active",
        created_at: now,
      } as any);
    }
  });

  it("page 1 returns the first 25 rows and total 30", async () => {
    const data = await list("/api/v1/admin/products");
    assert.equal(data.total, 30);
    assert.equal(data.items.length, 25);
    assert.equal(data.items[0]!.id, "pg-prod-01");
    assert.equal(data.items[24]!.id, "pg-prod-25");
  });

  it("page 2 returns the remaining 5 rows, disjoint from page 1", async () => {
    const page1 = await list("/api/v1/admin/products?page=1");
    const page2 = await list("/api/v1/admin/products?page=2");
    assert.equal(page2.total, 30);
    assert.equal(page2.items.length, 5);
    assert.deepEqual(
      page2.items.map((p) => p.id),
      ["pg-prod-26", "pg-prod-27", "pg-prod-28", "pg-prod-29", "pg-prod-30"],
    );
    const page1Ids = new Set(page1.items.map((p) => p.id));
    for (const item of page2.items) assert.ok(!page1Ids.has(item.id));
  });

  it("a page beyond the total returns empty items with total unchanged", async () => {
    const data = await list("/api/v1/admin/products?page=3");
    assert.equal(data.total, 30);
    assert.deepEqual(data.items, []);
  });

  it("page composes with limit: limit=10&page=3 is rows 21-30", async () => {
    const data = await list("/api/v1/admin/products?limit=10&page=3");
    assert.equal(data.total, 30);
    assert.equal(data.items.length, 10);
    assert.equal(data.items[0]!.id, "pg-prod-21");
    assert.equal(data.items[9]!.id, "pg-prod-30");
  });

  it("page composes with q: the search filters first, then the page slices", async () => {
    // q=product 2 matches Product 20-29 (substring, 10 rows).
    const data = await list("/api/v1/admin/products?q=product%202&page=2&limit=5");
    assert.equal(data.total, 10);
    assert.deepEqual(
      data.items.map((p) => p.id),
      ["pg-prod-25", "pg-prod-26", "pg-prod-27", "pg-prod-28", "pg-prod-29"],
    );
  });

  it("invalid page values fall back to page 1", async () => {
    for (const bad of ["0", "-3", "abc", "1.9"]) {
      const data = await list(`/api/v1/admin/products?page=${bad}`);
      assert.equal(data.total, 30, `page=${bad}`);
      assert.equal(data.items.length, 25, `page=${bad}`);
      assert.equal(data.items[0]!.id, "pg-prod-01", `page=${bad}`);
    }
  });

  it("limit still clamps to 100; a page past a clamped window is empty", async () => {
    const all = await list("/api/v1/admin/products?limit=999");
    assert.equal(all.total, 30);
    assert.equal(all.items.length, 30);
    const past = await list("/api/v1/admin/products?limit=100&page=2");
    assert.equal(past.total, 30);
    assert.deepEqual(past.items, []);
  });

  it("a second endpoint (customers) pages the same way", async () => {
    const page1 = await list("/api/v1/admin/customers?page=1");
    const page2 = await list("/api/v1/admin/customers?page=2");
    assert.equal(page1.total, 30);
    assert.equal(page1.items.length, 25);
    assert.equal(page2.total, 30);
    assert.deepEqual(
      page2.items.map((c) => c.id),
      ["pg-cust-26", "pg-cust-27", "pg-cust-28", "pg-cust-29", "pg-cust-30"],
    );
  });
});
