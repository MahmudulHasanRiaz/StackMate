/**
 * Staff invitations (Batch 1) — in-memory test adapter (NOT Postgres).
 *
 * Covers the full invitation lifecycle that the Postgres suite cannot
 * cover yet: the DrizzleStore has no staff_invitations load/sync wiring
 * (see batch1-invitations-drizzle-wiring.patch), so on Postgres the
 * invitation endpoints fail closed with 503 (asserted in
 * business-workflows.integration.test.ts test 29). The base in-memory
 * store IS the database here, so the lifecycle is fully exercisable:
 *
 *   create (201, token returned once) -> duplicate 409 -> wrong token 401
 *   -> accept 201 (user created with the invited roles) -> token reuse 409
 *   -> revoke -> accept revoked 409 -> expired -> 410 GONE
 *   -> super_admin invite requires a super_admin actor (403)
 *   -> list never leaks token hashes.
 *
 * No email is sent anywhere in this flow (there is no email system yet —
 * Batch 5); the one-time token is returned once so an admin can deliver
 * the accept link out of band.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";

// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Staff invitations (Batch 1, in-memory)", () => {
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let superCookie = "";

  beforeEach(async () => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    app = createStackMateApp(store);
    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Invite Super Admin",
        email: "invite-admin@stackmate.local",
        password: "InviteSuperPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "invite-admin@stackmate.local", password: "InviteSuperPass123!" },
    });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    superCookie = sessionCookieFromHeaders(signIn.headers);
  });

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string } = {}
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (options.cookie) headers.set("Cookie", options.cookie);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(
      new Request(`http://localhost:8787${path}`, init),
      env
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

  async function createSupportRole(): Promise<string> {
    const role = await apiRequest("/api/v1/admin/roles", {
      method: "POST",
      cookie: superCookie,
      body: {
        key: "support_agent",
        name: "Support Agent",
        permissions: ["customers.read", "orders.read"],
      },
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    return role.body.data.id as string;
  }

  async function invite(
    email: string,
    roleKeys: string[] = ["support_agent"]
  ): Promise<{ status: number; body: any }> {
    return apiRequest("/api/v1/admin/users/invitations", {
      method: "POST",
      cookie: superCookie,
      body: { email, name: "Invited Person", role_keys: roleKeys },
    });
  }

  it("creates an invitation and returns the token exactly once (never the hash)", async () => {
    await createSupportRole();
    const res = await invite("invited@stackmate.local");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.data.token_once, "token must be returned once");
    assert.ok(!("token_hash" in res.body.data.invitation), "hash must never leak");
    assert.equal(res.body.data.invitation.status, "pending");
    assert.equal(res.body.data.invitation.email, "invited@stackmate.local");
    // The stored row keeps only the hash, never the raw token.
    const stored = store.state.staff_invitations![0]!;
    assert.equal(stored.status, "pending");
    assert.ok(stored.token_hash && stored.token_hash.length === 64);
    assert.ok(!stored.token_hash.includes(res.body.data.token_once));
  });

  it("rejects a duplicate pending invitation and an invitation for an existing user", async () => {
    await createSupportRole();
    const first = await invite("dup@stackmate.local");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const dup = await invite("dup@stackmate.local");
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    const existing = await invite("invite-admin@stackmate.local");
    assert.equal(existing.status, 409, JSON.stringify(existing.body));
    assert.equal(store.state.staff_invitations!.length, 1);
  });

  it("accepts a valid token, creates the user with the invited roles, and the token cannot be reused", async () => {
    await createSupportRole();
    const created = await invite("joiner@stackmate.local");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const token = created.body.data.token_once as string;

    // Wrong token -> 401, no user created.
    const wrong = await apiRequest("/api/auth/accept-invitation", {
      method: "POST",
      body: { token: "inv_wrongtoken000000000000000000000000", name: "Joiner", password: "JoinerPass123!" },
    });
    assert.equal(wrong.status, 401, JSON.stringify(wrong.body));
    assert.equal(store.state.users.length, 1, "no user may be created by a wrong token");

    // Correct token -> 201 with the invited roles.
    const accepted = await apiRequest("/api/auth/accept-invitation", {
      method: "POST",
      body: { token, name: "Joiner Person", password: "JoinerPass123!" },
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.user.email, "joiner@stackmate.local");
    assert.ok(accepted.body.data.roles.includes("support_agent"));
    assert.equal(store.state.staff_invitations![0]!.status, "accepted");

    // The invitee can sign in with the chosen password.
    const signIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "joiner@stackmate.local", password: "JoinerPass123!" },
    });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));

    // Reusing the same token -> 409.
    const reuse = await apiRequest("/api/auth/accept-invitation", {
      method: "POST",
      body: { token, name: "Joiner Again", password: "JoinerPass123!" },
    });
    assert.equal(reuse.status, 409, JSON.stringify(reuse.body));
  });

  it("revokes an invitation; the revoked token cannot be accepted", async () => {
    await createSupportRole();
    const created = await invite("revokee@stackmate.local");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const token = created.body.data.token_once as string;
    const invitationId = created.body.data.invitation.id as string;

    const revoked = await apiRequest(
      `/api/v1/admin/users/invitations/${invitationId}/revoke`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.data.status, "revoked");
    const again = await apiRequest(
      `/api/v1/admin/users/invitations/${invitationId}/revoke`,
      { method: "POST", cookie: superCookie, body: {} }
    );
    assert.equal(again.status, 409, JSON.stringify(again.body));

    const accept = await apiRequest("/api/auth/accept-invitation", {
      method: "POST",
      body: { token, name: "Revokee", password: "RevokeePass123!" },
    });
    assert.equal(accept.status, 409, JSON.stringify(accept.body));
    assert.equal(store.state.users.length, 1);
  });

  it("returns 410 GONE for an expired invitation", async () => {
    await createSupportRole();
    const created = await invite("stale@stackmate.local");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const token = created.body.data.token_once as string;
    // Time-travel the stored invitation past its expiry.
    store.state.staff_invitations![0]!.expires_at = new Date(
      Date.now() - 60_000
    ).toISOString();
    const accept = await apiRequest("/api/auth/accept-invitation", {
      method: "POST",
      body: { token, name: "Stale Person", password: "StalePass123!" },
    });
    assert.equal(accept.status, 410, JSON.stringify(accept.body));
    assert.equal(accept.body.error.code, "GONE");
    assert.equal(store.state.users.length, 1);
  });

  it("forbids a non-super-admin from inviting a super_admin", async () => {
    await createSupportRole();
    // Staff user with only the support role.
    const staff = await apiRequest("/api/v1/admin/users", {
      method: "POST",
      cookie: superCookie,
      body: {
        name: "Support Staff",
        email: "support@stackmate.local",
        password: "SupportPass123!",
        role_keys: ["support_agent"],
      },
    });
    assert.equal(staff.status, 201, JSON.stringify(staff.body));
    const staffSignIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "support@stackmate.local", password: "SupportPass123!" },
    });
    assert.equal(staffSignIn.status, 200, JSON.stringify(staffSignIn.body));
    const staffCookie = sessionCookieFromHeaders(staffSignIn.headers);

    const attempt = await apiRequest("/api/v1/admin/users/invitations", {
      method: "POST",
      cookie: staffCookie,
      body: { email: "evil@stackmate.local", name: "Evil", role_keys: ["super_admin"] },
    });
    assert.equal(attempt.status, 403, JSON.stringify(attempt.body));
    assert.equal(store.state.staff_invitations!.length, 0);
  });

  it("lists invitations without ever leaking token hashes", async () => {
    await createSupportRole();
    const created = await invite("listed@stackmate.local");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const list = await apiRequest("/api/v1/admin/users/invitations", { cookie: superCookie });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.items.length, 1);
    assert.ok(!("token_hash" in list.body.data.items[0]));
    assert.equal(list.body.data.items[0].email, "listed@stackmate.local");
  });
});
