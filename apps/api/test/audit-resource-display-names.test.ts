/**
 * Audit-log resource display names (F3 follow-up, 2026-11-16).
 *
 * GET /api/v1/admin/audit-logs returns an additive
 * `resource_display_name` per row, resolved server-side from the
 * in-memory state (see resolveAuditResourceDisplayName in the audit
 * service). In-memory test adapter (NOT Postgres) — seeds minimal
 * records directly into store.state plus one audit row per resource
 * type, then asserts the display name (or null for deleted resources
 * and unknown types).
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app";
import { resolveRuntimeConfig } from "../src/env";
import { StackMateDataStore } from "../src/platform/db/store";
import { appendAuditLog } from "../src/modules/audit/service";

describe("Audit-log resource display names (in-memory)", () => {
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
        name: "Audit Test Admin",
        email: "audit-admin@stackmate.local",
        password: "audit-admin-pass-1",
        setupToken: TEST_SETUP_TOKEN,
      }),
    });
    assert.equal(bootRes.status, 201);
    const signInRes = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "audit-admin@stackmate.local",
        password: "audit-admin-pass-1",
      }),
    });
    assert.equal(signInRes.status, 200);
    return `stackmate_session=${signInRes.body.data.session_token}`;
  }

  function audit(
    resourceType: string,
    resourceId: string,
    actorUserId?: string | null,
  ): void {
    appendAuditLog(store.state, {
      actor_type: "staff",
      actor_user_id: actorUserId ?? null,
      action: "test.display_name",
      resource_type: resourceType,
      resource_id: resourceId,
      outcome: "success",
      request_id: "test-request",
    });
  }

  it("resolves a human display name for every resource type", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    const admin = store.state.users[0]!;
    const adminId = admin.id;

    // Flat resources.
    store.state.integrated_sites.push({ id: "site-1", name: "Test site" } as never);
    store.state.webhook_endpoints.push({
      id: "hook-1",
      url: "https://example.com/stackmate-hook",
    } as never);
    store.state.staff_invitations.push({
      id: "inv-1",
      email: "invitee@example.com",
    } as never);
    store.state.products.push({ id: "prod-1", name: "TEST Product" } as never);
    store.state.product_features.push({ id: "feat-1", name: "Flow Test A" } as never);
    store.state.product_packages.push({
      id: "pkg-1",
      name: "Wizard Test Package",
    } as never);
    store.state.package_versions.push({
      id: "ver-1",
      package_id: "pkg-1",
      version_number: 2,
    } as never);
    store.state.package_prices.push({
      id: "price-1",
      package_version_id: "ver-1",
      price_kind: "recurring",
      amount_minor: 100000,
      currency_code: "BDT",
      interval_unit: "month",
      interval_count: 1,
    } as never);
    store.state.customers.push({ id: "cust-1", name: "Rahim Uddin" } as never);
    store.state.orders.push({ id: "ord-1", order_number: "ORD-0001" } as never);
    store.state.subscriptions.push({
      id: "sub-1",
      subscription_number: "SUB-0001",
    } as never);
    store.state.licenses.push({ id: "lic-1", license_number: "LIC-0001" } as never);
    store.state.payment_methods.push({
      id: "pm-1",
      display_name: "bKash Personal",
    } as never);
    store.state.payment_providers.push({ id: "pp-1", display_name: "bKash" } as never);
    store.state.payment_submissions.push({
      id: "ps-1",
      order_id: "ord-1",
      amount_minor: 50000,
      currency_code: "BDT",
    } as never);
    store.state.invoices.push({ id: "inv-1", invoice_number: "INV-0001" } as never);
    store.state.roles.push({ id: "role-1", name: "Support" } as never);
    store.state.site_credentials.push({ id: "cred-1", key_id: "key_abc123" } as never);
    store.state.tracking_configurations.push({
      id: "trk-1",
      label: "Main pixel",
      provider: "meta",
      pixel_id: "123456789012345",
    } as never);
    store.state.tracking_configurations.push({
      id: "trk-2",
      label: null,
      provider: "tiktok",
      pixel_id: "987654321",
    } as never);
    store.state.outbox_events.push({ id: "ob-1", event_type: "order.created" } as never);
    store.state.sessions.push({
      id: "sess-1",
      token: "tok_abcdefghijklmnop",
      user_id: adminId,
    } as never);

    const rows: Array<[string, string, string | null | undefined]> = [
      ["user", adminId, undefined],
      ["staff_user", adminId, undefined],
      ["integrated_site", "site-1", undefined],
      ["webhook_endpoint", "hook-1", undefined],
      ["staff_invitation", "inv-1", undefined],
      ["product", "prod-1", undefined],
      ["product_feature", "feat-1", undefined],
      ["product_package", "pkg-1", undefined],
      ["package_version", "ver-1", undefined],
      ["package_price", "price-1", undefined],
      ["customer", "cust-1", undefined],
      ["order", "ord-1", undefined],
      ["subscription", "sub-1", undefined],
      ["license", "lic-1", undefined],
      ["payment_method", "pm-1", undefined],
      ["payment_provider", "pp-1", undefined],
      ["payment_submission", "ps-1", undefined],
      ["invoice", "inv-1", undefined],
      ["role", "role-1", undefined],
      ["site_credential", "cred-1", undefined],
      ["tracking_configuration", "trk-1", undefined],
      ["tracking_configuration", "trk-2", undefined],
      ["outbox_event", "ob-1", undefined],
      // Sessions: failed sign-in rows carry the attempted email as the
      // id; signed-in rows carry a 12-char token prefix; revoke rows
      // carry the session id; unknown ids fall back to the actor.
      ["session", "someone@example.com", undefined],
      ["session", "sess-1", undefined],
      ["session", "tok_abcdefgh", undefined],
      ["session", "no-such-session", adminId],
    ];
    for (const [type, id, actor] of rows) audit(type, id, actor);

    const res = await apiRequest("/api/v1/admin/audit-logs", {}, cookie);
    assert.equal(res.status, 200);
    const items = res.body.data.items as Array<{
      resource_type: string;
      resource_id: string;
      resource_display_name: string | null;
    }>;
    const find = (type: string, id: string) =>
      items.find((i) => i.resource_type === type && i.resource_id === id)
        ?.resource_display_name;

    assert.equal(find("user", adminId), "Audit Test Admin");
    assert.equal(find("staff_user", adminId), "Audit Test Admin");
    assert.equal(find("integrated_site", "site-1"), "Test site");
    assert.equal(find("webhook_endpoint", "hook-1"), "https://example.com/stackmate-hook");
    assert.equal(find("staff_invitation", "inv-1"), "invitee@example.com");
    assert.equal(find("product", "prod-1"), "TEST Product");
    assert.equal(find("product_feature", "feat-1"), "Flow Test A");
    assert.equal(find("product_package", "pkg-1"), "Wizard Test Package");
    assert.equal(find("package_version", "ver-1"), "v2 · Wizard Test Package");
    assert.equal(
      find("package_price", "price-1"),
      "৳1,000.00 / 1 month · Wizard Test Package v2",
    );
    assert.equal(find("customer", "cust-1"), "Rahim Uddin");
    assert.equal(find("order", "ord-1"), "ORD-0001");
    assert.equal(find("subscription", "sub-1"), "SUB-0001");
    assert.equal(find("license", "lic-1"), "LIC-0001");
    assert.equal(find("payment_method", "pm-1"), "bKash Personal");
    assert.equal(find("payment_provider", "pp-1"), "bKash");
    assert.equal(find("payment_submission", "ps-1"), "৳500.00 · Order ORD-0001");
    assert.equal(find("invoice", "inv-1"), "INV-0001");
    assert.equal(find("role", "role-1"), "Support");
    assert.equal(find("site_credential", "cred-1"), "key_abc123");
    assert.equal(find("tracking_configuration", "trk-1"), "Main pixel");
    assert.equal(find("tracking_configuration", "trk-2"), "tiktok pixel 987654321");
    assert.equal(find("outbox_event", "ob-1"), "order.created");
    assert.equal(find("session", "someone@example.com"), "someone@example.com");
    assert.equal(find("session", "sess-1"), "Audit Test Admin");
    assert.equal(find("session", "tok_abcdefgh"), "Audit Test Admin");
    assert.equal(find("session", "no-such-session"), "Audit Test Admin");
  });

  it("returns null for deleted resources and unknown types", async () => {
    const cookie = await bootstrapAndLoginSuperAdmin();
    audit("product", "00000000-0000-0000-0000-000000000000");
    audit("nonsense_type", "whatever-id");
    const res = await apiRequest("/api/v1/admin/audit-logs", {}, cookie);
    assert.equal(res.status, 200);
    const items = res.body.data.items as Array<{
      resource_type: string;
      resource_id: string;
      resource_display_name: string | null;
    }>;
    const deleted = items.find(
      (i) =>
        i.resource_type === "product" &&
        i.resource_id === "00000000-0000-0000-0000-000000000000",
    );
    const unknown = items.find((i) => i.resource_type === "nonsense_type");
    assert.equal(deleted?.resource_display_name, null);
    assert.equal(unknown?.resource_display_name, null);
  });
});
