/**
 * Better Auth unification tests (Postgres-backed, hermetic).
 *
 * Better Auth is the single authentication authority: staff sign-in,
 * session validation, sign-out and password change all go through
 * Better Auth sessions (Drizzle `sessions` table). The StackMate staff
 * record (roles/permissions/status) is joined by email and re-checked
 * on every request.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres, e.g.:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test
 * The suite creates its OWN fresh database `stackmate_test_auth` on the
 * same server (derived from DATABASE_URL), applies every journal
 * migration there, and DROPS it afterwards — so bootstrap is
 * deterministic and no other suite's data can interfere. Without
 * DATABASE_URL the whole suite SKIPS cleanly.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import {
  ensureBetterAuthIdentity,
  hashPasswordScrypt,
} from "../src/modules/identity/service.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const AUTH_DB_NAME = "stackmate_test_auth";
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);

if (!DATABASE_URL) {
  console.log(
    "[better-auth-unified] DATABASE_URL is not set — skipping. " +
      "Set DATABASE_URL to a local test Postgres to run it."
  );
}

const uniq = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!DATABASE_URL)("Better Auth unified staff auth (Postgres)", () => {
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let app: ReturnType<typeof createStackMateApp>;
  let store: any;
  let adminClient: Client;
  let maintenanceClient: Client;
  let authDbUrl: string;

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string; token?: string } = {}
  ): Promise<{ status: number; headers: Headers; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(
      new Request(`http://localhost:8787${path}`, init),
      env
    );
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  }

  function extractSessionCookie(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    const pair = setCookies.find((c) => c.startsWith("better-auth.session_token="));
    assert.ok(pair, "sign-in must set a better-auth.session_token cookie");
    return pair!.split(";")[0]!;
  }

  async function signIn(email: string, password: string) {
    const res = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(res.status, 200, `sign-in failed for ${email}: ${JSON.stringify(res.body)}`);
    const token = res.body.data.session_token as string;
    assert.ok(token, "sign-in must return a session_token");
    return { token, cookie: extractSessionCookie(res.headers), principal: res.body.data.principal };
  }

  async function countRows(sql: string, params: unknown[] = []): Promise<number> {
    const result = await adminClient.query(sql, params);
    return Number(result.rows[0].count);
  }

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const url = new URL(DATABASE_URL);
    assert.ok(
      url.pathname.replace(/^\//, "").includes("test"),
      "Refusing to run: DATABASE_URL database name must contain 'test'."
    );
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });

    // Fresh, hermetic database for this suite.
    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${AUTH_DB_NAME}"`);
    await maintenanceClient.query(`CREATE DATABASE "${AUTH_DB_NAME}"`);
    await maintenanceClient.end();

    const authUrl = new URL(DATABASE_URL);
    authUrl.pathname = `/${AUTH_DB_NAME}`;
    authDbUrl = authUrl.toString();

    adminClient = new Client({ connectionString: authDbUrl });
    await adminClient.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      await adminClient.query(sql);
    }

    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
    store = await DrizzleStore.create({ connectionString: authDbUrl });
    app = createStackMateApp(store);
  }, 120_000);

  afterAll(async () => {
    try {
      await store?.close();
    } catch {}
    try {
      await adminClient?.end();
    } catch {}
    try {
      const maintenanceUrl = new URL(DATABASE_URL!);
      maintenanceUrl.pathname = "/postgres";
      const mc = new Client({ connectionString: maintenanceUrl.toString() });
      await mc.connect();
      await mc.query(`DROP DATABASE IF EXISTS "${AUTH_DB_NAME}"`);
      await mc.end();
    } catch {}
  });

  it("bootstrap provisions a Better Auth identity for the super admin", async () => {
    const email = `${uniq("super")}@example.com`;
    const res = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: { name: "Super Admin", email, password: "SuperAdminPass123!", setupToken: TEST_SETUP_TOKEN },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(
      await countRows("SELECT COUNT(*) AS count FROM users WHERE email = $1", [email]),
      1,
      "a Better Auth user row must exist for the bootstrapped staff email"
    );
    const baUser = await adminClient.query("SELECT id FROM users WHERE email = $1", [email]);
    assert.equal(
      await countRows(
        "SELECT COUNT(*) AS count FROM accounts WHERE user_id = $1 AND provider_id = 'credential'",
        [baUser.rows[0].id]
      ),
      1,
      "a credential account must exist for the bootstrapped staff email"
    );
  });

  it("sign-in goes through Better Auth; cookie + bearer both authorize /me", async () => {
    const email = `${uniq("staff")}@example.com`;
    // Create the staff record via the super-admin bootstrap of a second
    // admin is not possible (bootstrap is one-time), so create this staff
    // user directly in the store with a scrypt hash and no BA identity:
    // sign-in must lazily migrate it (covered again below).
    const { randomUUID } = await import("node:crypto");
    const userId = randomUUID();
    const now = new Date().toISOString();
    await store.withTransaction((state: any) => {
      state.users.push({
        id: userId,
        name: "Cookie Staff",
        email,
        email_verified: true,
        password_hash: hashPasswordScrypt("CookieStaffPass123!"),
        status: "active",
        created_at: now,
        updated_at: now,
      });
      const role = state.roles.find((r: any) => r.key === "super_admin");
      state.user_roles.push({ user_id: userId, role_id: role.id, assigned_at: now });
    });

    const signedIn = await signIn(email, "CookieStaffPass123!");
    assert.deepEqual(signedIn.principal.user.email, email);
    assert.ok(signedIn.principal.roles.includes("super_admin"));

    const byCookie = await apiRequest("/api/v1/admin/me", { cookie: signedIn.cookie });
    assert.equal(byCookie.status, 200, JSON.stringify(byCookie.body));
    assert.equal(byCookie.body.data.user.email, email);

    const byBearer = await apiRequest("/api/v1/admin/me", { token: signedIn.token });
    assert.equal(byBearer.status, 200, JSON.stringify(byBearer.body));

    const session = await apiRequest("/api/auth/session", { cookie: signedIn.cookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.data.principal.user.email, email);

    // The session row is a Better Auth session in the Drizzle table.
    assert.equal(
      await countRows("SELECT COUNT(*) AS count FROM sessions WHERE token = $1", [
        signedIn.token,
      ]),
      1
    );
  });

  it("public self-registration is blocked and creates no identity", async () => {
    const email = `${uniq("attacker")}@example.com`;
    const res = await apiRequest("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "Attacker", email, password: "AttackerPass123!" },
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(
      await countRows("SELECT COUNT(*) AS count FROM users WHERE email = $1", [email]),
      0
    );
  });

  it("wrong password and unknown email are rejected; no identity is created", async () => {
    const email = `${uniq("victim")}@example.com`;
    const { randomUUID } = await import("node:crypto");
    const victimId = randomUUID();
    const now = new Date().toISOString();
    await store.withTransaction((state: any) => {
      state.users.push({
        id: victimId,
        name: "Victim",
        email,
        email_verified: true,
        password_hash: hashPasswordScrypt("CorrectPass123!"),
        status: "active",
        created_at: now,
        updated_at: now,
      });
    });
    const wrong = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email, password: "WrongPass123!" },
    });
    assert.equal(wrong.status, 401);
    assert.equal(
      await countRows(
        "SELECT COUNT(*) AS count FROM accounts WHERE user_id = $1 AND provider_id = 'credential'",
        [victimId]
      ),
      0,
      "a failed sign-in must never provision a Better Auth credential"
    );
    const unknown = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: `${uniq("nobody")}@example.com`, password: "Whatever123!" },
    });
    assert.equal(unknown.status, 401);
  });

  it("lazy migration: legacy scrypt staff signs in once and is never duplicated", async () => {
    const email = `${uniq("legacy")}@example.com`;
    const { randomUUID } = await import("node:crypto");
    const legacyId = randomUUID();
    const now = new Date().toISOString();
    await store.withTransaction((state: any) => {
      state.users.push({
        id: legacyId,
        name: "Legacy Staff",
        email,
        email_verified: true,
        password_hash: hashPasswordScrypt("LegacyPass123!"),
        status: "active",
        created_at: now,
        updated_at: now,
      });
      const role = state.roles.find((r: any) => r.key === "read_only");
      state.user_roles.push({
        user_id: legacyId,
        role_id: role.id,
        assigned_at: now,
      });
    });
    const credentialCount = () =>
      countRows(
        "SELECT COUNT(*) AS count FROM accounts WHERE user_id = $1 AND provider_id = 'credential'",
        [legacyId]
      );
    assert.equal(
      await credentialCount(),
      0,
      "precondition: no Better Auth credential yet"
    );
    const first = await signIn(email, "LegacyPass123!");
    assert.equal(first.principal.user.email, email);
    assert.equal(
      await credentialCount(),
      1,
      "first sign-in must provision exactly one Better Auth credential"
    );
    await signIn(email, "LegacyPass123!");
    await signIn(email, "LegacyPass123!");
    assert.equal(
      await credentialCount(),
      1,
      "repeated sign-ins must never duplicate the credential"
    );

    // ensureBetterAuthIdentity is idempotent when called directly.
    const legacyUser = (
      await adminClient.query("SELECT id FROM users WHERE email = $1", [email])
    ).rows[0];
    const again = await ensureBetterAuthIdentity(store, {
      userId: legacyUser.id,
      email,
      password: "LegacyPass123!",
    });
    assert.deepEqual(
      again,
      { provisioned: false },
      "re-provisioning an existing credential returns provisioned:false"
    );
  });

  it("a suspended user fails validation even with a live session", async () => {
    const email = `${uniq("suspended")}@example.com`;
    const { randomUUID } = await import("node:crypto");
    const userId = randomUUID();
    const now = new Date().toISOString();
    await store.withTransaction((state: any) => {
      state.users.push({
        id: userId,
        name: "Soon Suspended",
        email,
        email_verified: true,
        password_hash: hashPasswordScrypt("SuspendPass123!"),
        status: "active",
        created_at: now,
        updated_at: now,
      });
      const role = state.roles.find((r: any) => r.key === "read_only");
      state.user_roles.push({ user_id: userId, role_id: role.id, assigned_at: now });
    });
    const signedIn = await signIn(email, "SuspendPass123!");
    const meBefore = await apiRequest("/api/v1/admin/me", { cookie: signedIn.cookie });
    assert.equal(meBefore.status, 200);

    await store.withTransaction((state: any) => {
      const u = state.users.find((x: any) => x.id === userId);
      u.status = "suspended";
      u.updated_at = new Date().toISOString();
    });

    const meAfter = await apiRequest("/api/v1/admin/me", { cookie: signedIn.cookie });
    assert.equal(meAfter.status, 401, "live session must stop working after suspension");
    const signInAgain = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email, password: "SuspendPass123!" },
    });
    assert.equal(signInAgain.status, 403, "suspended staff cannot sign in");
  });

  it("sign-out revokes the session; signing in again works", async () => {
    const email = `${uniq("logout")}@example.com`;
    const { randomUUID } = await import("node:crypto");
    const now = new Date().toISOString();
    await store.withTransaction((state: any) => {
      state.users.push({
        id: randomUUID(),
        name: "Logout Staff",
        email,
        email_verified: true,
        password_hash: hashPasswordScrypt("LogoutPass123!"),
        status: "active",
        created_at: now,
        updated_at: now,
      });
      const role = state.roles.find((r: any) => r.key === "read_only");
      state.user_roles.push({
        user_id: state.users[state.users.length - 1].id,
        role_id: role.id,
        assigned_at: now,
      });
    });
    const signedIn = await signIn(email, "LogoutPass123!");
    const out = await apiRequest("/api/auth/sign-out", {
      method: "POST",
      cookie: signedIn.cookie,
    });
    assert.equal(out.status, 200);
    assert.equal(
      await countRows("SELECT COUNT(*) AS count FROM sessions WHERE token = $1", [
        signedIn.token,
      ]),
      0,
      "the session row must be gone after sign-out"
    );
    const meAfter = await apiRequest("/api/v1/admin/me", { cookie: signedIn.cookie });
    assert.equal(meAfter.status, 401);
    const again = await signIn(email, "LogoutPass123!");
    assert.equal(again.principal.user.email, email);
  });

  it("password change revokes other sessions; old password stops working", async () => {
    const email = `${uniq("pwchange")}@example.com`;
    const { randomUUID } = await import("node:crypto");
    const now = new Date().toISOString();
    await store.withTransaction((state: any) => {
      state.users.push({
        id: randomUUID(),
        name: "Pw Change",
        email,
        email_verified: true,
        password_hash: hashPasswordScrypt("OldPass12345!"),
        status: "active",
        created_at: now,
        updated_at: now,
      });
      const role = state.roles.find((r: any) => r.key === "read_only");
      state.user_roles.push({
        user_id: state.users[state.users.length - 1].id,
        role_id: role.id,
        assigned_at: now,
      });
    });
    const sessionA = await signIn(email, "OldPass12345!");
    const sessionB = await signIn(email, "OldPass12345!");
    assert.notEqual(sessionA.token, sessionB.token);

    const changed = await apiRequest("/api/auth/change-password", {
      method: "POST",
      cookie: sessionA.cookie,
      body: { current_password: "OldPass12345!", new_password: "NewPass12345!" },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    const bAfter = await apiRequest("/api/v1/admin/me", { cookie: sessionB.cookie });
    assert.equal(bAfter.status, 401, "the other session must be revoked by password change");
    const aAfter = await apiRequest("/api/v1/admin/me", { cookie: sessionA.cookie });
    assert.equal(aAfter.status, 200, "the session used for the change stays valid");

    const oldPw = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email, password: "OldPass12345!" },
    });
    assert.equal(oldPw.status, 401, "old password must stop working");
    const newPw = await signIn(email, "NewPass12345!");
    assert.equal(newPw.principal.user.email, email);
  });

  it("a role change revokes the staff member's Better Auth sessions", async () => {
    // Super admin signs in (bootstrap created one in the first test).
    // The bootstrapped super admin's password is known to this suite.
    const superEmail = (await adminClient.query(
      "SELECT email FROM users ORDER BY created_at ASC LIMIT 1"
    )).rows[0].email as string;
    const superSession = await signIn(superEmail, "SuperAdminPass123!");

    const staffEmail = `${uniq("rolechange")}@example.com`;
    const created = await apiRequest("/api/v1/admin/users", {
      method: "POST",
      cookie: superSession.cookie,
      body: {
        name: "Role Change",
        email: staffEmail,
        password: "RolePass12345!",
        role_keys: ["read_only"],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const staffUserId = created.body.data.user.id as string;

    const staffSession = await signIn(staffEmail, "RolePass12345!");
    const meBefore = await apiRequest("/api/v1/admin/me", { cookie: staffSession.cookie });
    assert.equal(meBefore.status, 200);

    const updated = await apiRequest(`/api/v1/admin/users/${staffUserId}/roles`, {
      method: "PUT",
      cookie: superSession.cookie,
      body: { role_keys: ["support_staff"] },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.ok(
      (updated.body.data.revoked_sessions as number) >= 1,
      "role change must report revoked sessions"
    );

    const meAfter = await apiRequest("/api/v1/admin/me", { cookie: staffSession.cookie });
    assert.equal(meAfter.status, 401, "role change must revoke the staff session");
    const again = await signIn(staffEmail, "RolePass12345!");
    assert.deepEqual(again.principal.roles, ["support_staff"]);
  });
});
