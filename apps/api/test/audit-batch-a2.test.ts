/**
 * Audit fix-all Batch A2 (Worker A2) — admin dispatcher + lists +
 * dashboard + E routes (app.ts admin half).
 *
 * In-memory store only (no Postgres needed). Fixtures are seeded
 * directly into the store — the handlers under test read the fields
 * below, and the API-created fixtures in api-core-batch.test.ts
 * already cover the create paths.
 *
 * Items covered: A-08 (6 MB gate + multipart streaming cap), B-05
 * (contracts `total` + cursor pagination on append-heavy lists), B-06
 * (dashboard panels in one overview call), B-07 (avatar ETag +
 * immutable), B-08 (public catalog Cache-Control), B-11 (no false
 * cachedQueries), B-15 + cron lease (scheduled tick runs; lease
 * module is exercised through the real DB-backed path in the
 * integration suite), E-03/E-04/E-06/E-08/E-16/E-17/E-18 (E routes),
 * E-05 (signing keys), E-09 (renewals view), E-11 (upcoming
 * renewals), E-19 (attribution + dedup flag), E-21 (jobs, no-DB 503).
 */
import { describe, it, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { computeInstallationIdHash } from "../src/platform/crypto/index.ts";

const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const NOW = Date.now();
const isoInDays = (days: number) => new Date(NOW + days * 86400_000).toISOString();
const isoInSeconds = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

describe("Audit Batch A2 — dispatcher, lists, dashboard, E routes", () => {
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let superCookie = "";

  async function apiRequest(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      rawBody?: BodyInit | null;
      cookie?: string;
      headers?: Record<string, string>;
    } = {}
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    else if (options.rawBody !== undefined) init.body = options.rawBody;
    const res = await app.fetch(new Request(`http://localhost:8787${path}`, init), env);
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  async function adminGet(path: string) {
    const res = await apiRequest(path, { cookie: superCookie });
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
    return res;
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
          name: "A2 Super Admin",
          email: "a2-admin@stackmate.local",
          password: "A2-test-password-1",
          setupToken: TEST_SETUP_TOKEN,
        }),
      }),
      env
    );
    assert.equal(bootRes.status, 201, await bootRes.text());
    const signIn = await app.fetch(
      new Request("http://localhost:8787/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "a2-admin@stackmate.local",
          password: "A2-test-password-1",
        }),
      }),
      env
    );
    const signInText = await signIn.text();
    assert.equal(signIn.status, 200, signInText);
    // A-01: the session token is cookie-only — sign-in JSON no longer
    // carries session_token, so the cookie comes from Set-Cookie.
    const setCookies =
      typeof signIn.headers.getSetCookie === "function"
        ? signIn.headers.getSetCookie()
        : [];
    const pair = setCookies.find((c) => c.startsWith("stackmate_session="));
    assert.ok(pair, "sign-in must set a stackmate_session cookie");
    superCookie = pair!.split(";")[0]!;

    // --- Shared fixtures -------------------------------------------------
    store.state.customers.push({
      id: "a2-cust-1",
      name: "A2 Customer",
      email: "a2-customer@example.local",
      customer_number: "A2-CUST-1",
      status: "active",
      created_at: isoInSeconds(-100),
    } as any);
    store.state.products.push({
      id: "a2-prod-1",
      name: "A2 Product",
      code: "A2_PROD",
      slug: "a2-product",
      product_type: "saas_application",
      status: "active",
      created_at: isoInSeconds(-100),
    } as any);
    store.state.product_features.push({
      id: "11111111-1111-4111-8111-111111111111",
      product_id: "a2-prod-1",
      feature_key: "seats",
      name: "Seats",
      value_type: "limit",
      unit: "seats",
      status: "active",
      created_at: isoInSeconds(-100),
    } as any);
    store.state.integrated_sites.push({
      id: "a2-site-1",
      site_key: "a2_test_site",
      name: "A2 Test Site",
      status: "active",
      product_ids: ["a2-prod-1"],
      domains: [{ domain: "test.example.com", is_primary: true }],
      created_at: isoInSeconds(-100),
    } as any);

    // Order with an entitlement snapshot + attribution (E-08/E-19).
    store.state.orders.push({
      id: "a2-order-1",
      order_number: "ORD-A20001",
      public_reference: "a2-ord-1",
      customer_id: "a2-cust-1",
      source: "admin",
      integrated_site_id: null,
      status: "processing",
      payment_status: "unpaid",
      currency_code: "BDT",
      subtotal_minor: 50000,
      discount_minor: 0,
      tax_minor: 0,
      total_minor: 50000,
      customer_note: null,
      internal_note: null,
      items: [
        {
          id: "a2-order-item-1",
          order_id: "a2-order-1",
          product_id: "a2-prod-1",
          package_id: null,
          package_version_id: null,
          package_price_id: null,
          item_kind: "custom",
          fulfillment_type_snapshot: "license",
          product_name_snapshot: "A2 Product",
          package_name_snapshot: null,
          package_version_snapshot: null,
          price_kind_snapshot: "one_time",
          interval_unit_snapshot: null,
          interval_count_snapshot: null,
          activation_limit_snapshot: 1,
          quantity: 1,
          unit_amount_minor: 50000,
          line_subtotal_minor: 50000,
          line_discount_minor: 0,
          line_tax_minor: 0,
          line_total_minor: 50000,
          currency_code: "BDT",
          entitlement_snapshot: {
            id: "a2-snap-1",
            order_item_id: "a2-order-item-1",
            source_type: "custom_offer",
            source_package_version_id: null,
            schema_version: 1,
            snapshot_hash: "a2hash",
            items: [
              {
                feature_key_snapshot: "seats",
                value_type_snapshot: "limit",
                entitlement_value: { value_type: "limit", value: 5, unit: "seats" },
                unit_snapshot: "seats",
              },
            ],
            created_at: isoInSeconds(-90),
          },
          created_at: isoInSeconds(-90),
        },
      ],
      attribution: {
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "launch",
        fbp: "fb.1.123456789",
        fbc: "fb.1.123456789.abc",
      },
      created_by_user_id: null,
      activation_mode: "on_full_payment",
      activation_percent: null,
      activation_date: null,
      suspend_on_missed_schedule: false,
      grace_days: 3,
      payment_method_id: null,
      lead_id: null,
      created_at: isoInSeconds(-50),
      updated_at: isoInSeconds(-50),
      completed_at: null,
      cancelled_at: null,
    } as any);
    store.state.orders.push({
      id: "a2-order-2",
      order_number: "ORD-A20002",
      public_reference: "a2-ord-2",
      customer_id: "a2-cust-1",
      source: "admin",
      integrated_site_id: null,
      status: "completed",
      payment_status: "paid",
      currency_code: "BDT",
      subtotal_minor: 10000,
      discount_minor: 0,
      tax_minor: 0,
      total_minor: 10000,
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
      created_at: isoInSeconds(-10),
      updated_at: isoInSeconds(-10),
      completed_at: isoInSeconds(-10),
      cancelled_at: null,
    } as any);
    store.state.payment_submissions.push({
      id: "a2-sub-1",
      order_id: "a2-order-1",
      customer_id: "a2-cust-1",
      payment_method_id: null,
      installment_id: null,
      amount_minor: 50000,
      currency_code: "BDT",
      sender_name: "A2 Sender",
      sender_phone: null,
      sender_bank_name: null,
      sender_account_reference: null,
      transfer_rail_key: null,
      transaction_reference: "A2TXN1",
      normalized_transaction_reference: "A2TXN1",
      payment_date: null,
      proof_asset_id: null,
      duplicate_risk_warning: false,
      status: "submitted",
      customer_note: null,
      submitted_at: isoInSeconds(-40),
      created_at: isoInSeconds(-40),
    } as any);

    // Licenses: one expiring within 30d (overview panel), one holding
    // the activation used by the E-03 transfer test.
    store.state.licenses.push({
      id: "a2-lic-expiring",
      license_number: "LIC-A2-EXP",
      product_id: "a2-prod-1",
      customer_id: "a2-cust-1",
      source_order_item_id: null,
      subscription_id: null,
      status: "active",
      expires_at: isoInDays(10),
      activations: [],
      snapshots: [],
      created_at: isoInSeconds(-80),
    } as any);
    store.state.licenses.push({
      id: "a2-lic-transfer",
      license_number: "LIC-A2-TRF",
      product_id: "a2-prod-1",
      customer_id: "a2-cust-1",
      source_order_item_id: null,
      subscription_id: null,
      status: "active",
      expires_at: null,
      activations: [
        {
          id: "a2-act-1",
          license_id: "a2-lic-transfer",
          installation_id_hash: computeInstallationIdHash("a2-lic-transfer", "inst-old"),
          domain_normalized: null,
          environment: "production",
          status: "active",
          activated_at: isoInSeconds(-70),
          last_seen_at: isoInSeconds(-70),
          deactivated_at: null,
          metadata: {},
          created_at: isoInSeconds(-70),
        },
      ],
      snapshots: [],
      created_at: isoInSeconds(-80),
    } as any);

    // Subscriptions across the renewal buckets (E-09/E-11).
    const sub = (id: string, status: string, days: number | null) => ({
      id,
      subscription_number: `SUB-${id}`,
      customer_id: "a2-cust-1",
      product_id: "a2-prod-1",
      source_order_item_id: null,
      source_package_version_id: null,
      status,
      billing_kind: "recurring",
      interval_unit: "month",
      interval_count: 1,
      currency_code: "BDT",
      unit_amount_minor: 10000,
      grace_days: 3,
      current_period_start: null,
      current_period_end: null,
      next_renewal_at: days === null ? null : isoInDays(days),
      cancel_at_period_end: false,
      cancelled_at: null,
      periods: [],
      created_at: isoInSeconds(-60),
      updated_at: isoInSeconds(-60),
    });
    store.state.subscriptions.push(
      sub("a2-sub-due", "active", 5) as any,
      sub("a2-sub-upcoming", "active", 20) as any,
      sub("a2-sub-far", "active", 60) as any,
      sub("a2-sub-cancelled", "cancelled", 3) as any
    );

    // 30 audit rows, one per second (B-05 cursor walk).
    for (let i = 0; i < 30; i++) {
      store.state.audit_logs.push({
        id: `a2-audit-${String(i).padStart(2, "0")}`,
        action: "test.action",
        resource_type: "order",
        resource_id: "a2-order-1",
        actor_type: "staff",
        actor_user_id: "a2-admin",
        outcome: "success",
        request_id: `req-a2-${i}`,
        changes: null,
        created_at: isoInSeconds(-300 + i),
      } as any);
    }

    // Tracking events: two first-seen rows + one duplicate of evt-1
    // (same site + event_name + event_id, later created_at).
    const track = (id: string, eventId: string, seconds: number) => ({
      id,
      integrated_site_id: "a2-site-1",
      event_name: "PageView",
      event_id: eventId,
      event_time: isoInSeconds(seconds),
      event_source_url: "https://test.example.com/",
      order_id: null,
      consent_state: "granted",
      consent_policy_version: "v1",
      sanitized_payload: {},
      status: "queued",
      delivery_attempts: 0,
      delivered_at: null,
      created_at: isoInSeconds(seconds),
    });
    store.state.tracking_events.push(
      track("a2-track-1", "evt-1", -200) as any,
      track("a2-track-2", "evt-2", -190) as any,
      track("a2-track-1-dup", "evt-1", -180) as any
    );

    // 5 outbox rows for the cursor walk.
    for (let i = 0; i < 5; i++) {
      store.state.outbox_events.push({
        id: `a2-outbox-${i}`,
        event_key: `test.event:${i}`,
        aggregate_type: "order",
        aggregate_id: "a2-order-1",
        event_type: "test.event",
        payload: {},
        status: "pending",
        created_at: isoInSeconds(-100 + i),
      } as any);
    }

    // Pixel group for the E-18 test event.
    store.state.tracking_configurations.push({
      id: "a2-pixel-group-1",
      integrated_site_id: "a2-site-1",
      provider: "meta",
      pixel_id: "1234567890",
      label: "A2 Meta",
      status: "enabled",
      enabled_events: ["PageView"],
      test_event_code: "TEST123",
      created_at: isoInSeconds(-100),
    } as any);
  });

  it("A-08: JSON body over 6 MB is 413; multipart over 6 MB passes the gate", async () => {
    const big = await apiRequest("/api/v1/admin/products", {
      method: "POST",
      cookie: superCookie,
      rawBody: "x".repeat(7 * 1024 * 1024),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(7 * 1024 * 1024),
      },
    });
    assert.equal(big.status, 413);
    assert.equal(big.body.error.code, "PAYLOAD_TOO_LARGE");

    // 7 MB multipart body: the gate must NOT 413 it (media cap is
    // 100 MB). It fails later (no file / no DB) — but never with 413.
    const boundary = "----a2boundary";
    const filler = "x".repeat(7 * 1024 * 1024);
    const multipart =
      `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${filler}\r\n--${boundary}--\r\n`;
    const multi = await apiRequest("/api/v1/admin/media", {
      method: "POST",
      cookie: superCookie,
      rawBody: multipart,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(Buffer.byteLength(multipart)),
      },
    });
    assert.notEqual(multi.status, 413, JSON.stringify(multi.body));
  });

  it("A-08: multipart past the per-route cap 413s without buffering (declared length)", async () => {
    const res = await apiRequest("/api/v1/admin/me/avatar", {
      method: "POST",
      cookie: superCookie,
      rawBody: "tiny",
      headers: {
        "Content-Type": "multipart/form-data; boundary=----a2b",
        "Content-Length": String(3 * 1024 * 1024),
      },
    });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, "PAYLOAD_TOO_LARGE");
  });

  it("B-08 + B-11: public catalog GETs are cacheable and never fake a cached read", async () => {
    const before = store.queryMetrics.cachedQueries;
    const res = await apiRequest("/api/v1/public/sites/a2_test_site/products");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      res.headers.get("Cache-Control"),
      "public, max-age=60, stale-while-revalidate=15"
    );
    const detail = await apiRequest("/api/v1/public/sites/a2_test_site/products/a2-product");
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(
      detail.headers.get("Cache-Control"),
      "public, max-age=60, stale-while-revalidate=15"
    );
    assert.equal(store.queryMetrics.cachedQueries, before);
  });

  it("B-05: cursor pagination walks audit logs with no skip/duplicate; bad cursor is 400", async () => {
    const seen = new Set<string>();
    // The cursor path only engages when ?cursor= is present — the
    // first page passes an empty cursor. ?action= scopes the walk to
    // this suite's rows (bootstrap/sign-in also write audit rows).
    let cursor: string | null = "";
    let total = 0;
    let pages = 0;
    while (cursor !== null && pages < 10) {
      const res = await adminGet(
        `/api/v1/admin/audit-logs?limit=10&action=test.action&cursor=${encodeURIComponent(cursor)}`
      );
      const data = res.body.data as {
        items: { id: string }[];
        total: number;
        next_cursor: string | null;
      };
      total = data.total;
      assert.equal(data.items.length, 10);
      assert.ok(data.total === 30, `total is ${data.total}`);
      for (const item of data.items) {
        assert.ok(!seen.has(item.id), `duplicate row ${item.id}`);
        seen.add(item.id);
      }
      cursor = data.next_cursor;
      pages++;
    }
    assert.equal(total, 30);
    assert.equal(seen.size, 30);
    assert.equal(pages, 3);
    const bad = await apiRequest("/api/v1/admin/audit-logs?limit=10&cursor=!!!not-a-cursor", {
      cookie: superCookie,
    });
    assert.equal(bad.status, 400);
  });

  it("B-05: outbox cursor walk returns every row exactly once", async () => {
    const seen = new Set<string>();
    let cursor: string | null = "";
    while (cursor !== null) {
      const res = await adminGet(
        `/api/v1/admin/outbox-events?limit=2&cursor=${encodeURIComponent(cursor)}`
      );
      const data = res.body.data as { items: { id: string }[]; next_cursor: string | null };
      for (const item of data.items) {
        assert.ok(!seen.has(item.id));
        seen.add(item.id);
      }
      cursor = data.next_cursor;
    }
    assert.equal(seen.size, 5);
  });

  it("B-06 + E-11: overview carries panels + upcoming_renewals in one call", async () => {
    const res = await adminGet("/api/v1/admin/analytics/overview");
    const data = res.body.data as any;
    assert.equal(data.upcoming_renewals, 2);
    assert.ok(Array.isArray(data.panels.recent_orders));
    assert.ok(data.panels.recent_orders.length >= 2);
    assert.equal(data.panels.recent_orders[0].order_number, "ORD-A20002");
    assert.equal(data.panels.pending_submissions.length, 1);
    assert.equal(data.panels.pending_submissions[0].id, "a2-sub-1");
    assert.equal(data.panels.expiring_licenses.length, 1);
    assert.equal(data.panels.expiring_licenses[0].id, "a2-lic-expiring");
  });

  it("E-09: renewals buckets are disjoint and filterable; unknown bucket is 400", async () => {
    const due = await adminGet("/api/v1/admin/renewals?bucket=due");
    assert.deepEqual(
      due.body.data.items.map((s: any) => s.id),
      ["a2-sub-due"]
    );
    assert.equal(due.body.data.items[0].bucket, "due");
    const upcoming = await adminGet("/api/v1/admin/renewals?bucket=upcoming");
    assert.deepEqual(
      upcoming.body.data.items.map((s: any) => s.id),
      ["a2-sub-upcoming"]
    );
    const cancelled = await adminGet("/api/v1/admin/renewals?bucket=cancelled");
    assert.deepEqual(
      cancelled.body.data.items.map((s: any) => s.id),
      ["a2-sub-cancelled"]
    );
    const all = await adminGet("/api/v1/admin/renewals");
    assert.equal(all.body.data.total, 3);
    const bad = await apiRequest("/api/v1/admin/renewals?bucket=nope", {
      cookie: superCookie,
    });
    assert.equal(bad.status, 400);
  });

  it("E-19: order detail exposes attribution + entitlement_snapshot; tracking rows carry deduplicated", async () => {
    const order = await adminGet("/api/v1/admin/orders/a2-order-1");
    assert.equal(order.body.data.attribution.utm_source, "google");
    assert.equal(order.body.data.attribution.fbp, "fb.1.123456789");
    assert.equal(order.body.data.attribution.referrer, undefined);
    assert.equal(order.body.data.entitlement_snapshot.length, 1);
    assert.equal(
      order.body.data.entitlement_snapshot[0].items[0].feature_key_snapshot,
      "seats"
    );
    const tracking = await adminGet("/api/v1/admin/tracking/events?limit=10");
    const byId = new Map(tracking.body.data.items.map((e: any) => [e.id, e]));
    assert.equal((byId.get("a2-track-1") as any).deduplicated, false);
    assert.equal((byId.get("a2-track-2") as any).deduplicated, false);
    assert.equal((byId.get("a2-track-1-dup") as any).deduplicated, true);
  });

  it("E-21: jobs endpoint needs a database (in-memory store is 503)", async () => {
    const res = await apiRequest("/api/v1/admin/jobs", { cookie: superCookie });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "STORE_UNAVAILABLE");
  });

  it("E-05: signing keys list, rotate, revoke (active revoke is 409)", async () => {
    const list1 = await adminGet("/api/v1/admin/licenses/signing-keys");
    assert.equal(list1.body.data.keys.length, 1);
    const oldActive = list1.body.data.active_key_id as string;
    assert.equal(list1.body.data.keys[0].status, "active");

    const rotated = await apiRequest("/api/v1/admin/licenses/signing-keys/rotate", {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
    const newKeyId = rotated.body.data.key_id as string;
    assert.notEqual(newKeyId, oldActive);
    assert.equal(rotated.body.data.status, "active");
    assert.ok(rotated.body.data.public_key_jwk);

    const list2 = await adminGet("/api/v1/admin/licenses/signing-keys");
    assert.equal(list2.body.data.keys.length, 2);
    assert.equal(list2.body.data.active_key_id, newKeyId);

    const revokeActive = await apiRequest(
      `/api/v1/admin/licenses/signing-keys/${encodeURIComponent(newKeyId)}/revoke`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(revokeActive.status, 409);

    const revoked = await apiRequest(
      `/api/v1/admin/licenses/signing-keys/${encodeURIComponent(oldActive)}/revoke`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.data.revoked, true);
    const list3 = await adminGet("/api/v1/admin/licenses/signing-keys");
    assert.equal(list3.body.data.keys.length, 1);
    assert.equal(list3.body.data.active_key_id, newKeyId);
  });

  it("E-03: license activation transfer moves the seat to a new installation", async () => {
    const res = await apiRequest(
      "/api/v1/admin/licenses/a2-lic-transfer/activations/a2-act-1/transfer",
      {
        method: "POST",
        cookie: superCookie,
        body: { installation_id: "inst-new", reason: "Laptop replaced" },
      }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.from_activation.status, "deactivated");
    assert.equal(res.body.data.to_activation.status, "active");
    assert.notEqual(res.body.data.to_activation.id, "a2-act-1");
  });

  it("E-08: save order as package creates a package (201)", async () => {
    const res = await apiRequest("/api/v1/admin/orders/a2-order-1/save-as-package", {
      method: "POST",
      cookie: superCookie,
      body: { name: "A2 Saved Package" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.package.name, "A2 Saved Package");
    assert.equal(res.body.data.package.product_id, "a2-prod-1");
  });

  it("E-04 + E-17: webhook rotate issues a once-only secret; PATCH edits url without touching the secret", async () => {
    const created = await apiRequest("/api/v1/admin/webhooks", {
      method: "POST",
      cookie: superCookie,
      body: {
        url: "https://example.com/hook",
        description: "A2 endpoint",
        subscribed_events: ["order.created"],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const webhookId = created.body.data.endpoint.id as string;

    const rotated = await apiRequest(`/api/v1/admin/webhooks/${webhookId}/rotate`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.ok((rotated.body.data.raw_signing_secret_once as string).startsWith("whsec_"));
    assert.notEqual(rotated.body.data.previous_key_id, rotated.body.data.endpoint.secret_key_id);

    const patched = await apiRequest(`/api/v1/admin/webhooks/${webhookId}`, {
      method: "PATCH",
      cookie: superCookie,
      body: { url: "https://example.com/hook-v2" },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.url, "https://example.com/hook-v2");
    assert.equal(patched.body.data.secret_key_id, rotated.body.data.endpoint.secret_key_id);
    assert.equal(patched.body.data.secret_ciphertext, undefined);
  });

  it("E-16: payment method then provider delete (provider with methods is 409)", async () => {
    const provider = await apiRequest("/api/v1/admin/payment-providers", {
      method: "POST",
      cookie: superCookie,
      body: {
        provider_key: "a2bkash",
        display_name: "A2 bKash",
        provider_type: "manual_mfs",
        adapter_key: "manual_mfs",
      },
    });
    assert.equal(provider.status, 201, JSON.stringify(provider.body));
    const providerId = provider.body.data.id as string;
    const method = await apiRequest("/api/v1/admin/payment-methods", {
      method: "POST",
      cookie: superCookie,
      body: {
        provider_id: providerId,
        method_key: "bkash_personal",
        display_name: "A2 bKash Personal",
        method_kind: "mfs_account",
        configuration: { account_number: "01700000000" },
      },
    });
    assert.equal(method.status, 201, JSON.stringify(method.body));
    const methodId = method.body.data.id as string;

    const blocked = await apiRequest(`/api/v1/admin/payment-providers/${providerId}`, {
      method: "DELETE",
      cookie: superCookie,
    });
    assert.equal(blocked.status, 409);

    const delMethod = await apiRequest(`/api/v1/admin/payment-methods/${methodId}`, {
      method: "DELETE",
      cookie: superCookie,
    });
    assert.equal(delMethod.status, 200, JSON.stringify(delMethod.body));
    const delProvider = await apiRequest(`/api/v1/admin/payment-providers/${providerId}`, {
      method: "DELETE",
      cookie: superCookie,
    });
    assert.equal(delProvider.status, 200, JSON.stringify(delProvider.body));
    const gone = await apiRequest(`/api/v1/admin/payment-providers/${providerId}`, {
      method: "DELETE",
      cookie: superCookie,
    });
    assert.equal(gone.status, 404);
  });

  it("E-18: tracking test event goes through the pipeline (202); bad input is 422", async () => {
    const bad = await apiRequest("/api/v1/admin/tracking/test-event", {
      method: "POST",
      cookie: superCookie,
      body: { pixel_group_id: "a2-pixel-group-1" },
    });
    assert.equal(bad.status, 422);
    const res = await apiRequest("/api/v1/admin/tracking/test-event", {
      method: "POST",
      cookie: superCookie,
      body: { pixel_group_id: "a2-pixel-group-1", event_name: "PageView" },
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.data.accepted, true);
    assert.equal(res.body.data.pixel_group_id, "a2-pixel-group-1");
    assert.equal(res.body.data.event_name, "PageView");
  });

  it("E-06: S2S webhook-test requires signed auth (unsigned is not 404)", async () => {
    const res = await apiRequest("/api/v1/integrations/sites/a2_test_site/webhook-test", {
      method: "POST",
      rawBody: "{}",
      headers: { "Content-Type": "application/json" },
    });
    assert.notEqual(res.status, 404);
    assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
  });

  it("B-07: avatar upload then GET serves ETag + immutable; If-None-Match is 304", async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const form = new FormData();
    form.set("file", new File([pngBytes], "avatar.png", { type: "image/png" }));
    const uploaded = await apiRequest("/api/v1/admin/me/avatar", {
      method: "POST",
      cookie: superCookie,
      rawBody: form,
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.ok((uploaded.body.data.avatar_url as string).startsWith("avatars/"));

    const got = await apiRequest("/api/v1/admin/me/avatar", { cookie: superCookie });
    assert.equal(got.status, 200);
    const etag = got.headers.get("ETag");
    assert.ok(etag, "ETag present");
    assert.ok((got.headers.get("Cache-Control") ?? "").includes("immutable"));
    assert.equal(got.headers.get("X-Content-Type-Options"), "nosniff");
    const notModified = await apiRequest("/api/v1/admin/me/avatar", {
      cookie: superCookie,
      headers: { "If-None-Match": etag! },
    });
    assert.equal(notModified.status, 304);
  });

  it("Cron lease + B-15: scheduled tick completes with a drain-shaped report", async () => {
    const result = (await app.scheduled({ cron: "* * * * *" }, env)) as any;
    assert.equal(typeof result.claimed, "number");
    assert.equal(typeof result.delivered, "number");
    assert.equal(typeof result.simulated, "number");
  });
});
