/**
 * First-admin setup-token gating tests (in-memory test adapter — NOT Postgres).
 *
 * POST /api/auth/bootstrap-super-admin is token-gated by the operator-set
 * SETUP_TOKEN secret (Security, 2026-11-15): without a configured token
 * the endpoint does not exist (404); with one, only the correct token
 * (constant-time compared) may create the one-time super admin. GET
 * /api/v1/setup-status reveals exactly one bit: whether setup is still
 * required. These tests run against the in-memory store, so no DATABASE_URL
 * is needed.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";

// Test-only fixture value (never a real secret): 64 hex chars, the same
// shape the operator generates for the Worker secret.
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("First-admin setup-token gating (in-memory)", () => {
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let envWithoutToken: ReturnType<typeof resolveRuntimeConfig>;

  beforeEach(() => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    envWithoutToken = resolveRuntimeConfig({ APP_ENV: "test" });
    app = createStackMateApp(store);
  });

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown } = {},
    useEnv: ReturnType<typeof resolveRuntimeConfig> = env
  ): Promise<{ status: number; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(
      new Request(`http://localhost:8787${path}`, init),
      useEnv
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async function setupStatus(
    useEnv: ReturnType<typeof resolveRuntimeConfig> = env
  ): Promise<{ status: number; body: any }> {
    return apiRequest("/api/v1/setup-status", {}, useEnv);
  }

  function bootstrapBody(overrides: Record<string, unknown> = {}) {
    return {
      name: "Mahmudul Hasan Riaz",
      email: "admin@stackmate.local",
      password: "SuperAdminPass123!",
      setupToken: TEST_SETUP_TOKEN,
      ...overrides,
    };
  }

  it("setup-status reports setup_required true before any bootstrap", async () => {
    const res = await setupStatus();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.setup_required, true);
    // Exactly one bit: no other fields in the payload.
    assert.deepEqual(Object.keys(res.body.data).sort(), ["setup_required"]);
  });

  it("bootstrap without a setup token is rejected 403 and creates no admin", async () => {
    const { setupToken: _omitted, ...body } = bootstrapBody();
    const res = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body,
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.ok(!JSON.stringify(res.body).includes(TEST_SETUP_TOKEN));
    const after = await setupStatus();
    assert.equal(after.body.data.setup_required, true);
  });

  it("bootstrap with a wrong setup token is rejected 403 and creates no admin", async () => {
    const res = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: bootstrapBody({
        setupToken: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      }),
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.ok(!JSON.stringify(res.body).includes(TEST_SETUP_TOKEN));
    const after = await setupStatus();
    assert.equal(after.body.data.setup_required, true);
  });

  it("bootstrap with the correct setup token succeeds once; setup-status flips to false", async () => {
    const res = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: bootstrapBody(),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.user.email, "admin@stackmate.local");
    assert.deepEqual(res.body.data.roles, ["super_admin"]);
    assert.ok(!("password_hash" in res.body.data.user));
    const after = await setupStatus();
    assert.equal(after.status, 200);
    assert.equal(after.body.data.setup_required, false);
  });

  it("a second bootstrap with the correct token is rejected 409 (single-use)", async () => {
    const first = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: bootstrapBody(),
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: bootstrapBody({ email: "second@stackmate.local" }),
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.error.code, "CONFLICT");
  });

  it("SETUP_TOKEN unset: the bootstrap endpoint does not exist (404), setup-status still answers", async () => {
    const status = await setupStatus(envWithoutToken);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.data.setup_required, true);
    const res = await apiRequest(
      "/api/auth/bootstrap-super-admin",
      { method: "POST", body: bootstrapBody() },
      envWithoutToken
    );
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "NOT_FOUND");
    const after = await setupStatus(envWithoutToken);
    assert.equal(after.body.data.setup_required, true);
  });

  it("correct token but a short password is still rejected 422", async () => {
    const res = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: bootstrapBody({ password: "short" }),
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    const after = await setupStatus();
    assert.equal(after.body.data.setup_required, true);
  });

  it("direct Better Auth email sign-in route is blocked 403 (audit closure)", async () => {
    const res = await apiRequest("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "admin@stackmate.local", password: "SuperAdminPass123!" },
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "FORBIDDEN");
  });

  it("setup-status does not reveal whether a setup token is configured", async () => {
    const withToken = await setupStatus(env);
    const withoutToken = await setupStatus(envWithoutToken);
    assert.deepEqual(withToken.body.data, withoutToken.body.data);
  });
});
