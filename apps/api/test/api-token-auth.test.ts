/**
 * OD-13 — Bearer auth + sign-in body verification (Worker B).
 *
 * Proves, through the real Hono app on a scratch Postgres DB, that a
 * scoped `stk_` Bearer token authenticates in `authContext`
 * (middleware/auth.ts) WITHOUT Better Auth, that its principal carries
 * exactly the token's scopes (roles: [], so the `super_admin` bypass
 * never applies), and that invalid/expired/revoked `stk_` tokens yield
 * no principal. Also proves no regression for normal staff sessions
 * (cookie + Bearer session token) and re-verifies A-01 on this
 * DB-backed path: the sign-in JSON body carries NO `session_token`
 * (the session arrives via Set-Cookie only). The A-01 shape is
 * already asserted in audit-batch-a1.test.ts and
 * better-auth-unified.test.ts on the in-memory store; the assertion
 * here covers the same route through the Postgres-backed app.
 *
 * Own fresh database (`stackmate_test_api_token_auth`) via
 * `setupTestDb`; tokens are minted with Worker A's
 * `modules/api-tokens/service.ts` (`createApiToken`) — real rows,
 * real peppered hashes, never faked.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DATABASE_URL,
  setupTestDb,
  SUPER_ACTOR,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import { drainConnectionCache } from "../src/platform/db/connection-cache.ts";
import { createHonoApp } from "../src/hono-app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import {
  assertStaffPermission,
  resolveTokenPepper,
} from "../src/modules/identity/service.ts";
import {
  buildApiTokenPrincipal,
  createApiToken,
  generateApiTokenValue,
  isApiTokenValue,
  revokeApiToken,
  verifyApiToken,
} from "../src/modules/api-tokens/service.ts";

// Test-only fixture value (never a real secret).
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const DB_NAME = "stackmate_test_api_token_auth";

describe.skipIf(!DATABASE_URL)("OD-13 API-token Bearer auth", () => {
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];
  let adminClient: Awaited<ReturnType<typeof setupTestDb>>["adminClient"];
  let cleanup: () => Promise<void>;
  let dbUrl: string;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let app: ReturnType<typeof createHonoApp>;
  let pepper: string | null;

  // Tokens minted in beforeAll (raw values kept only in this suite).
  let ordersToken = "";
  let productsToken = "";
  let expiredToken = "";
  let revokedToken = "";

  async function apiRequest(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      authorization?: string;
    } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers();
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.authorization) {
      headers.set("Authorization", options.authorization);
    }
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(
      new Request(`http://localhost:8787${path}`, init),
      env,
    );
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  const bearer = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    const setup = await setupTestDb(DB_NAME);
    store = setup.store;
    adminClient = setup.adminClient;
    cleanup = setup.cleanup;
    const url = new URL(DATABASE_URL);
    url.pathname = `/${DB_NAME}`;
    dbUrl = url.toString();

    env = resolveRuntimeConfig({
      APP_ENV: "test",
      SETUP_TOKEN: TEST_SETUP_TOKEN,
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
    });
    pepper = resolveTokenPepper(store, env.ENCRYPTION_KEY_V1) ?? null;
    app = createHonoApp({
      env,
      storeFactory: async () =>
        DrizzleStore.create({ connectionString: dbUrl }),
    });

    // Mint real tokens (peppered hashes, real rows) with distinct
    // scope sets, so each test below exercises a different principal.
    const orders = await createApiToken(store, {
      name: "od13-orders",
      scopes: ["orders.read"],
      expiresAt: null,
      createdBy: SUPER_ACTOR.user.id,
      pepper,
    });
    ordersToken = orders.value;
    const products = await createApiToken(store, {
      name: "od13-products",
      scopes: ["products.read"],
      expiresAt: null,
      createdBy: SUPER_ACTOR.user.id,
      pepper,
    });
    productsToken = products.value;
    const expired = await createApiToken(store, {
      name: "od13-expired",
      scopes: ["orders.read"],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: SUPER_ACTOR.user.id,
      pepper,
    });
    expiredToken = expired.value;
    const revoked = await createApiToken(store, {
      name: "od13-revoked",
      scopes: ["orders.read"],
      expiresAt: null,
      createdBy: SUPER_ACTOR.user.id,
      pepper,
    });
    revokedToken = revoked.value;
    await revokeApiToken(store, { id: revoked.record.id });
  }, 180_000);

  afterAll(async () => {
    drainConnectionCache();
    await cleanup?.();
  }, 120_000);

  // -- (1) valid stk_ token: principal carries exactly its scopes ---
  it("valid stk_ token authenticates with exactly its scopes", async () => {
    const res = await apiRequest("/api/v1/admin/orders", {
      authorization: bearer(ordersToken),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // Direct principal check: roles [] and permissions === scopes.
    const record = await verifyApiToken(store, {
      rawToken: ordersToken,
      pepper,
    });
    assert.ok(record, "minted orders token must verify");
    const principal = buildApiTokenPrincipal(record);
    assert.deepEqual(principal.roles, []);
    assert.deepEqual(principal.permissions, ["orders.read"]);
    assertStaffPermission(principal, "orders.read");
    assert.throws(
      () => assertStaffPermission(principal, "products.read"),
      (err: unknown) =>
        (err as { statusCode?: number }).statusCode === 403,
      "token without products.read must be denied it",
    );
    // No super_admin bypass: a token principal must NOT pass a guard
    // it lacks, even though a staff super_admin would.
    assert.throws(
      () => assertStaffPermission(principal, "users.manage"),
      (err: unknown) =>
        (err as { statusCode?: number }).statusCode === 403,
    );
  });

  it("token WITHOUT orders.read gets 403 on an orders.read guard — but 200 on its own scope", async () => {
    const denied = await apiRequest("/api/v1/admin/orders", {
      authorization: bearer(productsToken),
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error?.code, "FORBIDDEN");

    const allowed = await apiRequest("/api/v1/admin/products", {
      authorization: bearer(productsToken),
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  });

  // -- (2) invalid / expired / revoked stk_ tokens yield no principal -
  it("invalid stk_ token yields no principal (401 downstream)", async () => {
    const bogus = generateApiTokenValue();
    assert.ok(isApiTokenValue(bogus));
    assert.notEqual(bogus, ordersToken);
    const res = await apiRequest("/api/v1/admin/orders", {
      authorization: bearer(bogus),
    });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.error?.code, "UNAUTHORIZED");
  });

  it("expired stk_ token yields no principal (401 downstream)", async () => {
    const res = await apiRequest("/api/v1/admin/orders", {
      authorization: bearer(expiredToken),
    });
    assert.equal(res.status, 401, JSON.stringify(res.body));
  });

  it("revoked stk_ token yields no principal (401 downstream)", async () => {
    const res = await apiRequest("/api/v1/admin/orders", {
      authorization: bearer(revokedToken),
    });
    assert.equal(res.status, 401, JSON.stringify(res.body));
  });

  // -- (3) a stk_ token never resolves as a staff session --------------
  it("stk_ token never resolves as a staff session (no super_admin bypass)", async () => {
    // A token with only orders.read must NOT pass a users.manage
    // guard — roles [] means no bypass, 403 not 200.
    const res = await apiRequest("/api/v1/admin/users", {
      authorization: bearer(ordersToken),
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error?.code, "FORBIDDEN");

    // The raw stk_ value presented as a session cookie must not
    // resolve either: it is not a Better Auth session token.
    const cookieRes = await apiRequest("/api/v1/admin/orders", {
      cookie: `stackmate_session=${ordersToken}`,
    });
    assert.equal(cookieRes.status, 401, JSON.stringify(cookieRes.body));
  });

  // -- (4) sign-in body has NO session_token (A-01, DB-backed path) ---
  // Runs BEFORE the cookie-session test below: bootstrap refuses
  // with 409 once ANY super admin exists, and the next test attaches
  // the super_admin role to the seeded user.
  it("sign-in via the Hono route returns a JSON body with NO session_token", async () => {
    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "OD13 Super Admin",
        email: "od13-admin@stackmate.local",
        password: "Od13SuperPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));

    const res = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "od13-admin@stackmate.local", password: "Od13SuperPass123!" },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(
      !("session_token" in (res.body.data ?? {})),
      "A-01: session_token must not leak in the sign-in JSON body",
    );
    assert.ok(res.body.data.expires_at, "expires_at stays in the payload");
    assert.ok(res.body.data.principal?.user?.email, "principal stays in the payload");
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    // Cookie name depends on the path: the test-adapter path sets
    // `stackmate_session=` (A-01 test), the Better Auth path used
    // here forwards Better Auth's own `better-auth.session_token`
    // cookie — either way the session arrives via Set-Cookie only.
    const pair = setCookies.find(
      (c) =>
        c.startsWith("stackmate_session=") ||
        c.startsWith("better-auth.session_token="),
    );
    assert.ok(pair, "sign-in must set a session cookie");
    const cookie = pair!.split(";")[0]!;
    const me = await apiRequest("/api/v1/admin/me", { cookie });
    assert.equal(me.status, 200, JSON.stringify(me.body));
  }, 60_000);
  it("normal cookie session still resolves as before", async () => {
    // A real Better Auth session row for the super admin, exactly
    // like the b01-lists HTTP suite does it.
    const sessionToken = `od13-session-${randomUUID()}`;
    await adminClient.query(
      `INSERT INTO sessions (id, token, user_id, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
      [`od13-sess-${randomUUID()}`, sessionToken, SUPER_ACTOR.user.id],
    );
    // The super-admin role must be attached for the principal to
    // carry it (setupTestDb seeds the user row only).
    await store.withTransaction((state) => {
      const role = state.roles.find((r) => r.key === "super_admin");
      assert.ok(role, "super_admin role must exist in seeded roles");
      if (
        !state.user_roles.some(
          (ur) =>
            ur.user_id === SUPER_ACTOR.user.id && ur.role_id === role.id,
        )
      ) {
        state.user_roles.push({
          user_id: SUPER_ACTOR.user.id,
          role_id: role.id,
          assigned_at: new Date().toISOString(),
        });
      }
    });

    const me = await apiRequest("/api/v1/admin/me", {
      cookie: `stackmate_session=${sessionToken}`,
    });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.data?.user?.email, SUPER_ACTOR.user.email);

    const orders = await apiRequest("/api/v1/admin/orders", {
      cookie: `stackmate_session=${sessionToken}`,
    });
    assert.equal(orders.status, 200, JSON.stringify(orders.body));

    // A non-stk_ Bearer session token behaves exactly as before.
    const bearerOrders = await apiRequest("/api/v1/admin/orders", {
      authorization: bearer(sessionToken),
    });
    assert.equal(bearerOrders.status, 200, JSON.stringify(bearerOrders.body));
  });
});
