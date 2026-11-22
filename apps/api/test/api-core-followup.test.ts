/**
 * API-core follow-up tests (audit fix batch, parent handoff 2026-11-19).
 *
 * Covers the app.ts wiring the API-AUTH agent's service work depends on:
 *  - M-10: the /api/auth/* Better Auth fallback gate
 *    (checkBetterAuthFallbackAccess) is actually called before
 *    auth.handler — unknown paths 404, session paths 401 without a
 *    session, public paths pass through to Better Auth.
 *  - H-3: PATCH /api/v1/admin/users/:userId/suspend + /unsuspend
 *    routes exist and call suspendStaffUser / unsuspendStaffUser.
 *
 * In-memory store only (no Postgres needed). The service-level
 * behaviour behind these routes is covered by the auth agent in
 * audit-identity-auth-fixes.test.ts (H-3 lifecycle, M-10 path sets,
 * recordTwoFactorStateChange audit rows); these tests prove the
 * ROUTES are wired to those services.
 */
import { describe, it, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";

// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("API-core follow-up: M-10 fallback gate + H-3 suspend routes", () => {
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let superCookie = "";
  let superUserId = "";
  let targetUserId = "";

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string } = {}
  ): Promise<{ status: number; body: any }> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (options.cookie) headers.set("Cookie", options.cookie);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(new Request(`http://localhost:8787${path}`, init), env);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  beforeAll(async () => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    app = createStackMateApp(store);
    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Followup Super Admin",
        email: "followup-admin@stackmate.local",
        password: "FollowupSuperPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    superUserId = boot.body.data.user.id;
    const signIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "followup-admin@stackmate.local", password: "FollowupSuperPass123!" },
    });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    superCookie = `stackmate_session=${signIn.body.data.session_token}`;

    const target = await apiRequest("/api/v1/admin/users", {
      method: "POST",
      cookie: superCookie,
      body: {
        name: "Suspend Target",
        email: "suspend-target@stackmate.local",
        password: "SuspendTargetPass123!",
        role_keys: ["read_only"],
      },
    });
    assert.equal(target.status, 201, JSON.stringify(target.body));
    targetUserId = target.body.data.user.id;
  });

  it("M-10: GET /api/auth/get-session without a session is 401 from the gate", async () => {
    const res = await apiRequest("/api/auth/get-session");
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  it("M-10: POST /api/auth/delete-user with a session is 404 (unknown fallback path)", async () => {
    const res = await apiRequest("/api/auth/delete-user", {
      method: "POST",
      cookie: superCookie,
      body: {},
    });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "NOT_FOUND");
  });

  it("M-10: POST /api/auth/two-factor/verify-totp without a session passes the gate to Better Auth", async () => {
    const res = await apiRequest("/api/auth/two-factor/verify-totp", {
      method: "POST",
      body: { code: "123456" },
    });
    // The gate's 401 is the StackMate UNAUTHORIZED envelope. Better Auth
    // answers this public path itself (missing verification session) —
    // whatever its status, it must NOT be the gate's 401.
    assert.ok(
      !(res.status === 401 && res.body?.error?.code === "UNAUTHORIZED"),
      `public path must not be gate-401d: ${JSON.stringify(res.body)}`
    );
  });

  it("H-3: PATCH suspend flips the user to suspended, then unsuspend restores active", async () => {
    const suspended = await apiRequest(`/api/v1/admin/users/${targetUserId}/suspend`, {
      method: "PATCH",
      cookie: superCookie,
      body: {},
    });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.data.user_id, targetUserId);
    assert.equal(suspended.body.data.status, "suspended");

    const detail = await apiRequest(`/api/v1/admin/users/${targetUserId}`, {
      cookie: superCookie,
    });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.status, "suspended");

    const again = await apiRequest(`/api/v1/admin/users/${targetUserId}/suspend`, {
      method: "PATCH",
      cookie: superCookie,
      body: {},
    });
    assert.equal(again.status, 409, JSON.stringify(again.body));

    const restored = await apiRequest(`/api/v1/admin/users/${targetUserId}/unsuspend`, {
      method: "PATCH",
      cookie: superCookie,
      body: {},
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.data.status, "active");
  });

  it("H-3: suspending yourself is 409", async () => {
    const res = await apiRequest(`/api/v1/admin/users/${superUserId}/suspend`, {
      method: "PATCH",
      cookie: superCookie,
      body: {},
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
  });

  it("H-3: suspending an unknown user is 404", async () => {
    const res = await apiRequest("/api/v1/admin/users/00000000-0000-0000-0000-000000000000/suspend", {
      method: "PATCH",
      cookie: superCookie,
      body: {},
    });
    assert.equal(res.status, 404, JSON.stringify(res.body));
  });

  it("H-3: a staff user without users.manage cannot suspend (403, audited denial)", async () => {
    const staffSignIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "suspend-target@stackmate.local", password: "SuspendTargetPass123!" },
    });
    assert.equal(staffSignIn.status, 200, JSON.stringify(staffSignIn.body));
    const staffCookie = `stackmate_session=${staffSignIn.body.data.session_token}`;
    const res = await apiRequest(`/api/v1/admin/users/${superUserId}/suspend`, {
      method: "PATCH",
      cookie: staffCookie,
      body: {},
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });
});
