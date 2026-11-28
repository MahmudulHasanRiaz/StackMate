/**
 * OD-13 scoped API-token admin routes (Worker C).
 *
 * Proves the WIRED handlers (POST /api/v1/admin/api-tokens,
 * GET /api/v1/admin/api-tokens, POST /:id/revoke):
 *  - create returns the raw token `value` once (201) and no response
 *    ever carries `token_hash` (or `value` outside create);
 *  - list never returns `value`/`token_hash`;
 *  - an excluded scope (users.manage / api_tokens.manage) or an
 *    unknown scope, or a scope the caller does not hold, is 400/403;
 *  - without `api_tokens.manage` the endpoints are 403;
 *  - revoke is idempotent, unknown ids are 404, and a revoked token
 *    no longer verifies (Worker B auth behaviour, via the service's
 *    verify returning null).
 *
 * Own fresh database (`stackmate_test_api_tokens`) via `setupTestDb`;
 * skips cleanly without DATABASE_URL. Depends on Worker A:
 * `modules/api-tokens/service.ts` + migration 0028 (api_tokens table
 * + `api_tokens.manage` permission). If that module is missing the
 * file fails to load — that is the dependency gap, not a route bug.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  DATABASE_URL,
  setupTestDb,
  SUPER_ACTOR,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import type { StackMateDataStore } from "../src/platform/db/store.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { onErrorHandler } from "../src/middleware/error-handler.ts";
import { registerAdminApiTokensRoutes } from "../src/routes/admin/api-tokens.ts";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
} from "../src/modules/api-tokens/service.ts";
import { resolveTokenPepper } from "../src/modules/identity/service.ts";
import type { StaffPrincipal } from "../src/modules/identity/service.ts";
import type { AppEnv } from "../src/types/context.ts";

const PG_DB_NAME = "stackmate_test_api_tokens";

/** Staff principal WITHOUT api_tokens.manage — every endpoint is 403. */
const LIMITED_ACTOR: StaffPrincipal = {
  user: {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Test Limited Staff",
    email: "limited@stackmate.local",
    status: "active",
    avatar_url: null,
    email_verified: true,
  },
  session_id: "test-session-limited",
  roles: ["support"],
  permissions: ["products.read"],
  two_factor_enabled: false,
  two_factor_setup_required: false,
};

/** Non-super-admin principal WITH api_tokens.manage — can mint only
 * scopes it holds itself (products.read), never excluded/unknown ones. */
const TOKEN_ADMIN_ACTOR: StaffPrincipal = {
  user: {
    id: "00000000-0000-4000-8000-000000000003",
    name: "Test Token Admin",
    email: "token-admin@stackmate.local",
    status: "active",
    avatar_url: null,
    email_verified: true,
  },
  session_id: "test-session-token-admin",
  roles: ["admin"],
  permissions: ["api_tokens.manage", "products.read"],
  two_factor_enabled: false,
  two_factor_setup_required: false,
};

