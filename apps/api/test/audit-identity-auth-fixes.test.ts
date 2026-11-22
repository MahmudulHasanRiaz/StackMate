/**
 * Audit fix-batch tests — identity/auth (API H-2/H-3/H-4, M-10/M-12/M-13/
 * M-14/M-21, L-2/L-3) + the Postgres token tests (M-11/L-2/L-3).
 *
 * In-memory describe: runs everywhere (test-adapter store + app.fetch).
 * Postgres describe: skips cleanly without DATABASE_URL (same pattern as
 * better-auth-unified.test.ts); run with e.g.:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test
 */
import { describe, it, beforeEach, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  checkBetterAuthFallbackAccess,
  createStaffUserByAdmin,
  changeStaffPassword,
  recordTwoFactorStateChange,
  suspendStaffUser,
  unsuspendStaffUser,
  type StaffPrincipal,
} from "../src/modules/identity/service.ts";
import { AppError } from "../src/shared/errors.ts";

// Test-only fixture value (never a real secret).
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const uniq = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function apiRequest(
  app: ReturnType<typeof createStackMateApp>,
  env: ReturnType<typeof resolveRuntimeConfig>,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {}
): Promise<{ status: number; body: any }> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.cookie) headers.set("Cookie", options.cookie);
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await app.fetch(new Request(`http://localhost:8787${path}`, init), env);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

