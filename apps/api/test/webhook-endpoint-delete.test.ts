/**
 * Webhook endpoint delete (restructure batch).
 *
 * In-memory test adapter (NOT Postgres) — drives the real HTTP app the
 * way catalog-bulk-features.test.ts does:
 *   POST   /api/v1/admin/webhooks
 *   DELETE /api/v1/admin/webhooks/:webhookId
 *   GET    /api/v1/admin/webhooks
 *   GET    /api/v1/admin/webhooks/:webhookId/deliveries
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createStackMateApp } from "../src/app";
import { resolveRuntimeConfig } from "../src/env";
import { StackMateDataStore } from "../src/platform/db/store";

describe("Webhook endpoint delete (in-memory)", () => {
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
        name: "Webhook Test Admin",
        email: "webhook-admin@stackmate.local",
        password: "webhook-admin-pass-1",
        setupToken: TEST_SETUP_TOKEN,
      }),
    });
    assert.equal(bootRes.status, 201);
    const signInRes = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "webhook-admin@stackmate.local",
        password: "webhook-admin-pass-1",
      }),
    });
    assert.equal(signInRes.status, 200);
    return sessionCookieFromHeaders(signInRes.headers);
  }

  async function registerEndpoint(cookie: string, url = "https://example.com/stackmate-hook"): Promise<string> {
    const res = await apiRequest(
      "/api/v1/admin/webhooks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          description: "Delete test endpoint",
          integrated_site_id: null,
          subscribed_events: ["order.paid"],
        }),
      },
      cookie,
    );
    assert.equal(res.status, 201, `webhook register failed: ${JSON.stringify(res.body)}`);
    return res.body.data.endpoint.id as string;
  }

  it("deletes an endpoint: list no longer contains it, deliveries are gone", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const endpointId = await registerEndpoint(cookie);
    const otherId = await registerEndpoint(cookie, "https://example.com/other-hook");

    // A delivery row for the endpoint (as a test delivery would leave):
    // the delete must clear it from state too, so persistStateDiff
    // never re-inserts an orphaned row against the FK.
    store.state.webhook_deliveries.push({
      id: randomUUID(),
      webhook_endpoint_id: endpointId,
      event_id: randomUUID(),
      delivery_id: "whd_test_delete_001",
      status: "failed",
      attempt_count: 1,
      last_http_status: 405,
      delivered_at: null,
    });

    const deleted = await apiRequest(`/api/v1/admin/webhooks/${endpointId}`, {
      method: "DELETE",
    }, cookie);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.data.id, endpointId);

    const list = await apiRequest("/api/v1/admin/webhooks", {}, cookie);
    assert.equal(list.status, 200);
    const ids = (list.body.data.items as Array<{ id: string }>).map((e) => e.id);
    assert.equal(ids.includes(endpointId), false);
    assert.equal(ids.includes(otherId), true);

    assert.equal(
      store.state.webhook_deliveries.some((d) => d.webhook_endpoint_id === endpointId),
      false,
    );

    const deliveries = await apiRequest(
      `/api/v1/admin/webhooks/${endpointId}/deliveries`, {}, cookie,
    );
    assert.equal(deliveries.status, 404, JSON.stringify(deliveries.body));

    const audit = store.state.audit_logs.filter(
      (a) => a.action === "webhooks.endpoint.deleted" && a.resource_id === endpointId,
    );
    assert.equal(audit.length, 1);
  });

  it("404s an unknown endpoint and 401s without a session", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    await registerEndpoint(cookie);
    const missing = await apiRequest(
      "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
      { method: "DELETE" },
      cookie,
    );
    assert.equal(missing.status, 404, JSON.stringify(missing.body));

    const anon = await apiRequest("/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
    });
    assert.equal(anon.status, 401, JSON.stringify(anon.body));
  });
});
