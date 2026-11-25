/**
 * Dashboard list ordering tests (audit gap: "dashboard ordering beyond
 * 100 rows is API-ordering-dependent").
 *
 * The dashboard report panels fetch `?limit=100` windows of orders,
 * payment submissions and licenses, then sort/filter client-side over
 * the loaded set. The orders and licenses handlers returned rows in
 * raw store (insertion) order, so once a collection grew past 100
 * rows the window held an arbitrary set — the newest rows could be
 * silently dropped, and rows past 100 came back in an unstable order.
 * Payment submissions were already deterministic (M-22).
 *
 * This file proves the fix: every dashboard list endpoint sorts
 * server-side BEFORE the window slices — newest-first by its
 * timestamp field (created_at, submitted_at for submissions) with an
 * id ASC tiebreak — and honours an explicit `?sort=<field>:desc|asc`
 * param (unknown values fall back to the newest-first default).
 *
 * In-memory store only (no Postgres needed). Fixtures are seeded
 * directly into the store in a scrambled insertion order, so the
 * expected output order can only come from the sort, never from
 * insertion order.
 */
import { describe, it, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";

const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const BASE_MS = Date.UTC(2026, 0, 1);
const at = (hours: number) => new Date(BASE_MS + hours * 3_600_000).toISOString();

describe("Dashboard list ordering (deterministic, newest-first)", () => {
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
    return res.body.data as { items: { id: string; created_at?: string; submitted_at?: string }[]; total: number };
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
          name: "Ordering Super Admin",
          email: "order-admin@stackmate.local",
          password: "OrderAdminPass123!",
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
          email: "order-admin@stackmate.local",
          password: "OrderAdminPass123!",
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

    store.state.customers.push({
      id: "ord-cust",
      name: "Ordering Customer",
      status: "active",
      created_at: at(0),
    } as any);

    // 105 orders + 105 licenses, created_at = base + n hours, inserted
    // in a scrambled order (37 and 105 are coprime, so (k*37)%105 is a
    // permutation) — the expected output order can only come from the
    // sort. Two extra rows share one timestamp (base + 200h, the
    // newest), inserted in reverse id order, to prove the id ASC
    // tiebreak.
    const insertion = Array.from({ length: 105 }, (_, k) => ((k * 37) % 105) + 1);
    for (const n of insertion) {
      const nn = String(n).padStart(3, "0");
      store.state.orders.push({
        id: `ord-${nn}`,
        order_number: `ORD-${nn}`,
        public_reference: `SMO-ORD-${nn}`,
        customer_id: "ord-cust",
        source: "admin",
        integrated_site_id: null,
        status: "awaiting_payment",
        payment_status: "unpaid",
        currency_code: "BDT",
        subtotal_minor: 1_000_000,
        discount_minor: 0,
        tax_minor: 0,
        total_minor: 1_000_000,
        customer_note: null,
        internal_note: null,
        items: [],
        attribution: null,
        created_by_user_id: null,
        activation_mode: "on_full_payment",
        activation_percent: null,
        activation_date: null,
        suspend_on_missed_schedule: false,
        grace_days: 3,
        payment_method_id: null,
        lead_id: null,
        created_at: at(n),
        updated_at: at(n),
      } as any);
      store.state.licenses.push({
        id: `lic-${nn}`,
        license_number: `LIC-${nn}`,
        product_id: "ord-prod",
        customer_id: "ord-cust",
        source_order_item_id: null,
        subscription_id: null,
        license_key_hash: "hash",
        license_key_hint: "hint",
        status: "active",
        activation_limit: 1,
        valid_from: at(0),
        expires_at: at(24 * 30 + n),
        grace_until: null,
        current_entitlement_snapshot_id: "snap",
        snapshots: [],
        activations: [],
        issued_at: at(0),
        created_at: at(n),
        updated_at: at(n),
      } as any);
    }
    // Tie rows: same (newest) timestamp, inserted b-before-a.
    for (const [id, num] of [
      ["ord-tie-b", "TIE-B"],
      ["ord-tie-a", "TIE-A"],
    ] as const) {
      store.state.orders.push({
        id,
        order_number: `ORD-${num}`,
        public_reference: `SMO-${num}`,
        customer_id: "ord-cust",
        source: "admin",
        integrated_site_id: null,
        status: "awaiting_payment",
        payment_status: "unpaid",
        currency_code: "BDT",
        subtotal_minor: 1_000_000,
        discount_minor: 0,
        tax_minor: 0,
        total_minor: 1_000_000,
        customer_note: null,
        internal_note: null,
        items: [],
        attribution: null,
        created_by_user_id: null,
        activation_mode: "on_full_payment",
        activation_percent: null,
        activation_date: null,
        suspend_on_missed_schedule: false,
        grace_days: 3,
        payment_method_id: null,
        lead_id: null,
        created_at: at(200),
        updated_at: at(200),
      } as any);
    }
    for (const id of ["lic-tie-b", "lic-tie-a"]) {
      store.state.licenses.push({
        id,
        license_number: id.toUpperCase(),
        product_id: "ord-prod",
        customer_id: "ord-cust",
        source_order_item_id: null,
        subscription_id: null,
        license_key_hash: "hash",
        license_key_hint: "hint",
        status: "active",
        activation_limit: 1,
        valid_from: at(0),
        expires_at: at(24 * 30 + 200),
        grace_until: null,
        current_entitlement_snapshot_id: "snap",
        snapshots: [],
        activations: [],
        issued_at: at(0),
        created_at: at(200),
        updated_at: at(200),
      } as any);
    }
    // Submissions: distinct times plus a tie pair (b inserted first).
    for (const [id, hours] of [
      ["sub-old", 0],
      ["sub-mid", 10],
      ["sub-tie-b", 20],
      ["sub-tie-a", 20],
    ] as const) {
      store.state.payment_submissions.push({
        id,
        order_id: "ord-001",
        customer_id: "ord-cust",
        payment_method_id: "pm-1",
        installment_id: null,
        amount_minor: 10_000,
        currency_code: "BDT",
        sender_name: null,
        sender_phone: null,
        sender_bank_name: null,
        sender_account_reference: null,
        transfer_rail_key: null,
        transaction_reference: null,
        normalized_transaction_reference: null,
        payment_date: null,
        proof_asset_id: null,
        duplicate_risk_Warning: false,
        status: "submitted",
        customer_note: null,
        submitted_at: at(hours),
        reviewed_at: null,
        reviewed_by_user_id: null,
      } as any);
    }
  });

  it("orders: page 1 of the 100-window is exactly the 100 newest, tie id ASC", async () => {
    const data = await list("/api/v1/admin/orders?limit=100&sort=created_at:desc");
    assert.equal(data.total, 107);
    assert.equal(data.items.length, 100);
    const expected = [
      "ord-tie-a",
      "ord-tie-b",
      ...Array.from({ length: 98 }, (_, i) => `ord-${String(105 - i).padStart(3, "0")}`),
    ];
    assert.deepEqual(
      data.items.map((o) => o.id),
      expected,
    );
    // Timestamps non-increasing across the whole window.
    const times = data.items.map((o) => new Date(o.created_at!).getTime());
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! <= times[i - 1]!);
  });

  it("orders: page 2 holds the 7 oldest, disjoint from page 1", async () => {
    const page1 = await list("/api/v1/admin/orders?limit=100&sort=created_at:desc");
    const page2 = await list("/api/v1/admin/orders?limit=100&page=2&sort=created_at:desc");
    assert.equal(page2.total, 107);
    assert.deepEqual(
      page2.items.map((o) => o.id),
      ["ord-007", "ord-006", "ord-005", "ord-004", "ord-003", "ord-002", "ord-001"],
    );
    const page1Ids = new Set(page1.items.map((o) => o.id));
    for (const item of page2.items) assert.ok(!page1Ids.has(item.id));
  });

  it("orders: sort=created_at:asc flips the order; unknown sort falls back to desc", async () => {
    const asc = await list("/api/v1/admin/orders?limit=100&sort=created_at:asc");
    assert.equal(asc.total, 107);
    assert.equal(asc.items[0]!.id, "ord-001");
    assert.equal(asc.items[99]!.id, "ord-100");
    const ascPage2 = await list("/api/v1/admin/orders?limit=100&page=2&sort=created_at:asc");
    assert.deepEqual(
      ascPage2.items.map((o) => o.id),
      ["ord-101", "ord-102", "ord-103", "ord-104", "ord-105", "ord-tie-a", "ord-tie-b"],
    );
    const bogus = await list("/api/v1/admin/orders?limit=100&sort=bogus");
    assert.equal(bogus.items[0]!.id, "ord-tie-a", "unknown sort must fall back to newest-first");
    const noSort = await list("/api/v1/admin/orders?limit=100");
    assert.equal(noSort.items[0]!.id, "ord-tie-a", "no sort param must default to newest-first");
  });

  it("licenses: page 1 is exactly the 100 newest, page 2 the 7 oldest", async () => {
    const page1 = await list("/api/v1/admin/licenses?limit=100&sort=created_at:desc");
    assert.equal(page1.total, 107);
    assert.deepEqual(
      page1.items.map((l) => l.id),
      [
        "lic-tie-a",
        "lic-tie-b",
        ...Array.from({ length: 98 }, (_, i) => `lic-${String(105 - i).padStart(3, "0")}`),
      ],
    );
    const page2 = await list("/api/v1/admin/licenses?limit=100&page=2&sort=created_at:desc");
    assert.deepEqual(
      page2.items.map((l) => l.id),
      ["lic-007", "lic-006", "lic-005", "lic-004", "lic-003", "lic-002", "lic-001"],
    );
    const asc = await list("/api/v1/admin/licenses?limit=100&sort=created_at:asc");
    assert.equal(asc.items[0]!.id, "lic-001");
  });

  it("payment-submissions: default stays M-22 newest-first; sort flips it", async () => {
    const def = await list("/api/v1/admin/payment-submissions?limit=100");
    assert.deepEqual(
      def.items.map((s) => s.id),
      ["sub-tie-a", "sub-tie-b", "sub-mid", "sub-old"],
    );
    const explicit = await list(
      "/api/v1/admin/payment-submissions?limit=100&sort=submitted_at:desc",
    );
    assert.deepEqual(
      explicit.items.map((s) => s.id),
      ["sub-tie-a", "sub-tie-b", "sub-mid", "sub-old"],
    );
    const asc = await list(
      "/api/v1/admin/payment-submissions?limit=100&sort=submitted_at:asc",
    );
    assert.deepEqual(
      asc.items.map((s) => s.id),
      ["sub-old", "sub-mid", "sub-tie-a", "sub-tie-b"],
    );
  });
});
