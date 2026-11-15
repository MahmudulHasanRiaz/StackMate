/**
 * Tracking pixel groups (restructure batch, migration 0006).
 *
 * In-memory test adapter (NOT Postgres) — drives the real HTTP app the
 * way stackmate-e2e.test.ts / catalog-bulk-features.test.ts do:
 *   GET/POST /api/v1/admin/integrated-sites/:siteId/tracking
 *   PATCH/DELETE /api/v1/admin/integrated-sites/:siteId/tracking/:configId
 *   PUT  /api/v1/admin/integrated-sites/:siteId/tracking (compat)
 *   POST /api/v1/public/sites/:siteKey/tracking/events (ingest)
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app";
import { resolveRuntimeConfig } from "../src/env";
import { StackMateDataStore } from "../src/platform/db/store";

describe("Tracking pixel groups (in-memory)", () => {
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
  ): Promise<{ status: number; body: any }> {
    const headers = new Headers(init.headers || {});
    if (cookie) headers.set("Cookie", cookie);
    const res = await app.fetch(
      new Request(`http://localhost:8787${path}`, { ...init, headers }),
      env,
    );
    return { status: res.status, body: await res.json() };
  }

  async function bootstrapAndLoginSuperAdmin(): Promise<string> {
    const bootRes = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Pixel Test Admin",
        email: "pixel-admin@stackmate.local",
        password: "pixel-admin-pass-1",
        setupToken: TEST_SETUP_TOKEN,
      }),
    });
    assert.equal(bootRes.status, 201);
    const signInRes = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "pixel-admin@stackmate.local",
        password: "pixel-admin-pass-1",
      }),
    });
    assert.equal(signInRes.status, 200);
    return `stackmate_session=${signInRes.body.data.session_token}`;
  }

  async function createSite(cookie: string): Promise<{ id: string; siteKey: string }> {
    const productRes = await apiRequest(
      "/api/v1/admin/products",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "PIXELPROD",
          slug: "pixel-prod",
          name: "Pixel Product",
          product_type: "wordpress_plugin",
          fulfillment_type: "software_license",
          default_activation_limit: 3,
          offline_grace_hours: 168,
        }),
      },
      cookie,
    );
    assert.equal(productRes.status, 201, `product create failed: ${JSON.stringify(productRes.body)}`);
    const siteRes = await apiRequest(
      "/api/v1/admin/integrated-sites",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Pixel Test Site",
          environment: "production",
          primary_domain: "pixel-test.example",
          product_ids: [productRes.body.data.id],
          allowed_capabilities: ["catalog.read", "checkout.create", "tracking.events.write"],
        }),
      },
      cookie,
    );
    assert.equal(siteRes.status, 201, `site create failed: ${JSON.stringify(siteRes.body)}`);
    return { id: siteRes.body.data.site.id, siteKey: siteRes.body.data.site.site_key };
  }

  function groupBody(overrides: Record<string, unknown> = {}) {
    return {
      provider: "meta",
      pixel_id: "111111111111111",
      access_token: "EAAB-test-token-000000000001",
      enabled_events: ["PageView", "ViewContent"],
      status: "enabled",
      ...overrides,
    };
  }

  it("creates a group (201), lists it, and never leaks the token", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const site = await createSite(cookie);
    const created = await apiRequest(
      `/api/v1/admin/integrated-sites/${site.id}/tracking`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(groupBody({ label: "Main pixel" })),
      },
      cookie,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const data = created.body.data;
    assert.equal(data.provider, "meta");
    assert.equal(data.label, "Main pixel");
    assert.equal(data.pixel_id, "111111111111111");
    assert.equal(data.status, "enabled");
    assert.equal("access_token_ciphertext" in data, false);
    assert.equal("access_token" in data, false);

    const list = await apiRequest(
      `/api/v1/admin/integrated-sites/${site.id}/tracking`,
      {},
      cookie,
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.data.items.length, 1);
    assert.equal(list.body.data.items[0].id, data.id);
  });

  it("holds several groups per site and 409s a duplicate (provider, pixel_id)", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const site = await createSite(cookie);
    const base = `/api/v1/admin/integrated-sites/${site.id}/tracking`;
    const first = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody()),
    }, cookie);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody({ pixel_id: "222222222222222", label: "Retargeting" })),
    }, cookie);
    assert.equal(second.status, 201, JSON.stringify(second.body));

    // Same pixel, different provider: allowed (different group key).
    const tiktok = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody({ provider: "tiktok", pixel_id: "111111111111111" })),
    }, cookie);
    assert.equal(tiktok.status, 201, JSON.stringify(tiktok.body));

    const dup = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody()),
    }, cookie);
    assert.equal(dup.status, 409, JSON.stringify(dup.body));

    const list = await apiRequest(base, {}, cookie);
    assert.equal(list.body.data.items.length, 3);
  });

  it("updates a group, rotates the token only when supplied, and 422s a no-op", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const site = await createSite(cookie);
    const base = `/api/v1/admin/integrated-sites/${site.id}/tracking`;
    const created = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody({ label: "Main pixel" })),
    }, cookie);
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;
    const rotatedAtBefore = created.body.data.rotated_at as string;

    const renamed = await apiRequest(`${base}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Primary pixel", status: "disabled" }),
    }, cookie);
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.data.label, "Primary pixel");
    assert.equal(renamed.body.data.status, "disabled");
    // No new token supplied → the stored token (and rotated_at) is untouched.
    assert.equal(renamed.body.data.rotated_at, rotatedAtBefore);

    const rotated = await apiRequest(`${base}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "EAAB-test-token-000000000002" }),
    }, cookie);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.notEqual(rotated.body.data.rotated_at, rotatedAtBefore);

    const noop = await apiRequest(`${base}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, cookie);
    assert.equal(noop.status, 422, JSON.stringify(noop.body));

    const audit = store.state.audit_logs.filter(
      (a) => a.resource_id === id && a.action === "tracking.configuration.updated",
    );
    assert.ok(audit.length >= 2, `expected update audit rows, got ${audit.length}`);
  });

  it("409s moving a group onto another group's (provider, pixel_id)", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const site = await createSite(cookie);
    const base = `/api/v1/admin/integrated-sites/${site.id}/tracking`;
    const first = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody()),
    }, cookie);
    assert.equal(first.status, 201);
    const second = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody({ pixel_id: "222222222222222" })),
    }, cookie);
    assert.equal(second.status, 201);

    const clash = await apiRequest(`${base}/${second.body.data.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pixel_id: "111111111111111" }),
    }, cookie);
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
  });

  it("deletes a group (other groups untouched) and 404s the second delete", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const site = await createSite(cookie);
    const base = `/api/v1/admin/integrated-sites/${site.id}/tracking`;
    const first = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody()),
    }, cookie);
    const second = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody({ pixel_id: "222222222222222" })),
    }, cookie);
    assert.equal(second.status, 201);

    const deleted = await apiRequest(`${base}/${first.body.data.id}`, {
      method: "DELETE",
    }, cookie);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.data.pixel_id, "111111111111111");

    const list = await apiRequest(base, {}, cookie);
    assert.equal(list.body.data.items.length, 1);
    assert.equal(list.body.data.items[0].pixel_id, "222222222222222");

    const again = await apiRequest(`${base}/${first.body.data.id}`, {
      method: "DELETE",
    }, cookie);
    assert.equal(again.status, 404, JSON.stringify(again.body));

    const audit = store.state.audit_logs.filter(
      (a) => a.action === "tracking.configuration.deleted",
    );
    assert.equal(audit.length, 1);
  });

  it("404s unknown sites/configs and 401s without a session", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const site = await createSite(cookie);
    const base = `/api/v1/admin/integrated-sites/${site.id}/tracking`;
    const missingSite = "00000000-0000-0000-0000-000000000000";
    const list404 = await apiRequest(
      `/api/v1/admin/integrated-sites/${missingSite}/tracking`, {}, cookie,
    );
    assert.equal(list404.status, 404);
    const post404 = await apiRequest(
      `/api/v1/admin/integrated-sites/${missingSite}/tracking`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(groupBody()),
      },
      cookie,
    );
    assert.equal(post404.status, 404);
    const patch404 = await apiRequest(`${base}/00000000-0000-0000-0000-000000000000`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Nope" }),
    }, cookie);
    assert.equal(patch404.status, 404);

    const anon = await apiRequest(base);
    assert.equal(anon.status, 401);
  });

  it("PUT keeps working: same pixel updates in place, new pixel creates a group", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const site = await createSite(cookie);
    const base = `/api/v1/admin/integrated-sites/${site.id}/tracking`;
    const put = (body: Record<string, unknown>) =>
      apiRequest(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, cookie);

    const first = await put(groupBody());
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const firstId = first.body.data.id as string;

    // Same pixel, new token: updates the same row, no second group.
    const again = await put(groupBody({ access_token: "EAAB-test-token-000000000003" }));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.id, firstId);
    let list = await apiRequest(base, {}, cookie);
    assert.equal(list.body.data.items.length, 1);

    // A different pixel via PUT: creates a second group (the old
    // "rewrite the single config" behavior is intentionally gone).
    const second = await put(groupBody({ pixel_id: "222222222222222" }));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.data.id, firstId);
    list = await apiRequest(base, {}, cookie);
    assert.equal(list.body.data.items.length, 2);
  });

  it("ingest accepts an event enabled only on the second group", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const site = await createSite(cookie);
    const base = `/api/v1/admin/integrated-sites/${site.id}/tracking`;
    const first = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody({ enabled_events: ["PageView"] })),
    }, cookie);
    assert.equal(first.status, 201);
    const second = await apiRequest(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(groupBody({ pixel_id: "222222222222222", enabled_events: ["ViewContent"] })),
    }, cookie);
    assert.equal(second.status, 201);

    const ingest = (eventName: string, eventId: string) =>
      apiRequest(`/api/v1/public/sites/${site.siteKey}/tracking/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_name: eventName,
          event_id: eventId,
          event_time: new Date().toISOString(),
          event_source_url: "https://pixel-test.example/checkout",
          consent: { status: "granted", policy_version: "v1" },
        }),
      });

    // ViewContent is enabled only on the SECOND group — the old
    // first-enabled-group check would have rejected it with 422.
    const viewContent = await ingest("ViewContent", "evt_viewcontent_001");
    assert.equal(viewContent.status, 202, JSON.stringify(viewContent.body));
    assert.equal(viewContent.body.data.accepted, true);

    // Lead is enabled on NEITHER group → still rejected.
    const lead = await ingest("Lead", "evt_lead_001");
    assert.equal(lead.status, 422, JSON.stringify(lead.body));
  });
});
