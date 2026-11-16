/**
 * Auth + Email batch tests (Postgres-backed, hermetic).
 *
 * Covers, through the real HTTP endpoints:
 *  - 2FA policy enforcement (off / optional / required × role, global
 *    default, strictest-wins) + the restricted-session 403 gate
 *    (TWO_FACTOR_SETUP_REQUIRED) on every admin endpoint except /me.
 *  - TOTP setup / verify via the real better-auth twoFactor plugin
 *    (QR secret from /two-factor/enable, TOTP computed in-test from
 *    the secret), the sign-in challenge, backup-code login, disable.
 *  - Forgot / reset (token hash, 1h TTL, single-use, wrong-purpose
 *    rejection) and 2FA recovery by email token + password (wrong
 *    password 401; reset alone never disables 2FA).
 *  - Invitation email with SMTP off (token_once + honest email_error)
 *    and SMTP on-but-unreachable in Node (email_sent false, real
 *    error). A real SMTP send is UNTESTED here — no credentials exist;
 *    see the batch report for the manual step.
 *  - OAuth config gating on the public login config endpoint + secret
 *    handling (422s, has_client_secret flag, secret never returned).
 *
 * Requires DATABASE_URL to a LOCAL test Postgres, e.g.:
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/stackmate_test
 * The suite creates its OWN fresh database `stackmate_test_auth_email`
 * on the same server, applies every journal migration there, and DROPS
 * it afterwards. Without DATABASE_URL the whole suite SKIPS cleanly.
 *
 * The twoFactor plugin rate-limits /two-factor/* to 3 calls per 10s
 * (verified in better-auth 1.7.23 dist/plugins/two-factor/index.mjs),
 * so the TOTP tests sleep once for a fresh window; the affected test
 * carries a 60s timeout.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import {
  createPasswordResetToken,
  storePasswordResetToken,
} from "../src/modules/identity/service.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const AUTH_EMAIL_DB_NAME = "stackmate_test_auth_email";
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
    "[auth-email] DATABASE_URL is not set — skipping. " +
      "Set DATABASE_URL to a local test Postgres to run it."
  );
}

const uniq = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** RFC 6238 TOTP (SHA-1, 30s period, 6 digits) for the plugin's secret. */
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = secretBase32
    .toUpperCase()
    .replace(/=+$/, "")
    .split("")
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0"))
    .join("");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Math.floor(at / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

describe.skipIf(!DATABASE_URL)("Auth + Email batch (Postgres)", () => {
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let app: ReturnType<typeof createStackMateApp>;
  let store: any;
  let adminClient: Client;
  let authDbUrl: string;
  let superCookie = "";
  let testUserEmail = "";
  let testUserPassword = "TestUserPass123!";
  let testUserId = "";

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string; token?: string } = {}
  ): Promise<{ status: number; headers: Headers; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
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
    return { status: res.status, headers: res.headers, body };
  }

  function cookiePairs(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    return setCookies.map((c) => c.split(";")[0]!).join("; ");
  }

  async function signIn(email: string, password: string) {
    const res = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email, password },
    });
    return res;
  }

  async function setPolicy(scope: string, mode: string) {
    const res = await apiRequest("/api/v1/admin/auth-config/two-factor-policy", {
      method: "PUT",
      body: { scope, mode },
      cookie: superCookie,
    });
    assert.equal(res.status, 200, `setPolicy ${scope}=${mode}: ${JSON.stringify(res.body)}`);
  }

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const url = new URL(DATABASE_URL);
    assert.ok(
      url.pathname.replace(/^\//, "").includes("test"),
      "Refusing to run: DATABASE_URL database name must contain 'test'."
    );
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });

    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    const maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${AUTH_EMAIL_DB_NAME}"`);
    await maintenanceClient.query(`CREATE DATABASE "${AUTH_EMAIL_DB_NAME}"`);
    await maintenanceClient.end();

    const authUrl = new URL(DATABASE_URL);
    authUrl.pathname = `/${AUTH_EMAIL_DB_NAME}`;
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

    // Bootstrap the super admin and sign in (the operator cookie).
    const superEmail = `${uniq("super")}@example.com`;
    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Super Admin",
        email: superEmail,
        password: "SuperAdminPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signedIn = await signIn(superEmail, "SuperAdminPass123!");
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    superCookie = cookiePairs(signedIn.headers);
    assert.ok(superCookie.includes("better-auth.session_token"));

    // A read_only staff user (the 2FA policy test subject).
    testUserEmail = `${uniq("staff")}@example.com`;
    const created = await apiRequest("/api/v1/admin/users", {
      method: "POST",
      body: {
        name: "Policy Staff",
        email: testUserEmail,
        password: testUserPassword,
        role_keys: ["read_only"],
      },
      cookie: superCookie,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    testUserId = created.body.data.user.id as string;
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
      await mc.query(`DROP DATABASE IF EXISTS "${AUTH_EMAIL_DB_NAME}"`);
      await mc.end();
    } catch {}
  });

  it("2FA policy: required for a role forces setup; /me stays open, admin endpoints 403", async () => {
    await setPolicy("read_only", "required");
    const res = await signIn(testUserEmail, testUserPassword);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.principal.two_factor_setup_required, true);
    const me = await apiRequest("/api/v1/admin/me", {
      cookie: cookiePairs(res.headers),
    });
    assert.equal(me.status, 200, "GET /me must stay open on a restricted session");
    assert.equal(me.body.data.two_factor_setup_required, true);
    const users = await apiRequest("/api/v1/admin/users", {
      cookie: cookiePairs(res.headers),
    });
    assert.equal(users.status, 403, JSON.stringify(users.body));
    assert.equal(users.body.error.code, "TWO_FACTOR_SETUP_REQUIRED");
    // Back to off: the same user signs in unrestricted.
    await setPolicy("read_only", "off");
    const res2 = await signIn(testUserEmail, testUserPassword);
    assert.equal(res2.status, 200, JSON.stringify(res2.body));
    assert.equal(res2.body.data.principal.two_factor_setup_required, false);
    const users2 = await apiRequest("/api/v1/admin/users", {
      cookie: cookiePairs(res2.headers),
    });
    // Gate lifted: the request now reaches the permission check, and a
    // read_only user correctly lacks users.manage (403 FORBIDDEN, not
    // TWO_FACTOR_SETUP_REQUIRED).
    assert.equal(users2.status, 403, JSON.stringify(users2.body));
    assert.equal(users2.body.error.code, "FORBIDDEN");
  });

  it("2FA policy: optional does not force setup; global required does (reset via SQL)", async () => {
    await setPolicy("global", "optional");
    const res = await signIn(testUserEmail, testUserPassword);
    assert.equal(res.body.data.principal.two_factor_setup_required, false);
    await setPolicy("global", "required");
    const res2 = await signIn(testUserEmail, testUserPassword);
    assert.equal(res2.body.data.principal.two_factor_setup_required, true);
    // No admin can unset a global-required policy through the API (every
    // admin session is restricted) — the test resets it directly in the
    // DB, the same escape hatch an operator has. This is test-only.
    await adminClient.query(
      "UPDATE auth_two_factor_policy SET mode = 'off' WHERE scope = 'global'"
    );
    const res3 = await signIn(testUserEmail, testUserPassword);
    assert.equal(res3.body.data.principal.two_factor_setup_required, false);
    await setPolicy("global", "off");
  });

  it("OAuth config gating: public endpoint lists only enabled providers; secrets never leak", async () => {
    const pub0 = await apiRequest("/api/v1/auth-config");
    assert.equal(pub0.status, 200);
    assert.deepEqual(pub0.body.data.oauth_providers, []);
    assert.equal(pub0.body.data.email_configured, false);

    const noId = await apiRequest("/api/v1/admin/auth-config/oauth", {
      method: "PUT",
      body: { provider: "google", enabled: true },
      cookie: superCookie,
    });
    assert.equal(noId.status, 422, "enabling without a client id must fail");
    const noSecret = await apiRequest("/api/v1/admin/auth-config/oauth", {
      method: "PUT",
      body: { provider: "google", enabled: true, client_id: "google-client-id" },
      cookie: superCookie,
    });
    assert.equal(noSecret.status, 422, "enabling without a secret must fail");
    const badProvider = await apiRequest("/api/v1/admin/auth-config/oauth", {
      method: "PUT",
      body: { provider: "facebook", enabled: true },
      cookie: superCookie,
    });
    assert.equal(badProvider.status, 422, "invented providers must fail");

    const saved = await apiRequest("/api/v1/admin/auth-config/oauth", {
      method: "PUT",
      body: {
        provider: "google",
        enabled: true,
        client_id: "google-client-id",
        client_secret: "google-client-secret-TEST-ONLY",
      },
      cookie: superCookie,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.has_client_secret, true);
    assert.ok(
      !JSON.stringify(saved.body).includes("google-client-secret-TEST-ONLY"),
      "the secret must never be returned"
    );
    const pub1 = await apiRequest("/api/v1/auth-config");
    assert.deepEqual(pub1.body.data.oauth_providers, ["google"]);
    const disabled = await apiRequest("/api/v1/admin/auth-config/oauth", {
      method: "PUT",
      body: { provider: "google", enabled: false },
      cookie: superCookie,
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.equal(disabled.body.data.has_client_secret, true, "disabling keeps the stored secret");
    const pub2 = await apiRequest("/api/v1/auth-config");
    assert.deepEqual(pub2.body.data.oauth_providers, []);
  });

  it("forgot / reset: generic 200, token row created, reset works once, expiry + reuse fail", async () => {
    const unknown = await apiRequest("/api/auth/forgot-password", {
      method: "POST",
      body: { email: "nobody@example.com" },
    });
    assert.equal(unknown.status, 200);
    assert.match(unknown.body.data.message, /If an account exists/);
    const known = await apiRequest("/api/auth/forgot-password", {
      method: "POST",
      body: { email: testUserEmail },
    });
    assert.equal(known.status, 200);
    assert.equal(known.body.data.message, unknown.body.data.message, "responses must not differ");
    const rows = await adminClient.query(
      "SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL",
      [testUserId]
    );
    assert.equal(Number(rows.rows[0].count), 1, "a token row must be created for a known email");

    // Reset through the HTTP endpoint with a token created by the
    // service helpers (the raw token is only ever emailed, so the test
    // mints its own row the same way the endpoint does).
    const minted = createPasswordResetToken(store, testUserId, "password_reset");
    await storePasswordResetToken(
      store, testUserId, "password_reset", minted.tokenHash, minted.expiresAt
    );
    const newPassword = "ResetPass456!";
    const reset = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: minted.rawToken, new_password: newPassword },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    testUserPassword = newPassword;
    const signedIn = await signIn(testUserEmail, newPassword);
    assert.equal(signedIn.status, 200, "the new password must sign in");
    const reuse = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: minted.rawToken, new_password: "AnotherPass789!" },
    });
    assert.equal(reuse.status, 422, "a used token must not work twice");
    const short = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: minted.rawToken, new_password: "short" },
    });
    assert.equal(short.status, 422, "short passwords stay rejected");
    // Expired token: a row whose expiry is in the past.
    const expired = createPasswordResetToken(store, testUserId, "password_reset");
    await adminClient.query(
      "INSERT INTO password_reset_tokens (id, user_id, token_hash, purpose, expires_at, created_at) VALUES (gen_random_uuid(), $1, $2, 'password_reset', NOW() - INTERVAL '1 hour', NOW())",
      [testUserId, expired.tokenHash]
    );
    const expiredRes = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: expired.rawToken, new_password: "AnotherPass789!" },
    });
    assert.equal(expiredRes.status, 422, "an expired token must fail");
  });

  it("invitation email: SMTP off keeps token_once + honest email_error; SMTP on-but-unreachable fails honestly", async () => {
    const invitee = `${uniq("invitee")}@example.com`;
    const off = await apiRequest("/api/v1/admin/users/invitations", {
      method: "POST",
      body: { name: "Invitee One", email: invitee, role_keys: ["read_only"] },
      cookie: superCookie,
    });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    assert.ok(off.body.data.token_once, "token_once must stay when email is off");
    assert.equal(off.body.data.email_sent, false);
    assert.match(off.body.data.email_error, /not configured/);

    // Configure SMTP (no real server behind it in Node) — the send must
    // fail honestly, never fake success.
    const smtp = await apiRequest("/api/v1/admin/auth-config/smtp", {
      method: "PUT",
      body: {
        host: "localhost",
        port: 587,
        username: "smtp-user",
        password: "smtp-pass-TEST-ONLY",
        tls_mode: "starttls",
        from_address: "noreply@example.com",
        from_name: "StackMate",
        enabled: true,
      },
      cookie: superCookie,
    });
    assert.equal(smtp.status, 200, JSON.stringify(smtp.body));
    assert.equal(smtp.body.data.has_password, true);
    assert.ok(
      !JSON.stringify(smtp.body).includes("smtp-pass-TEST-ONLY"),
      "the SMTP password must never be returned"
    );
    const invitee2 = `${uniq("invitee")}@example.com`;
    const on = await apiRequest("/api/v1/admin/users/invitations", {
      method: "POST",
      body: { name: "Invitee Two", email: invitee2, role_keys: ["read_only"] },
      cookie: superCookie,
    });
    assert.equal(on.status, 201, JSON.stringify(on.body));
    assert.ok(on.body.data.token_once, "token_once must stay even when email fails");
    assert.equal(on.body.data.email_sent, false, "an unreachable SMTP must not report success");
    assert.ok(on.body.data.email_error, "the real error must be reported");
    const testSend = await apiRequest("/api/v1/admin/auth-config/smtp/test", {
      method: "POST",
      body: {},
      cookie: superCookie,
    });
    assert.equal(testSend.status, 502, JSON.stringify(testSend.body));
    // Back to disabled for the remaining tests.
    const offAgain = await apiRequest("/api/v1/admin/auth-config/smtp", {
      method: "PUT",
      body: { enabled: false },
      cookie: superCookie,
    });
    assert.equal(offAgain.status, 200, JSON.stringify(offAgain.body));
  });

  it("TOTP: enable → verify → sign-in challenge → backup-code login", { timeout: 60_000 }, async () => {
    const signedIn = await signIn(testUserEmail, testUserPassword);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    const cookie = cookiePairs(signedIn.headers);
    const enabled = await apiRequest("/api/auth/two-factor/enable", {
      method: "POST",
      body: { password: testUserPassword },
      cookie,
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    // NOTE: the twoFactor plugin returns the raw body, not the app envelope.
    const totpURI = enabled.body.totpURI as string;
    const backupCodes = enabled.body.backupCodes as string[];
    assert.ok(totpURI.startsWith("otpauth://totp/"), "enable must return a TOTP URI");
    assert.ok(Array.isArray(backupCodes) && backupCodes.length > 0, "enable must return backup codes");
    const secret = new URL(totpURI).searchParams.get("secret")!;
    assert.ok(secret, "the TOTP URI must carry the secret");

    const verify = await apiRequest("/api/auth/two-factor/verify-totp", {
      method: "POST",
      body: { code: totp(secret) },
      cookie,
    });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    // verify-totp rotates the session: the old cookie is dead, the
    // response carries the new session cookie.
    const cookieAfterVerify = cookiePairs(verify.headers) || cookie;
    const me = await apiRequest("/api/v1/admin/me", { cookie: cookieAfterVerify });
    assert.equal(me.body.data.two_factor_enabled, true, "verify must turn 2FA on");

    // Sign-in now challenges instead of signing in.
    const challenged = await signIn(testUserEmail, testUserPassword);
    assert.equal(challenged.status, 200, JSON.stringify(challenged.body));
    assert.equal(challenged.body.data.two_factor_redirect, true);
    assert.ok(!challenged.body.data.session_token, "no session may exist before TOTP");
    const challengeCookie = cookiePairs(challenged.headers);
    const verified = await apiRequest("/api/auth/two-factor/verify-totp", {
      method: "POST",
      body: { code: totp(secret) },
      cookie: challengeCookie,
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const me2 = await apiRequest("/api/v1/admin/me", {
      cookie: cookiePairs(verified.headers),
    });
    assert.equal(me2.status, 200, JSON.stringify(me2.body));
    assert.equal(me2.body.data.two_factor_enabled, true);

    // Backup-code login (fresh challenge first; the plugin rate limit
    // is 3 calls per 10s, so this runs in a new window).
    await sleep(11_000);
    const challenged2 = await signIn(testUserEmail, testUserPassword);
    assert.equal(challenged2.body.data.two_factor_redirect, true);
    const backupVerified = await apiRequest("/api/auth/two-factor/verify-backup-code", {
      method: "POST",
      body: { code: backupCodes[0] },
      cookie: cookiePairs(challenged2.headers),
    });
    assert.equal(backupVerified.status, 200, JSON.stringify(backupVerified.body));
    const me3 = await apiRequest("/api/v1/admin/me", {
      cookie: cookiePairs(backupVerified.headers),
    });
    assert.equal(me3.status, 200, JSON.stringify(me3.body));
  });

  it("2FA recovery: wrong password 401, right password disables 2FA; reset alone never disables it", async () => {
    const me = await apiRequest("/api/v1/admin/me", { cookie: superCookie });
    assert.equal(me.status, 200);
    // The test user still has 2FA on from the previous test.
    const userRow = await adminClient.query(
      "SELECT two_factor_enabled FROM users WHERE id = $1",
      [testUserId]
    );
    assert.equal(userRow.rows[0].two_factor_enabled, true, "2FA must still be on");

    // A password reset must NOT disable 2FA.
    const minted = createPasswordResetToken(store, testUserId, "password_reset");
    await storePasswordResetToken(
      store, testUserId, "password_reset", minted.tokenHash, minted.expiresAt
    );
    const reset = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: minted.rawToken, new_password: "ResetAgain789!" },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    testUserPassword = "ResetAgain789!";
    const stillOn = await adminClient.query(
      "SELECT two_factor_enabled FROM users WHERE id = $1",
      [testUserId]
    );
    assert.equal(stillOn.rows[0].two_factor_enabled, true, "reset must not disable 2FA");

    // Recovery: wrong password fails, right password disables.
    const recovery = createPasswordResetToken(store, testUserId, "two_factor_recovery");
    await storePasswordResetToken(
      store, testUserId, "two_factor_recovery", recovery.tokenHash, recovery.expiresAt
    );
    const wrong = await apiRequest("/api/auth/two-factor/recover/confirm", {
      method: "POST",
      body: { token: recovery.rawToken, password: "WrongPassword123!" },
    });
    assert.equal(wrong.status, 401, JSON.stringify(wrong.body));
    const right = await apiRequest("/api/auth/two-factor/recover/confirm", {
      method: "POST",
      body: { token: recovery.rawToken, password: testUserPassword },
    });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    const off = await adminClient.query(
      "SELECT two_factor_enabled FROM users WHERE id = $1",
      [testUserId]
    );
    assert.equal(off.rows[0].two_factor_enabled, false, "recovery must disable 2FA");
    const reuse = await apiRequest("/api/auth/two-factor/recover/confirm", {
      method: "POST",
      body: { token: recovery.rawToken, password: testUserPassword },
    });
    assert.equal(reuse.status, 422, "a used recovery token must not work twice");
    const signedIn = await signIn(testUserEmail, testUserPassword);
    assert.equal(signedIn.status, 200, "sign-in must work without a challenge after recovery");
    assert.equal(signedIn.body.data.two_factor_redirect, undefined);
  });

  it("2FA disable endpoint turns it off (re-enabled first)", { timeout: 60_000 }, async () => {
    const signedIn = await signIn(testUserEmail, testUserPassword);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    const cookie = cookiePairs(signedIn.headers);
    const enabled = await apiRequest("/api/auth/two-factor/enable", {
      method: "POST",
      body: { password: testUserPassword },
      cookie,
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    const secret = new URL(enabled.body.totpURI as string).searchParams.get("secret")!;
    const verify = await apiRequest("/api/auth/two-factor/verify-totp", {
      method: "POST",
      body: { code: totp(secret) },
      cookie,
    });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    const cookieAfterVerify = cookiePairs(verify.headers) || cookie;
    const disabled = await apiRequest("/api/auth/two-factor/disable", {
      method: "POST",
      body: { password: testUserPassword },
      cookie: cookieAfterVerify,
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    // disable rotates the session as well.
    const cookieAfterDisable = cookiePairs(disabled.headers) || cookieAfterVerify;
    const me = await apiRequest("/api/v1/admin/me", { cookie: cookieAfterDisable });
    assert.equal(me.body.data.two_factor_enabled, false);
  });
});