describe.skipIf(!DATABASE_URL)("OD-13 admin API-token routes", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let store: DrizzleStore;
  let app: Hono<AppEnv>;
  let pepper: string | null = null;
  /** The principal the test app's middleware installs per request. */
  let currentPrincipal: StaffPrincipal | null = SUPER_ACTOR;

  beforeAll(async () => {
    const setup = await setupTestDb(PG_DB_NAME);
    cleanup = setup.cleanup;
    store = setup.store;
    // Audit rows FK-reference users: the limited/token-admin actors
    // must exist as user rows or the audited 403 write fails.
    await store.withTransaction((state) => {
      for (const actor of [LIMITED_ACTOR, TOKEN_ADMIN_ACTOR]) {
        state.users.push({
          id: actor.user.id,
          name: actor.user.name,
          email: actor.user.email,
          email_verified: true,
          password_hash: "test-only-hash",
          two_factor_enabled: false,
          status: "active",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    });

    const env = resolveRuntimeConfig({ APP_ENV: "test" });
    pepper = resolveTokenPepper(store as StackMateDataStore, env.ENCRYPTION_KEY_V1) ?? null;

    app = new Hono<AppEnv>();
    app.onError(onErrorHandler);
    app.use("*", async (c, next) => {
      c.set("store", store as StackMateDataStore);
      c.set("env", env);
      c.set("requestId", `req_apitok_${randomUUID().slice(0, 8)}`);
      c.set("principal", currentPrincipal);
      await next();
    });
    registerAdminApiTokensRoutes(app);
  }, 120_000);

  afterAll(async () => {
    try {
      await store.close();
    } catch {}
    await cleanup?.();
  }, 120_000);

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; principal?: StaffPrincipal | null } = {}
  ): Promise<{ status: number; body: any }> {
    currentPrincipal =
      options.principal === undefined ? SUPER_ACTOR : options.principal;
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: { "Content-Type": "application/json" },
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.request(path, init);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  function assertNoHashOrValue(body: unknown, where: string): void {
    const text = JSON.stringify(body);
    assert.ok(!text.includes("token_hash"), `${where}: response must never carry token_hash`);
    assert.ok(!text.includes('"value"'), `${where}: response must never carry a token value`);
  }

  it("create returns the value once (201), never the hash", async () => {
    const { status, body } = await apiRequest("/api/v1/admin/api-tokens", {
      method: "POST",
      body: { name: "Test client", scopes: ["products.read"] },
    });
    assert.equal(status, 201, JSON.stringify(body));
    const token = body.data.token;
    assert.equal(typeof token.id, "string");
    assert.equal(token.name, "Test client");
    assert.equal(typeof token.token_prefix, "string");
    assert.ok(token.token_prefix.length > 0);
    assert.deepEqual(token.scopes, ["products.read"]);
    assert.equal(typeof token.value, "string");
    assert.ok(token.value.length > 0);
    assert.ok(!("token_hash" in token), "create must never return token_hash");
    assert.ok(
      token.value.startsWith(token.token_prefix),
      "value must start with its advertised prefix"
    );
  });

  it("list never returns value or hash", async () => {
    const { status, body } = await apiRequest("/api/v1/admin/api-tokens");
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(Array.isArray(body.data.items));
    assert.ok(body.data.items.length >= 1);
    for (const row of body.data.items) {
      assert.ok(!("token_hash" in row), "list must never return token_hash");
      assert.ok(!("value" in row), "list must never return the token value");
      assert.equal(typeof row.id, "string");
      assert.equal(typeof row.name, "string");
      assert.equal(typeof row.token_prefix, "string");
      assert.ok(Array.isArray(row.scopes));
      assert.ok("revoked_at" in row && "last_used_at" in row && "expires_at" in row);
    }
    assertNoHashOrValue(body, "list");
  });

  it("create with an excluded scope is rejected (400/403)", async () => {
    for (const scope of ["users.manage", "api_tokens.manage"]) {
      const { status } = await apiRequest("/api/v1/admin/api-tokens", {
        method: "POST",
        principal: TOKEN_ADMIN_ACTOR,
        body: { name: "Excluded scope", scopes: [scope] },
      });
      assert.ok(
        status === 400 || status === 403,
        `excluded scope ${scope} must be 400/403, got ${status}`
      );
    }
  });

  it("create with an unknown scope is rejected (400/403)", async () => {
    const { status } = await apiRequest("/api/v1/admin/api-tokens", {
      method: "POST",
      principal: TOKEN_ADMIN_ACTOR,
      body: { name: "Unknown scope", scopes: ["nope.unknown"] },
    });
    assert.ok(status === 400 || status === 403, `unknown scope must be 400/403, got ${status}`);
  });

  it("create with a scope the caller does not hold is rejected (400/403)", async () => {
    const { status } = await apiRequest("/api/v1/admin/api-tokens", {
      method: "POST",
      principal: TOKEN_ADMIN_ACTOR,
      body: { name: "Scope not held", scopes: ["orders.manage"] },
    });
    assert.ok(status === 400 || status === 403, `unheld scope must be 400/403, got ${status}`);
  });

  it("create with a past expires_at is rejected (400)", async () => {
    const { status } = await apiRequest("/api/v1/admin/api-tokens", {
      method: "POST",
      body: {
        name: "Past expiry",
        scopes: ["products.read"],
        expires_at: "2000-01-01T00:00:00.000Z",
      },
    });
    assert.equal(status, 400, "past expires_at must be 400");
  });

  it("create without api_tokens.manage is 403", async () => {
    const { status, body } = await apiRequest("/api/v1/admin/api-tokens", {
      method: "POST",
      principal: LIMITED_ACTOR,
      body: { name: "No permission", scopes: ["products.read"] },
    });
    assert.equal(status, 403, JSON.stringify(body));
    assert.equal(body.error.code, "FORBIDDEN");
  });

  it("list without api_tokens.manage is 403", async () => {
    const { status } = await apiRequest("/api/v1/admin/api-tokens", {
      principal: LIMITED_ACTOR,
    });
    assert.equal(status, 403);
  });

  it("revoke is idempotent, unknown ids are 404, and a revoked token no longer verifies", async () => {
    // Mint directly through the service so the raw value is in hand.
    const { record, value } = await createApiToken(store as StackMateDataStore, {
      name: "Revoke probe",
      scopes: ["products.read"],
      expiresAt: null,
      createdBy: SUPER_ACTOR.user.id,
      pepper,
    });
    // The token verifies before revocation (Worker B auth behaviour).
    const before = await verifyApiToken(store as StackMateDataStore, {
      rawToken: value,
      pepper,
    });
    assert.ok(before !== null, "fresh token must verify before revoke");
    assert.equal(before.id, record.id);

    const first = await apiRequest(`/api/v1/admin/api-tokens/${record.id}/revoke`, {
      method: "POST",
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.data.token.revoked_at, "revoke must set revoked_at");
    assertNoHashOrValue(first.body, "revoke");

    // Second revoke: idempotent 200, same revoked_at.
    const second = await apiRequest(`/api/v1/admin/api-tokens/${record.id}/revoke`, {
      method: "POST",
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.data.token.revoked_at, first.body.data.token.revoked_at);

    // The revoked token no longer verifies — Bearer auth with it fails.
    const after = await verifyApiToken(store as StackMateDataStore, {
      rawToken: value,
      pepper,
    });
    assert.equal(after, null, "revoked token must not verify");

    // The service-level list agrees the token is revoked.
    const rows = await listApiTokens(store as StackMateDataStore);
    const listed = rows.find((r) => r.id === record.id);
    assert.ok(listed?.revoked_at, "list must show revoked_at after revoke");

    const missing = await apiRequest(
      `/api/v1/admin/api-tokens/${randomUUID()}/revoke`,
      { method: "POST" }
    );
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
  });

  it("revoke without api_tokens.manage is 403", async () => {
    const rows = await listApiTokens(store as StackMateDataStore);
    const target = rows.find((r) => !r.revoked_at);
    assert.ok(target, "need an unrevoked token for the 403 probe");
    const { status } = await apiRequest(`/api/v1/admin/api-tokens/${target.id}/revoke`, {
      method: "POST",
      principal: LIMITED_ACTOR,
    });
    assert.equal(status, 403);
    // The 403 did not revoke it.
    const after = await listApiTokens(store as StackMateDataStore);
    assert.equal(after.find((r) => r.id === target.id)?.revoked_at, null);
  });
});
