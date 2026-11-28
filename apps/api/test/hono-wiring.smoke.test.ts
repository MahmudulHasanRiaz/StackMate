/**
 * Hono wiring smoke test (Hono migration wiring step).
 *
 * Proves the LIVE request path goes through the Hono app — that
 * `createStackMateApp` (the Worker entrypoint contract) delegates to
 * Hono, not to the old hand-rolled fetchHandler in app-legacy.ts.
 * Runs on the in-memory store (no DB), same as the other api tests.
 *
 * What it proves:
 * 1. A-10 early path preserved: GET /health answers WITHOUT a store
 *    (the Hono /health route includes `hyperdrive.query_metrics`;
 *    the early path does not — so absence of query_metrics proves
 *    the early path ran, not the Hono route).
 * 2. A real authed admin route works end-to-end through Hono
 *    (middleware chain + route + store): bootstrap super admin, sign
 *    in, GET /api/v1/admin/me → 200 with the user.
 * 3. Unknown route → 404 NOT_FOUND envelope (Hono notFound).
 * 4. The HONO_ENABLED rollback flag switches implementations:
 *    POST /api/v1/graphql (unauthenticated) is 401 on the Hono path
 *    (the route exists, auth required) and 404 on the legacy path
 *    (the old handler has no GraphQL route).
 * 5. (Informational) per-request Hono app creation cost, logged —
 *    the wiring creates a Hono app per fetch call (the entrypoint
 *    already creates the app per request); this measures that cost.
 */
import { describe, it, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app.ts";
import { createHonoApp } from "../src/hono-app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";

const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Hono wiring — live path goes through Hono", () => {
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let superCookie = "";

  async function apiRequest(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      headers?: Record<string, string>;
      env?: ReturnType<typeof resolveRuntimeConfig>;
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
    const res = await app.fetch(
      new Request(`http://localhost:8787${path}`, init),
      options.env ?? env
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

  function sessionCookieFromHeaders(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    const pair = setCookies.find((c) => c.startsWith("stackmate_session="));
    assert.ok(pair, "sign-in must set a stackmate_session cookie");
    return pair!.split(";")[0]!;
  }

  beforeAll(async () => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    app = createStackMateApp(store);
    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Wiring Super Admin",
        email: "wiring-admin@stackmate.local",
        password: "WiringSuperPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signin = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "wiring-admin@stackmate.local", password: "WiringSuperPass123!" },
    });
    assert.equal(signin.status, 200, JSON.stringify(signin.body));
    superCookie = sessionCookieFromHeaders(signin.headers);
  });

  it("GET /health answers via the A-10 early path (no query_metrics)", async () => {
    const res = await apiRequest("/api/v1/health");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, "ok");
    assert.equal(res.body.data.service, "stackmate-api");
    // The Hono /health route adds hyperdrive.query_metrics; the early
    // path does not. Absence proves the early path short-circuited
    // before the Hono route (and before any store resolution).
    assert.equal(
      "query_metrics" in (res.body.data.hyperdrive ?? {}),
      false,
      "health must come from the early path, not the Hono route"
    );
  });

  it("authed admin route works end-to-end through Hono (GET /admin/me)", async () => {
    const res = await apiRequest("/api/v1/admin/me", { cookie: superCookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // /admin/me returns the StaffPrincipal: data.user.email.
    assert.equal(res.body.data.user.email, "wiring-admin@stackmate.local");
  });

  it("unknown route answers 404 NOT_FOUND (Hono notFound)", async () => {
    const res = await apiRequest("/api/v1/definitely-not-a-route");
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "NOT_FOUND");
    assert.match(res.body.error.message, /not found/i);
  });

  it("HONO_ENABLED flag switches implementations (GraphQL exists only on Hono)", async () => {
    // Default (Hono ON): the GraphQL route exists — unauthenticated
    // is 401 (route found, auth required).
    const honoRes = await apiRequest("/api/v1/graphql", {
      method: "POST",
      body: { query: "{ __typename }" },
    });
    assert.equal(honoRes.status, 401, JSON.stringify(honoRes.body));
    // Legacy (HONO_ENABLED=0): the old handler has no GraphQL route.
    const legacyEnv = resolveRuntimeConfig({
      APP_ENV: "test",
      SETUP_TOKEN: TEST_SETUP_TOKEN,
      HONO_ENABLED: "0",
    });
    const legacyRes = await apiRequest("/api/v1/graphql", {
      method: "POST",
      body: { query: "{ __typename }" },
      env: legacyEnv,
    });
    assert.equal(legacyRes.status, 404, JSON.stringify(legacyRes.body));
    assert.equal(legacyRes.body.error.code, "NOT_FOUND");
  });

  it("site key alone on an admin route is 403 (not 401) — public keys never authenticate admin", async () => {
    // Old app.ts admin-block guard (~L2969-2978): a site-key-only
    // request to /api/v1/admin/* is FORBIDDEN, not UNAUTHORIZED.
    // The credential type is wrong, not missing.
    const res = await apiRequest("/api/v1/admin/products", {
      headers: { "X-StackMate-Site-Key": "sm_site_testkey0000000000000000" },
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "FORBIDDEN");
    assert.match(res.body.error.message, /site key/i);
  });

  it("injected store is adopted, never closed (regression: DrizzleStore kill)", async () => {
    // A store with a dispose spy: if the Hono middleware treats the
    // injected store as factory-owned and closes it after a request,
    // dispose is called — which is exactly what killed every Postgres
    // integration test (DrizzleStore.dispose closes its pg connection;
    // every later request throws "DrizzleStore is closed").
    let disposeCalls = 0;
    class SpyStore extends StackMateDataStore {
      async dispose(): Promise<void> {
        disposeCalls++;
      }
    }
    const spyStore = new SpyStore();
    const spyApp = createStackMateApp(spyStore);
    const spyEnv = resolveRuntimeConfig({
      APP_ENV: "test",
      SETUP_TOKEN: TEST_SETUP_TOKEN,
    });
    // Two sequential requests through the middleware chain (GET /me
    // unauthenticated → 401, but authContext still opens the store):
    // the second must still work, and dispose must never have run.
    const r1 = await spyApp.fetch(
      new Request("http://localhost:8787/api/v1/admin/me"),
      spyEnv
    );
    await r1.text();
    const r2 = await spyApp.fetch(
      new Request("http://localhost:8787/api/v1/admin/me"),
      spyEnv
    );
    await r2.text();
    assert.equal(r1.status, 401);
    assert.equal(r2.status, 401);
    assert.equal(
      disposeCalls,
      0,
      "injected store must never be closed by the request path"
    );
  });

  it("per-request Hono app creation cost is small (informational)", async () => {
    const iterations = 20;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const honoApp = createHonoApp({ env, storeFactory: async () => store });
      const res = await honoApp.fetch(
        new Request("http://localhost:8787/api/v1/health")
      );
      await res.text();
    }
    const elapsed = performance.now() - start;
    const perRequest = elapsed / iterations;
    console.log(
      `[hono-wiring] createHonoApp + GET /health x${iterations}: ` +
        `${elapsed.toFixed(1)}ms total, ${perRequest.toFixed(2)}ms per request`
    );
    // Guardrail, not a perf target: creation must stay in the low-ms
    // range (the store already costs far more per request on staging).
    assert.ok(perRequest < 50, `Hono app creation too slow: ${perRequest}ms/request`);
  });
});
