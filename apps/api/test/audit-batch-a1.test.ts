/**
 * Audit Batch A1 — Auth + Security (2026-11-25 fix plan).
 *
 * Covers the A1 items at the API level (in-memory test adapter):
 * A-01 (cookie-only sign-in), A-02 (renewal idempotency derivation),
 * A-04 (idempotent commands), A-06 (per-token reset cap), A-09
 * (boot-time URL validation), A-10 (cheap health/setup-status),
 * A-13 (sign-in audit resource_id), A-16 (favicon SVG), A-17
 * (avatar magic bytes / favicon headers), F-01 (audited denials),
 * F-02 (revenue gating), F-09 (no Hono remnant), F-10 (no raw
 * error logging). A-12 is DB-gated (see the last describe block);
 * C-10 is code-level only (no observable surface); F-03's fallback
 * envelope needs the Better Auth mount (DB-backed suite).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { verifyFaviconBytes } from "../src/modules/general-settings/service.ts";
import {
  seedCustomer,
  seedOrder,
  seedProduct,
  seedSite,
  seedSubscription,
} from "./customer-order-helpers.ts";

// Test-only fixture value (never a real secret).
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

describe("Audit Batch A1 — Auth + Security (in-memory)", () => {
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let superCookie = "";
  let roCookie = "";
  let noFinCookie = "";

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
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (options.cookie) headers.set("Cookie", options.cookie);
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    else if (options.rawBody !== undefined) init.body = options.rawBody;
    const res = await app.fetch(new Request(`http://localhost:8787${path}`, init), env);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
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

  async function signIn(email: string, password: string): Promise<string> {
    const res = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(res.status, 200, `sign-in ${email}: ${JSON.stringify(res.body)}`);
    return sessionCookieFromHeaders(res.headers);
  }

  async function createUser(
    name: string,
    email: string,
    password: string,
    roleKeys: string[]
  ): Promise<string> {
    const res = await apiRequest("/api/v1/admin/users", {
      method: "POST",
      cookie: superCookie,
      body: { name, email, password, role_keys: roleKeys },
    });
    assert.equal(res.status, 201, `create user ${email}: ${JSON.stringify(res.body)}`);
    return res.body.data.user.id;
  }

  async function createRole(key: string, name: string, permissions: string[]): Promise<void> {
    const res = await apiRequest("/api/v1/admin/roles", {
      method: "POST",
      cookie: superCookie,
      body: { key, name, permissions },
    });
    assert.equal(res.status, 201, `create role ${key}: ${JSON.stringify(res.body)}`);
  }

  beforeAll(async () => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    app = createStackMateApp(store);
    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "A1 Super Admin",
        email: "a1-admin@stackmate.local",
        password: "A1SuperPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    superCookie = await signIn("a1-admin@stackmate.local", "A1SuperPass123!");
    await createUser("Read Only", "a1-ro@stackmate.local", "ReadOnlyPass123!", ["read_only"]);
    roCookie = await signIn("a1-ro@stackmate.local", "ReadOnlyPass123!");
    await createRole("a1_no_finance", "A1 No Finance", ["products.read"]);
    await createUser("No Finance", "a1-nofin@stackmate.local", "NoFinancePass123!", [
      "a1_no_finance",
    ]);
    noFinCookie = await signIn("a1-nofin@stackmate.local", "NoFinancePass123!");
  });

  // -- A-01: sign-in JSON carries no session token ----------------------
  it("A-01: sign-in JSON has no session_token; the session arrives via Set-Cookie only", async () => {
    const res = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "a1-admin@stackmate.local", password: "A1SuperPass123!" },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!("session_token" in (res.body.data ?? {})), "session_token must not leak in JSON");
    assert.ok(res.body.data.expires_at, "expires_at stays in the payload");
    assert.ok(res.body.data.principal?.user?.email, "principal stays in the payload");
    const cookie = sessionCookieFromHeaders(res.headers);
    assert.ok(cookie.startsWith("stackmate_session="));
    const me = await apiRequest("/api/v1/admin/me", { cookie });
    assert.equal(me.status, 200, JSON.stringify(me.body));
  });

  // -- A-13: sign-in audit uses the session row id ----------------------
  it("A-13: the sign-in audit row resource_id is a session id, never a token prefix", async () => {
    await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "a1-admin@stackmate.local", password: "A1SuperPass123!" },
    });
    const rows = store.state.audit_logs.filter((r) => r.action === "identity.auth.signed_in");
    assert.ok(rows.length >= 1, "expected a signed_in audit row");
    const last = rows[rows.length - 1]!;
    const sessionIds = new Set(store.state.sessions.map((s) => s.id));
    assert.ok(sessionIds.has(last.resource_id), `resource_id ${last.resource_id} is not a session id`);
    assert.ok(!last.resource_id.startsWith("smsess_"), "resource_id must not be a token prefix");
  });

  // -- A-02: manual renewal idempotency derivation ----------------------
  it("A-02: renewal without a key replays while pending, then mints a NEW order once paid", async () => {
    let subId = "";
    let customerId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state);
      customerId = customer.id;
      const order = seedOrder(state, customer.id, product);
      const sub = seedSubscription(state, {
        customer_id: customer.id,
        product_id: product.id,
        source_order_item_id: order.items[0]!.id,
      });
      subId = sub.id;
    });
    assert.ok(customerId);

    const first = await apiRequest(`/api/v1/admin/subscriptions/${subId}/renewal-invoices`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const orderA = first.body.data.renewal_order.id as string;

    // Pending period re-derives its own key: a retry replays the same invoice.
    const replay = await apiRequest(`/api/v1/admin/subscriptions/${subId}/renewal-invoices`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.renewal_order.id, orderA);

    // Once the pending period is completed, the next renewal derives period+1.
    await store.withTransaction((state) => {
      const sub = state.subscriptions.find((s) => s.id === subId)!;
      sub.periods[0]!.status = "completed";
    });
    const second = await apiRequest(`/api/v1/admin/subscriptions/${subId}/renewal-invoices`, {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.data.renewal_order.id, orderA);
    // 1 seeded source order + 2 renewal orders (replay minted none).
    assert.equal(store.state.orders.filter((o) => o.customer_id === customerId).length, 3);
  });

  // -- A-04: admin order create is idempotent ---------------------------
  it("A-04: order create with one Idempotency-Key replays; same key + new payload is 409", async () => {
    let customerId = "";
    let productId = "";
    let versionId = "";
    let priceId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state);
      customerId = customer.id;
      productId = product.id;
      const pkgId = randomUUID();
      versionId = randomUUID();
      priceId = randomUUID();
      state.product_packages.push({
        id: pkgId,
        product_id: product.id,
        package_key: "starter",
        name: "Starter",
        description: null,
        status: "active",
        current_version_id: versionId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any);
      state.package_versions.push({
        id: versionId,
        package_id: pkgId,
        product_id: product.id,
        version_number: 1,
        status: "published",
        change_summary: null,
        features: [],
        published_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      } as any);
      state.package_prices.push({
        id: priceId,
        package_version_id: versionId,
        price_key: "once",
        price_kind: "one_time",
        amount_minor: 100_000,
        currency_code: "BDT",
        interval_unit: null,
        interval_count: null,
        trial_days: 0,
        setup_fee_minor: 0,
        status: "active",
        used_in_orders: false,
        created_at: new Date().toISOString(),
      } as any);
    });
    const body = {
      customer_id: customerId,
      product_id: productId,
      item_kind: "package",
      package_version_id: versionId,
      package_price_id: priceId,
      quantity: 1,
    };
    const first = await apiRequest("/api/v1/admin/orders", {
      method: "POST",
      cookie: superCookie,
      headers: { "Idempotency-Key": "a1-order-key-001" },
      body,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const orderId = first.body.data.order.id as string;

    const replay = await apiRequest("/api/v1/admin/orders", {
      method: "POST",
      cookie: superCookie,
      headers: { "Idempotency-Key": "a1-order-key-001" },
      body,
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.order.id, orderId);
    assert.equal(
      store.state.orders.filter((o) => o.customer_id === customerId).length,
      1,
      "a replay must not mint a second order"
    );

    const conflict = await apiRequest("/api/v1/admin/orders", {
      method: "POST",
      cookie: superCookie,
      headers: { "Idempotency-Key": "a1-order-key-001" },
      body: { ...body, quantity: 2 },
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  // -- A-04: credential create replays with the same secret -------------
  it("A-04: credential create with one Idempotency-Key re-issues the same secret, once", async () => {
    const site = await store.withTransaction((state) => seedSite(state));
    const body = { credential_type: "hmac_shared_secret", scopes: ["checkout.create"] };
    const first = await apiRequest(`/api/v1/admin/integrated-sites/${site.id}/credentials`, {
      method: "POST",
      cookie: superCookie,
      headers: { "Idempotency-Key": "a1-cred-key-001" },
      body,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const secret = first.body.data.raw_secret_once as string;
    assert.ok(secret && secret.length > 0, "first create must show the raw secret once");
    const credId = first.body.data.credential.id as string;

    const replay = await apiRequest(`/api/v1/admin/integrated-sites/${site.id}/credentials`, {
      method: "POST",
      cookie: superCookie,
      headers: { "Idempotency-Key": "a1-cred-key-001" },
      body,
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.credential.id, credId);
    assert.equal(replay.body.data.raw_secret_once, secret, "replay re-derives the same secret");
    assert.equal(
      store.state.site_credentials.filter((c) => c.integrated_site_id === site.id).length,
      1,
      "a replay must not mint a second credential"
    );
  });

  // -- A-06: per-token reset cap ----------------------------------------
  it("A-06: the 6th reset-password attempt with a garbage token is 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await apiRequest("/api/auth/reset-password", {
        method: "POST",
        body: { token: "garbage-token-a1", new_password: "NewPass12345!" },
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 5), [422, 422, 422, 422, 422]);
    assert.equal(statuses[5], 429, `6th attempt must be capped, got ${JSON.stringify(statuses)}`);
  });

  // -- A-09: boot-time URL validation -----------------------------------
  it("A-09: staging with omitted URL vars throws (resolved localhost defaults)", () => {
    assert.throws(
      () =>
        resolveRuntimeConfig({
          APP_ENV: "staging",
          BETTER_AUTH_SECRET: "staging-better-auth-secret-minimum-32-chars!",
          ENCRYPTION_KEY_V1: "staging-aes-256-gcm-master-key-32-bytes!!",
          LICENSE_VERIFIER_SECRET: "staging-license-verifier-secret-2026!!",
          CHECKOUT_TOKEN_SECRET: "staging-checkout-token-secret-2026!!!!",
          HYPERDRIVE_NO_CACHE: {
            connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test",
          },
        }),
      /points at localhost/
    );
  });

  // -- A-10: health/setup-status answer without the store ---------------
  it("A-10: /health answers with ZERO storeFactory calls", async () => {
    let factoryCalls = 0;
    const countingApp = createStackMateApp({
      storeFactory: async (bindings) => {
        factoryCalls += 1;
        const s = new StackMateDataStore();
        return s;
      },
    });
    const countingEnv = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    const res = await countingApp.fetch(
      new Request("http://localhost:8787/api/v1/health"),
      countingEnv
    );
    assert.equal(res.status, 200, await res.text());
    assert.equal(factoryCalls, 0, "health must not resolve the store");
  });

  it("A-10: /setup-status with an injected store reports unprovisioned before bootstrap", async () => {
    const freshStore = new StackMateDataStore();
    const freshApp = createStackMateApp(freshStore);
    const res = await freshApp.fetch(
      new Request("http://localhost:8787/api/v1/setup-status"),
      env
    );
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text) as any;
    assert.equal(body.data.setup_required, true);
  });

  // -- A-16: favicon SVG gate + sanitized bytes -------------------------
  it("A-16: verifyFaviconBytes rejects <svg/onload=...> (415) and keeps clean SVG", () => {
    const evil = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg"/onload=alert(1)><circle r="5"/></svg>`
    );
    assert.throws(
      () => verifyFaviconBytes(evil, "image/svg+xml"),
      (err: unknown) =>
        (err as { statusCode?: number }).statusCode === 415 &&
        /event handlers/.test((err as Error).message)
    );
    const clean = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>`
    );
    const stored = verifyFaviconBytes(clean, "image/svg+xml");
    assert.equal(new TextDecoder().decode(stored).includes("<circle"), true);
  });

  it("A-16: the public favicon is served with nosniff + sandbox CSP for SVG", async () => {
    const res = await apiRequest("/api/v1/favicon");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    if ((res.headers.get("Content-Type") ?? "").includes("svg")) {
      assert.ok(
        (res.headers.get("Content-Security-Policy") ?? "").includes("sandbox"),
        "SVG favicon must carry a sandbox CSP"
      );
    }
  });

  // -- A-17: avatar magic bytes + avatar GET headers --------------------
  it("A-17: avatar upload with PNG-declared but non-PNG bytes is 415", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], "avatar.png", {
        type: "image/png",
      })
    );
    const res = await apiRequest("/api/v1/admin/me/avatar", {
      method: "POST",
      cookie: superCookie,
      rawBody: form,
    });
    assert.equal(res.status, 415, JSON.stringify(res.body));
  });

  it("A-17: avatar GET carries nosniff", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
      0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
      0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
      0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
      0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
      0x60, 0x82,
    ]);
    const form = new FormData();
    form.append("file", new File([png], "avatar.png", { type: "image/png" }));
    const upload = await apiRequest("/api/v1/admin/me/avatar", {
      method: "POST",
      cookie: superCookie,
      rawBody: form,
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const served = await apiRequest("/api/v1/admin/me/avatar", { cookie: superCookie });
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.equal(served.headers.get("X-Content-Type-Options"), "nosniff");
  });

  // -- F-01: denied reads write an audited denial -----------------------
  it("F-01: a read-only denial on product create writes identity.auth.permission_denied", async () => {
    const denied = await apiRequest("/api/v1/admin/products", {
      method: "POST",
      cookie: roCookie,
      body: { name: "A1 Denied Product", code: "a1-denied-product" },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const rows = store.state.audit_logs.filter(
      (r) => r.action === "identity.auth.permission_denied"
    );
    assert.ok(rows.length >= 1, "expected a permission_denied audit row");
    assert.ok(
      rows.some((r) => r.outcome === "denied" && r.resource_id === "products.create"),
      `denial row must name products.create, got ${JSON.stringify(rows.map((r) => r.resource_id))}`
    );
  });

  // -- F-02: revenue gating on the overview -----------------------------
  it("F-02: overview as no-finance returns null revenue counts (not 0)", async () => {
    const res = await apiRequest("/api/v1/admin/analytics/overview", { cookie: noFinCookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.total_orders, null);
    assert.equal(res.body.data.paid_orders, null);
    assert.equal(res.body.data.pending_payment_submissions, null);
    assert.equal(res.body.data.verified_revenue_minor, null);
    const asSuper = await apiRequest("/api/v1/admin/analytics/overview", {
      cookie: superCookie,
    });
    assert.equal(asSuper.status, 200, JSON.stringify(asSuper.body));
    assert.equal(typeof asSuper.body.data.total_orders, "number");
  });

  // -- F-03: unauthenticated fallback errors keep the envelope ----------
  it("F-03: an unauthenticated auth-fallback error is wrapped in the error envelope", async () => {
    const res = await apiRequest("/api/auth/get-session");
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "UNAUTHORIZED");
    assert.equal(typeof res.body.error.message, "string");
  });

  // -- F-09: Hono IS the foundation (reverted 2026-11-25) --------------
  // Audit #2's F-09 removed Hono as a dead dependency. The owner then
  // ordered a full Hono migration (2026-11-25), so the removal was
  // reverted and Hono is now the backend foundation. This test guards
  // the new state: Hono must be a declared dependency AND the Hono app
  // composition must exist. (The old "no Hono" assertion is the exact
  // opposite of the current architecture — do not restore it.)
  it("F-09: package.json declares hono and the Hono app composition exists", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, "apps/api/package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    assert.equal(
      pkg.dependencies?.hono,
      "4.13.18",
      "hono must be a pinned dependency (Hono migration)"
    );
    const honoAppSrc = readFileSync(
      path.join(repoRoot, "apps/api/src/hono-app.ts"),
      "utf8"
    );
    assert.ok(
      /export function createHonoApp/.test(honoAppSrc),
      "hono-app.ts must export createHonoApp"
    );
    assert.ok(
      /registerAllRoutes/.test(honoAppSrc),
      "hono-app.ts must register all routes"
    );
  });

  // -- F-10: store-creation failure logs the message only ---------------
  it("F-10: a store-creation failure logs a string, never the raw Error object", async () => {
    const seen: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(...args);
    };
    try {
      const failingApp = createStackMateApp({
        storeFactory: async () => {
          throw new Error("a1-db-exploded-marker");
        },
      });
      const res = await failingApp.fetch(
        new Request("http://localhost:8787/api/v1/admin/me"),
        env
      );
      assert.equal(res.status, 500, await res.text());
    } finally {
      console.error = orig;
    }
    assert.ok(seen.length >= 1, "expected a console.error call on store failure");
    for (const arg of seen) {
      assert.ok(!(arg instanceof Error), "console.error must not receive the raw Error object");
    }
    assert.ok(
      seen.some((a) => typeof a === "string" && a.includes("a1-db-exploded-marker")),
      "the message itself is still logged"
    );
  });
});
