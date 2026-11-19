/**
 * Dashboard overview date filter (PLAN §23, owner 2026-11-17).
 *
 * `GET /api/v1/admin/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * scopes the flow metrics to the inclusive range (Dhaka day boundaries):
 *   - verified_revenue_minor: paid orders completed in the range
 *     (paid-only definition unchanged; all time = the old computation)
 *   - total_orders: created in the range
 *   - paid_orders: created in the range AND paid (cohort ratio)
 * Snapshot metrics (products, subscriptions, licenses, queues,
 * all-time customer total) are NOT range-scoped.
 *
 * Seed orders are inserted by SQL before the store loads (fixed dates,
 * so no test depends on the real clock):
 *   O1  created 2026-11-02, completed 2026-11-03, paid,     ৳1,000.00
 *   O2  created 2026-11-16, completed 2026-11-16, paid,     ৳500.00
 *   O3  created 2026-11-17, completed NULL,       unpaid,   ৳200.00
 *   O4  created 2026-10-01, completed 2026-10-02, paid,     ৳700.00
 *   O5  created/completed 2026-11-16T17:59:59Z (= 23:59:59 Dhaka 16/11),
 *       paid, ৳300.00 — inside to=2026-11-16, outside from=2026-11-17
 *   O6  created/completed 2026-11-16T18:00:00Z (= 00:00 Dhaka 17/11),
 *       paid, ৳400.00 — inside from=2026-11-17, outside to=2026-11-16
 * (O5/O6 prove the boundary is Dhaka, not UTC.)
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_dashboard_range`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const DB_NAME = "stackmate_test_dashboard_range";
const API_BASE = "http://localhost:8787";
const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN = "0123456789abcdef".repeat(4);
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe.skipIf(!DATABASE_URL)("dashboard overview — date range filter (PLAN §23)", () => {
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

  async function authed(path: string) {
    return apiRequest(path, { cookie: sessionCookie, origin: STAGING_ORIGIN });
  }

  // Admin API responses are enveloped ({ data, meta }).
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

    // Seed the six orders (fixed dates) BEFORE the store loads — the
    // store reads the full state once at creation.
    await adminClient.query(
      `INSERT INTO customers (id, customer_number, customer_type, name, status, registration_source, country_code, created_at, updated_at)
       VALUES ('11111111-1111-1111-1111-111111111111', 'CUST-1', 'person', 'Range Test Customer', 'active', 'admin', 'BD', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`
    );
    const seedOrder = (
      id: string,
      num: string,
      created: string,
      completed: string | null,
      paymentStatus: string,
      status: string,
      total: number,
    ) =>
      adminClient.query(
        `INSERT INTO orders (id, order_number, public_reference, customer_id, source, status, payment_status, currency_code, subtotal_minor, discount_minor, tax_minor, total_minor, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, '11111111-1111-1111-1111-111111111111', 'admin', $4, $5, 'BDT', $6, 0, 0, $6, $7, $7, $8)`,
        [id, num, `ORD-${num}`, status, paymentStatus, total, created, completed],
      );
    await seedOrder("22222222-2222-2222-2222-222222222201", "1", "2026-11-02T10:00:00Z", "2026-11-03T10:00:00Z", "paid", "completed", 100000);
    await seedOrder("22222222-2222-2222-2222-222222222202", "2", "2026-11-16T10:00:00Z", "2026-11-16T12:00:00Z", "paid", "completed", 50000);
    await seedOrder("22222222-2222-2222-2222-222222222203", "3", "2026-11-17T10:00:00Z", null, "unpaid", "awaiting_payment", 20000);
    await seedOrder("22222222-2222-2222-2222-222222222204", "4", "2026-10-01T10:00:00Z", "2026-10-02T10:00:00Z", "paid", "completed", 70000);
    await seedOrder("22222222-2222-2222-2222-222222222205", "5", "2026-11-16T17:59:59Z", "2026-11-16T17:59:59Z", "paid", "completed", 30000);
    await seedOrder("22222222-2222-2222-2222-222222222206", "6", "2026-11-16T18:00:00Z", "2026-11-16T18:00:00Z", "paid", "completed", 40000);

    store = await DrizzleStore.create({ connectionString: dbUrl.toString() });
    app = createStackMateApp(store);

    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Range Admin",
        email: "range-admin@example.com",
password: "SuperAdminPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signedIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "range-admin@example.com", password: "SuperAdminPass123!" },
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

  it("(1) no params — all time, identical to the pre-filter computation", async () => {
    const res = await authed("/api/v1/admin/analytics/overview");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = dataOf(res);
    assert.equal(d.total_orders, 6);
    assert.equal(d.paid_orders, 5);
    assert.equal(d.verified_revenue_minor, 290000);
    assert.equal(d.total_customers, 1);
    assert.equal(d.range, null);
  }, 60_000);

  it("(2) 01/11–17/11 — inside counts, October order excluded", async () => {
    const res = await authed("/api/v1/admin/analytics/overview?from=2026-11-01&to=2026-11-17");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = dataOf(res);
    assert.equal(d.total_orders, 5);
    assert.equal(d.paid_orders, 4);
    assert.equal(d.verified_revenue_minor, 220000);
    assert.deepEqual(d.range, { from: "2026-11-01", to: "2026-11-17" });
    // Snapshots do NOT move with the range.
    assert.equal(d.total_customers, 1);
    assert.equal(d.total_products, 0);
    assert.equal(d.active_subscriptions, 0);
  }, 60_000);

  it("(3) single day 17/11 — unpaid order counts in total, not in paid/revenue", async () => {
    const res = await authed("/api/v1/admin/analytics/overview?from=2026-11-17&to=2026-11-17");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = dataOf(res);
    assert.equal(d.total_orders, 2); // O3 (unpaid) + O6
    assert.equal(d.paid_orders, 1); // O6 only
    assert.equal(d.verified_revenue_minor, 40000);
  }, 60_000);

  it("(4) Dhaka boundary — 17:59:59Z is 16/11 in Dhaka, 18:00:00Z is 17/11", async () => {
    const to16 = await authed("/api/v1/admin/analytics/overview?from=2026-11-01&to=2026-11-16");
    assert.equal(to16.status, 200, JSON.stringify(to16.body));
    assert.equal(dataOf(to16).total_orders, 3); // O1, O2, O5 — not O6
    assert.equal(dataOf(to16).verified_revenue_minor, 180000); // 100k + 50k + 30k
    const from17 = await authed("/api/v1/admin/analytics/overview?from=2026-11-17&to=2026-11-17");
    assert.equal(from17.status, 200, JSON.stringify(from17.body));
    assert.equal(dataOf(from17).total_orders, 2); // O3 + O6 — not O5
    assert.equal(dataOf(from17).verified_revenue_minor, 40000);
  }, 60_000);

  it("(5) October only — the old paid order counts there", async () => {
    const res = await authed("/api/v1/admin/analytics/overview?from=2026-10-01&to=2026-10-31");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = dataOf(res);
    assert.equal(d.total_orders, 1);
    assert.equal(d.paid_orders, 1);
    assert.equal(d.verified_revenue_minor, 70000);
  }, 60_000);

  it("(6) empty range — zeros, not an error", async () => {
    const res = await authed("/api/v1/admin/analytics/overview?from=2026-11-18&to=2026-11-19");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = dataOf(res);
    assert.equal(d.total_orders, 0);
    assert.equal(d.paid_orders, 0);
    assert.equal(d.verified_revenue_minor, 0);
  }, 60_000);

  it("(7) invalid ranges → 400", async () => {
    const cases: Array<[string, string]> = [
      ["bad month", "/api/v1/admin/analytics/overview?from=2026-13-01&to=2026-11-17"],
      ["bad calendar day", "/api/v1/admin/analytics/overview?from=2026-02-30&to=2026-03-01"],
      ["from only", "/api/v1/admin/analytics/overview?from=2026-11-01"],
      ["from after to", "/api/v1/admin/analytics/overview?from=2026-11-10&to=2026-11-01"],
      ["span over 366 days", "/api/v1/admin/analytics/overview?from=2025-01-01&to=2026-11-17"],
      ["not a date", "/api/v1/admin/analytics/overview?from=tomorrow&to=2026-11-17"],
    ];
    for (const [label, path] of cases) {
      const res = await authed(path);
      assert.equal(res.status, 400, `${label}: expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, "VALIDATION_ERROR", label);
    }
  }, 60_000);
});