describe("Audit identity/auth fixes (in-memory)", () => {
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let superCookie = "";
  let superPrincipal: StaffPrincipal;

  beforeEach(async () => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    app = createStackMateApp(store);
    const boot = await apiRequest(app, env, "/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Fix Super Admin",
        email: "fix-admin@stackmate.local",
        password: "FixSuperPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signIn = await apiRequest(app, env, "/api/auth/sign-in", {
      method: "POST",
      body: { email: "fix-admin@stackmate.local", password: "FixSuperPass123!" },
    });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    superCookie = `stackmate_session=${signIn.body.data.session_token}`;
    superPrincipal = signIn.body.data.principal as StaffPrincipal;
    assert.ok(superPrincipal.roles.includes("super_admin"));
  });

  async function createUserViaApp(
    body: unknown
  ): Promise<{ status: number; body: any }> {
    return apiRequest(app, env, "/api/v1/admin/users", {
      method: "POST",
      body,
      cookie: superCookie,
    });
  }

  // -- H-4: staff creation validation ------------------------------------
  it("H-4: 1-char password is rejected 422 (was 201)", async () => {
    const res = await createUserViaApp({
      name: "Short Pass",
      email: "short-pass@stackmate.local",
      password: "x",
      role_keys: [],
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(store.state.users.some((u) => u.email === "short-pass@stackmate.local"), false);
  });

  it("H-4: malformed email is rejected 422 (was 201)", async () => {
    const res = await createUserViaApp({
      name: "Bad Email",
      email: "not-an-email",
      password: "ValidPass123!",
      role_keys: [],
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
  });

  it("H-4: missing fields are rejected 422, never 500", async () => {
    const res = await createUserViaApp({ name: "Only Name" });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    const empty = await createUserViaApp({});
    assert.equal(empty.status, 422, JSON.stringify(empty.body));
  });

  it("H-4: role_keys as a string is rejected 422, never 500", async () => {
    const res = await createUserViaApp({
      name: "String Roles",
      email: "string-roles@stackmate.local",
      password: "ValidPass123!",
      role_keys: "super_admin",
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
  });

  it("H-4: valid input still creates the user (201) with an audit row", async () => {
    const res = await createUserViaApp({
      name: "Valid User",
      email: "valid-user@stackmate.local",
      password: "ValidPass123!",
      role_keys: [],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.user.email, "valid-user@stackmate.local");
    const audit = store.state.audit_logs.find(
      (a) => a.action === "identity.user.created" && a.resource_id === res.body.data.user.id
    );
    assert.ok(audit, "identity.user.created audit row must exist");
  });

  it("H-4: unknown role key is rejected 422", async () => {
    const res = await createUserViaApp({
      name: "Unknown Role",
      email: "unknown-role@stackmate.local",
      password: "ValidPass123!",
      role_keys: ["no_such_role"],
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
  });

  // -- H-3: suspend / unsuspend ------------------------------------------
  async function makeActiveUser(email: string): Promise<{ id: string; cookie: string; principal: StaffPrincipal }> {
    const created = await createUserViaApp({
      name: "Suspend Target",
      email,
      password: "TargetPass123!",
      role_keys: [],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const signIn = await apiRequest(app, env, "/api/auth/sign-in", {
      method: "POST",
      body: { email, password: "TargetPass123!" },
    });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    return {
      id: created.body.data.user.id as string,
      cookie: `stackmate_session=${signIn.body.data.session_token}`,
      principal: signIn.body.data.principal as StaffPrincipal,
    };
  }

  it("H-3: suspend flips status, revokes sessions, audits; unsuspend restores sign-in", async () => {
    const target = await makeActiveUser("suspend-me@stackmate.local");
    const me = await apiRequest(app, env, "/api/v1/admin/me", { cookie: target.cookie });
    assert.equal(me.status, 200, "target must be signed in before suspend");

    const suspended = await suspendStaffUser(store, superPrincipal, target.id, "req-suspend-1");
    assert.equal(suspended.status, "suspended");
    assert.ok(suspended.revoked_sessions >= 1, "at least the live session must be revoked");
    assert.equal(
      store.state.users.find((u) => u.id === target.id)?.status,
      "suspended"
    );
    assert.equal(
      store.state.sessions.some((s) => s.user_id === target.id),
      false,
      "no session rows may survive suspend"
    );
    const audit = store.state.audit_logs.find(
      (a) => a.action === "identity.user.suspended" && a.resource_id === target.id
    );
    assert.ok(audit, "identity.user.suspended audit row must exist");

    const meAfter = await apiRequest(app, env, "/api/v1/admin/me", { cookie: target.cookie });
    assert.equal(meAfter.status, 401, "suspended session must stop validating");

    const again = await suspendStaffUser(store, superPrincipal, target.id, "req-suspend-2").then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(again instanceof AppError && again.statusCode === 409, "double suspend must 409");

    const unsuspended = await unsuspendStaffUser(store, superPrincipal, target.id, "req-unsuspend-1");
    assert.equal(unsuspended.status, "active");
    assert.ok(
      store.state.audit_logs.some(
        (a) => a.action === "identity.user.unsuspended" && a.resource_id === target.id
      ),
      "identity.user.unsuspended audit row must exist"
    );
    const signInAgain = await apiRequest(app, env, "/api/auth/sign-in", {
      method: "POST",
      body: { email: "suspend-me@stackmate.local", password: "TargetPass123!" },
    });
    assert.equal(signInAgain.status, 200, "unsuspended user must sign in again");

    const unsuspendActive = await unsuspendStaffUser(store, superPrincipal, target.id, "req-unsuspend-2").then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(
      unsuspendActive instanceof AppError && unsuspendActive.statusCode === 409,
      "unsuspending an active user must 409"
    );
  });

  it("H-3: suspending yourself is rejected 409", async () => {
    const selfId = superPrincipal.user.id;
    const err = await suspendStaffUser(store, superPrincipal, selfId, "req-self").then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof AppError && err.statusCode === 409);
    assert.equal(store.state.users.find((u) => u.id === selfId)?.status, "active");
  });

  it("H-3: suspending an unknown user is 404", async () => {
    const err = await suspendStaffUser(store, superPrincipal, randomUUID(), "req-404").then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof AppError && err.statusCode === 404);
  });

  // -- H-2: media permissions grantable ----------------------------------
  it("H-2: a custom role can now be granted media.view / media.manage", async () => {
    const view = await apiRequest(app, env, "/api/v1/admin/roles", {
      method: "POST",
      body: { key: "media_viewer", name: "Media Viewer", permissions: ["media.view"] },
      cookie: superCookie,
    });
    assert.equal(view.status, 201, JSON.stringify(view.body));
    const manage = await apiRequest(app, env, "/api/v1/admin/roles", {
      method: "POST",
      body: { key: "media_manager", name: "Media Manager", permissions: ["media.manage", "media.view"] },
      cookie: superCookie,
    });
    assert.equal(manage.status, 201, JSON.stringify(manage.body));
    const unknown = await apiRequest(app, env, "/api/v1/admin/roles", {
      method: "POST",
      body: { key: "bad_role", name: "Bad", permissions: ["no.such.permission"] },
      cookie: superCookie,
    });
    assert.equal(unknown.status, 422, "unknown permission keys must still 422");
  });

  // -- M-10: Better Auth fallback gate ------------------------------------
  it("M-10: public fallback paths need no session; unknown paths 404", async () => {
    const verify = await checkBetterAuthFallbackAccess(store, {
      pathname: "/api/auth/two-factor/verify-totp",
    });
    assert.equal(verify.principal, null);
    const callback = await checkBetterAuthFallbackAccess(store, {
      pathname: "/api/auth/callback/google",
    });
    assert.equal(callback.principal, null);
    const social = await checkBetterAuthFallbackAccess(store, {
      pathname: "/api/auth/sign-in/social",
    });
    assert.equal(social.principal, null);

    const denied = await checkBetterAuthFallbackAccess(store, {
      pathname: "/api/auth/change-password",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(denied instanceof AppError && denied.statusCode === 404, "raw BA change-password must 404");
    const deleteUser = await checkBetterAuthFallbackAccess(store, {
      pathname: "/api/auth/delete-user",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(deleteUser instanceof AppError && deleteUser.statusCode === 404);
  });

  it("M-10: session paths need a live session; suspended sessions fail", async () => {
    const noSession = await checkBetterAuthFallbackAccess(store, {
      pathname: "/api/auth/update-user",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(noSession instanceof AppError && noSession.statusCode === 401);

    const target = await makeActiveUser("fallback-user@stackmate.local");
    const allowed = await checkBetterAuthFallbackAccess(store, {
      cookieHeader: target.cookie,
      pathname: "/api/auth/update-user",
    });
    assert.equal(allowed.principal?.user.email, "fallback-user@stackmate.local");

    await suspendStaffUser(store, superPrincipal, target.id, "req-fallback-suspend");
    const suspended = await checkBetterAuthFallbackAccess(store, {
      cookieHeader: target.cookie,
      pathname: "/api/auth/update-user",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(suspended instanceof AppError && suspended.statusCode === 401, "suspended session must not pass the gate");
  });

  it("M-10: a 2FA-setup-restricted session may use only setup paths", async () => {
    const target = await makeActiveUser("restricted-user@stackmate.local");
    // Global policy: 2FA required for every role.
    store.state.two_factor_policy.push({
      id: randomUUID(),
      scope: "global",
      mode: "required",
      updated_at: new Date().toISOString(),
    });
    const restricted = await checkBetterAuthFallbackAccess(store, {
      cookieHeader: target.cookie,
      pathname: "/api/auth/update-user",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(
      restricted instanceof AppError &&
        restricted.statusCode === 403 &&
        restricted.code === "TWO_FACTOR_SETUP_REQUIRED",
      `restricted session must 403 TWO_FACTOR_SETUP_REQUIRED on update-user, got ${JSON.stringify(restricted)}`
    );
    const setup = await checkBetterAuthFallbackAccess(store, {
      cookieHeader: target.cookie,
      pathname: "/api/auth/two-factor/enable",
    });
    assert.equal(setup.principal?.user.email, "restricted-user@stackmate.local");
    const session = await checkBetterAuthFallbackAccess(store, {
      cookieHeader: target.cookie,
      pathname: "/api/auth/get-session",
    });
    assert.equal(session.principal?.user.email, "restricted-user@stackmate.local");
  });

  // -- M-13: change-password revocation failure ---------------------------
  it("M-13: a revocation failure after a successful change is a 500, never a 401", async () => {
    const target = await makeActiveUser("change-pass@stackmate.local");
    // Enter the Better Auth branch with a stubbed auth object: the
    // store carries a (dummy) drizzleDb so storeSupportsBetterAuth is
    // true, but no real Postgres is involved — the stubbed api methods
    // are the only Better Auth surface touched.
    (store as unknown as { drizzleDb: unknown }).drizzleDb = {};
    const stubAuth = {
      api: {
        changePassword: async () => ({ user: { id: target.id } }),
        revokeOtherSessions: async () => {
          throw new Error("revocation backend down");
        },
      },
    };
    const err = await changeStaffPassword(store, target.principal, {
      auth: stubAuth as never,
      cookieHeader: target.cookie,
      currentPassword: "TargetPass123!",
      newPassword: "NewTargetPass123!",
      requestId: "req-change-1",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.statusCode, 500, `expected 500, got ${err.statusCode}: ${err.message}`);
    assert.match(err.message, /Password was changed, but other sessions could not be revoked/);
    // The password WAS changed (hash synced) even though the response
    // is a 500 — the caller must not retry with the old password.
    // Remove the stub drizzleDb first so the app sign-in goes back
    // through the test adapter (a dummy {} would break the real
    // Better Auth path).
    delete (store as unknown as { drizzleDb?: unknown }).drizzleDb;
    const signInNew = await apiRequest(app, env, "/api/auth/sign-in", {
      method: "POST",
      body: { email: "change-pass@stackmate.local", password: "NewTargetPass123!" },
    });
    assert.equal(signInNew.status, 200, "new password must work after the 500");
    const signInOld = await apiRequest(app, env, "/api/auth/sign-in", {
      method: "POST",
      body: { email: "change-pass@stackmate.local", password: "TargetPass123!" },
    });
    assert.equal(signInOld.status, 401, "old password must stop working after the change");
  });

  it("M-13: a wrong current password is still a 401", async () => {
    const target = await makeActiveUser("change-pass-401@stackmate.local");
    (store as unknown as { drizzleDb: unknown }).drizzleDb = {};
    const stubAuth = {
      api: {
        changePassword: async () => {
          throw new Error("invalid password");
        },
        revokeOtherSessions: async () => {},
      },
    };
    const err = await changeStaffPassword(store, target.principal, {
      auth: stubAuth as never,
      cookieHeader: target.cookie,
      currentPassword: "WrongPass123!",
      newPassword: "NewTargetPass123!",
      requestId: "req-change-2",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof AppError && err.statusCode === 401);
    assert.equal(err.message, "Current password is incorrect.");
  });

  it("M-13: happy path revokes and returns null count (stubbed auth)", async () => {
    const target = await makeActiveUser("change-pass-ok@stackmate.local");
    (store as unknown as { drizzleDb: unknown }).drizzleDb = {};
    let revoked = false;
    const stubAuth = {
      api: {
        changePassword: async () => ({ user: { id: target.id } }),
        revokeOtherSessions: async () => {
          revoked = true;
        },
      },
    };
    const res = await changeStaffPassword(store, target.principal, {
      auth: stubAuth as never,
      cookieHeader: target.cookie,
      currentPassword: "TargetPass123!",
      newPassword: "NewTargetPass123!",
      requestId: "req-change-3",
    });
    assert.equal(res.changed, true);
    assert.equal(res.revoked_other_sessions, null);
    assert.equal(revoked, true);
  });

  // -- M-14: permission-denial audit --------------------------------------
  it("M-14: a denied users.manage call writes a permission_denied audit row", async () => {
    const target = await makeActiveUser("denied-user@stackmate.local");
    // target holds no roles at all, so users.manage is denied.
    const err = await suspendStaffUser(store, target.principal, superPrincipal.user.id, "req-deny-1").then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof AppError && err.statusCode === 403);
    const denial = store.state.audit_logs.find(
      (a) => a.action === "identity.auth.permission_denied" && a.resource_id === "users.manage"
    );
    assert.ok(denial, "permission_denied audit row must exist");
    assert.equal(denial?.outcome, "denied");
    assert.equal(denial?.actor_user_id, target.principal.user.id);
  });

  it("M-14: recordTwoFactorStateChange writes enable/disable audit rows", async () => {
    await recordTwoFactorStateChange(store, {
      userId: superPrincipal.user.id,
      enabled: true,
      requestId: "req-2fa-1",
    });
    await recordTwoFactorStateChange(store, {
      userId: superPrincipal.user.id,
      enabled: false,
      requestId: "req-2fa-2",
    });
    assert.ok(
      store.state.audit_logs.some((a) => a.action === "identity.auth.two_factor_enabled"),
      "two_factor_enabled row must exist"
    );
    assert.ok(
      store.state.audit_logs.some((a) => a.action === "identity.auth.two_factor_disabled"),
      "two_factor_disabled row must exist"
    );
  });

  // -- M-21: invitation response carries email_sent / email_error ---------
  it("M-21: the invitation response includes honest email_sent / email_error", async () => {
    // The invitation contract requires at least one existing role key.
    const roleKey =
      store.state.roles.find((r) => r.key !== "super_admin")?.key ?? "admin";
    const res = await apiRequest(app, env, "/api/v1/admin/users/invitations", {
      method: "POST",
      body: { name: "Invitee", email: "invitee@stackmate.local", role_keys: [roleKey] },
      cookie: superCookie,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.email_sent, false, "SMTP is not configured in tests, so sent must be false");
    assert.equal(typeof res.body.data.email_error, "string");
    assert.ok(res.body.data.token_once, "token_once is still returned once");
  });
});

// ---------------------------------------------------------------------------
// Postgres-backed token tests (M-11, L-2, L-3). Skip cleanly without
// DATABASE_URL, same pattern as better-auth-unified.test.ts.
// ---------------------------------------------------------------------------
import {
  createPasswordResetToken,
  storePasswordResetToken,
  resetStaffPasswordByToken,
  recoverTwoFactorByToken,
} from "../src/modules/identity/service.ts";
import { eq } from "drizzle-orm";
import {
  sessions as baSessions,
  twoFactor as baTwoFactor,
  users as baUsers,
} from "../../../db/schema/auth.ts";
import { passwordResetTokens as baPasswordResetTokens } from "../../../db/schema/auth-config.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);

if (!DATABASE_URL) {
  console.log(
    "[audit-identity-auth-fixes] DATABASE_URL is not set — skipping the Postgres token suite."
  );
}

describe.skipIf(!DATABASE_URL)("Audit identity token fixes (Postgres)", () => {
  let adminClient: Client;
  let store: any;
  let db: any;

  async function countTokens(userId: string): Promise<number> {
    const rows = await db
      .select()
      .from(baPasswordResetTokens)
      .where(eq(baPasswordResetTokens.userId, userId));
    return rows.length;
  }

  async function makeStaffUser(email: string): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await store.withTransaction((state: any) => {
      state.users.push({
        id,
        name: "Token Test User",
        email,
        email_verified: true,
        two_factor_enabled: false,
        password_hash:
          "scrypt:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        status: "active",
        created_at: now,
        updated_at: now,
      });
    });
    return id;
  }

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const dbName = new URL(DATABASE_URL).pathname.replace(/^\//, "");
    assert.ok(dbName.includes("test"), `Refusing: database name "${dbName}" must contain "test".`);
    adminClient = new Client({ connectionString: DATABASE_URL });
    await adminClient.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      await adminClient.query(sql);
    }
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
    store = await DrizzleStore.create({ connectionString: DATABASE_URL });
    db = (store as any).drizzleDb;
    assert.ok(db, "DrizzleStore must expose drizzleDb");
  }, 120_000);

  afterAll(async () => {
    try {
      await store?.close();
    } catch {
      // Best-effort teardown.
    }
    try {
      await adminClient?.end();
    } catch {
      // Best-effort teardown.
    }
  });

  it("M-11: minting a second token invalidates the first (same purpose)", async () => {
    const email = uniq("mint-a") + "@stackmate.local";
    const userId = await makeStaffUser(email);
    const a = createPasswordResetToken(store, userId, "password_reset");
    await storePasswordResetToken(store, userId, "password_reset", a.tokenHash, a.expiresAt);
    assert.equal(await countTokens(userId), 1);
    const b = createPasswordResetToken(store, userId, "password_reset");
    await storePasswordResetToken(store, userId, "password_reset", b.tokenHash, b.expiresAt);
    assert.equal(await countTokens(userId), 1, "the second mint must delete the first unused token");
    // The first token no longer works; the second does.
    const stale = await resetStaffPasswordByToken(store, {
      token: a.rawToken,
      newPassword: "MintTestPass123!",
      requestId: "req-mint-a",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(stale instanceof AppError && stale.statusCode === 422);
    const ok = await resetStaffPasswordByToken(store, {
      token: b.rawToken,
      newPassword: "MintTestPass123!",
      requestId: "req-mint-b",
    });
    assert.equal(ok.user_id, userId);
  });

  it("M-11: a successful reset invalidates sibling tokens of the other purpose too", async () => {
    const email = uniq("mint-b") + "@stackmate.local";
    const userId = await makeStaffUser(email);
    const reset = createPasswordResetToken(store, userId, "password_reset");
    await storePasswordResetToken(store, userId, "password_reset", reset.tokenHash, reset.expiresAt);
    const recovery = createPasswordResetToken(store, userId, "two_factor_recovery");
    await storePasswordResetToken(store, userId, "two_factor_recovery", recovery.tokenHash, recovery.expiresAt);
    assert.equal(await countTokens(userId), 2);
    await resetStaffPasswordByToken(store, {
      token: reset.rawToken,
      newPassword: "SiblingTestPass123!",
      requestId: "req-sibling",
    });
    // The consumed reset token row remains (usedAt set); the UNUSED
    // recovery token must be gone.
    const remaining = await db
      .select()
      .from(baPasswordResetTokens)
      .where(eq(baPasswordResetTokens.userId, userId));
    assert.equal(
      remaining.filter((r: any) => !r.usedAt).length,
      0,
      "no unused token may survive a successful reset"
    );
    const dead = await recoverTwoFactorByToken(store, {
      token: recovery.rawToken,
      password: "SiblingTestPass123!",
      requestId: "req-sibling-2",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(dead instanceof AppError && dead.statusCode === 422);
  });

  it("L-2: the same token cannot reset twice — sequential and concurrent", async () => {
    const email = uniq("dbl") + "@stackmate.local";
    const userId = await makeStaffUser(email);
    const token = createPasswordResetToken(store, userId, "password_reset");
    await storePasswordResetToken(store, userId, "password_reset", token.tokenHash, token.expiresAt);
    const first = await resetStaffPasswordByToken(store, {
      token: token.rawToken,
      newPassword: "DoubleUsePass123!",
      requestId: "req-dbl-1",
    });
    assert.equal(first.user_id, userId);
    const second = await resetStaffPasswordByToken(store, {
      token: token.rawToken,
      newPassword: "DoubleUsePass123!",
      requestId: "req-dbl-2",
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(second instanceof AppError && second.statusCode === 422, "re-using a consumed token must 422");

    // Concurrent double-submit: exactly one wins.
    const email2 = uniq("dbl2") + "@stackmate.local";
    const userId2 = await makeStaffUser(email2);
    const token2 = createPasswordResetToken(store, userId2, "password_reset");
    await storePasswordResetToken(store, userId2, "password_reset", token2.tokenHash, token2.expiresAt);
    const results = await Promise.allSettled([
      resetStaffPasswordByToken(store, {
        token: token2.rawToken,
        newPassword: "RacePass123!",
        requestId: "req-race-1",
      }),
      resetStaffPasswordByToken(store, {
        token: token2.rawToken,
        newPassword: "RacePass123!",
        requestId: "req-race-2",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent reset must succeed");
    assert.equal(rejected.length, 1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as AppError;
    assert.ok(reason instanceof AppError && reason.statusCode === 422, "the loser must 422");
  });

  it("L-3: 2FA recovery revokes all sessions (like password reset)", async () => {
    const email = uniq("rec") + "@stackmate.local";
    const userId = await makeStaffUser(email);
    const now = new Date();
    // 2FA on, with a live session row.
    await db.update(baUsers).set({ twoFactorEnabled: true }).where(eq(baUsers.id, userId));
    await db.insert(baTwoFactor).values({
      id: randomUUID(),
      userId,
      secret: "TESTSECRET",
      backupCodes: "[]",
      verified: true,
    });
    await db.insert(baSessions).values({
      id: randomUUID(),
      userId,
      token: `test-session-${randomUUID()}`,
      expiresAt: new Date(now.getTime() + 3600_000),
    });
    const before = await db.select().from(baSessions).where(eq(baSessions.userId, userId));
    assert.equal(before.length, 1, "one live session must exist before recovery");

    // The user has no Better Auth credential, so recovery falls back to
    // the stored scrypt hash — but the test user was created with a
    // dummy hash, so set a real one first via the store.
    const { hashPasswordScrypt } = await import("../src/modules/identity/service.ts");
    await store.withTransaction((state: any) => {
      const row = state.users.find((u: any) => u.id === userId);
      if (row) row.password_hash = hashPasswordScrypt("RecoveryPass123!");
    });
    const token = createPasswordResetToken(store, userId, "two_factor_recovery");
    await storePasswordResetToken(store, userId, "two_factor_recovery", token.tokenHash, token.expiresAt);
    const recovered = await recoverTwoFactorByToken(store, {
      token: token.rawToken,
      password: "RecoveryPass123!",
      requestId: "req-rec-1",
    });
    assert.equal(recovered.user_id, userId);

    const after = await db.select().from(baSessions).where(eq(baSessions.userId, userId));
    assert.equal(after.length, 0, "recovery must revoke every session");
    const twoFactorRows = await db
      .select()
      .from(baTwoFactor)
      .where(eq(baTwoFactor.userId, userId));
    assert.equal(twoFactorRows.length, 0, "the two_factor row must be deleted");
    const userRows = await db.select().from(baUsers).where(eq(baUsers.id, userId));
    assert.equal(userRows[0].twoFactorEnabled, false, "twoFactorEnabled must be false");
  });
});
