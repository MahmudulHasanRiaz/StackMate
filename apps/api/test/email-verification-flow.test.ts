/**
 * OD-06 email-verification flow tests (Postgres-backed, hermetic, plus
 * one in-memory describe for the invitation path).
 *
 * Covers, through the real HTTP endpoints:
 *  (a) admin-created users start `email_verified: false` and sign-in
 *      answers 403 EMAIL_NOT_VERIFIED (with the distinct audit row);
 *      a wrong password still answers 401, so the 403 proves the
 *      password was right.
 *  (b) verify-endpoint success: a token minted with Better Auth's own
 *      `createEmailVerificationToken` (the dist function the product
 *      itself uses — the token is a stateless JWT signed with
 *      BETTER_AUTH_SECRET, NOT a `verifications`-table row) flips
 *      `email_verified` to true, 302-redirects to the callbackURL,
 *      mints NO session (autoSignInAfterVerification is false), and
 *      the user can then sign in. Without a callbackURL the same
 *      success answers JSON `{ status: true }`.
 *  (c) invalid token (garbage, and a token signed with the wrong
 *      secret) → honest INVALID_TOKEN error, no flip, no fake success.
 *  (d) expired token → TOKEN_EXPIRED, no flip.
 *  (e) admin resend: 200 with the honest send result, 409 for an
 *      already-verified user, 404 for an unknown user, 429 on a rapid
 *      repeat (1/min per-user bucket).
 *  (f) public resend: always 200 `{ ok: true }` (unknown, verified,
 *      unverified, suspended alike — no enumeration), and a send is
 *      attempted ONLY for an existing unverified active user. The
 *      attempt is observed white-box through the per-email rate-limit
 *      bucket, which the route counts only when a send is attempted:
 *      counted for the unverified user, untouched for unknown /
 *      verified / suspended addresses.
 *  (g) bootstrap admin IS verified and can sign in; an invite-accepted
 *      user IS verified and can sign in (the invite token email IS the
 *      verification step).
 *  (h) an already-verified user signs in normally; re-clicking a
 *      verification link redirects cleanly instead of erroring.
 *
 * SMTP honesty note: there is NO real SMTP transport in Node —
 * `sendStackMateEmail` dynamically imports `cloudflare:sockets`,
 * which does not resolve under vitest, so every send attempt in this
 * suite fails honestly (`{ sent: false, error }`) and is asserted as
 * such. A real SMTP send is UNTESTED here and needs the live staging
 * check (real inbox + valid-token click). Nothing in this suite fakes
 * a send.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres, e.g.:
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/stackmate_test
 * The suite creates its OWN fresh database
 * `stackmate_test_email_verification` on the same server, applies
 * every journal migration there, and DROPS it afterwards. Without
 * DATABASE_URL the Postgres describe SKIPS cleanly; the in-memory
 * invitation describe always runs.
 */
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { buildVerificationCallbackUrl } from "../src/modules/identity/email-verification.ts";
// The token minter is Better Auth's own dist function (the product
// mints through it in dist/api/routes/email-verification.mjs); the
// package exports map does not expose the dist subpath, so the file is
// imported by relative path. The sibling email-verification.d.mts
// supplies the types.
import { createEmailVerificationToken } from "../node_modules/better-auth/dist/api/routes/email-verification.mjs";

const DATABASE_URL = process.env.DATABASE_URL;
const EMAIL_VERIFICATION_DB_NAME = "stackmate_test_email_verification";
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
    "[email-verification-flow] DATABASE_URL is not set — skipping the Postgres describe. " +
      "Set DATABASE_URL to a local test Postgres to run it."
  );
}

const uniq = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!DATABASE_URL)("Email verification flow (OD-06, Postgres)", () => {
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let app: ReturnType<typeof createStackMateApp>;
  let store: any;
  let adminClient: Client;
  let superCookie = "";
  let superEmail = "";

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}
  ): Promise<{ status: number; headers: Headers; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.origin) headers.set("Origin", options.origin);
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
    return apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email, password },
    });
  }

  async function createStaffUser(email: string, password = "StaffPass123!") {
    const created = await apiRequest("/api/v1/admin/users", {
      method: "POST",
      body: { name: "Verify Staff", email, password, role_keys: ["read_only"] },
      cookie: superCookie,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return {
      id: created.body.data.user.id as string,
      email,
      password,
      createdBody: created.body,
    };
  }

  async function dbUserRow(email: string): Promise<{
    id: string;
    email_verified: boolean;
  } | null> {
    // `users` is the Better Auth users table: it carries emailVerified
    // but no status (suspension lives in staff_profiles).
    const res = await adminClient.query(
      "SELECT id, email_verified FROM users WHERE email = $1",
      [email]
    );
    const row = res.rows[0] as
      | { id: string; email_verified: boolean }
      | undefined;
    return row ?? null;
  }

  async function auditRow(action: string, resourceId: string) {
    const res = await adminClient.query(
      "SELECT action, outcome, resource_id FROM audit_logs WHERE action = $1 AND resource_id = $2 ORDER BY created_at DESC LIMIT 1",
      [action, resourceId]
    );
    return res.rows[0] as
      | { action: string; outcome: string; resource_id: string }
      | undefined;
  }

  /** The per-email resend bucket the public route counts only when a send is attempted. */
  function publicResendBucketKey(email: string): string {
    return `resend-verification-email:${createHash("sha256").update(email, "utf8").digest("hex")}`;
  }

  async function publicResendBucketCounted(email: string): Promise<boolean> {
    return store.isRateLimited(publicResendBucketKey(email), 1, 60_000);
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
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${EMAIL_VERIFICATION_DB_NAME}"`);
    await maintenanceClient.query(`CREATE DATABASE "${EMAIL_VERIFICATION_DB_NAME}"`);
    await maintenanceClient.end();

    const verifyUrl = new URL(DATABASE_URL);
    verifyUrl.pathname = `/${EMAIL_VERIFICATION_DB_NAME}`;

    adminClient = new Client({ connectionString: verifyUrl.toString() });
    await adminClient.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      await adminClient.query(sql);
    }

    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
    store = await DrizzleStore.create({ connectionString: verifyUrl.toString() });
    app = createStackMateApp(store);

    // Bootstrap the super admin (g): the bootstrap path stays verified.
    superEmail = `${uniq("super")}@example.com`;
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
    const superRow = await dbUserRow(superEmail);
    assert.ok(superRow, "bootstrap user row must exist");
    assert.equal(superRow.email_verified, true, "bootstrap admin must start verified");
    const signedIn = await signIn(superEmail, "SuperAdminPass123!");
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    superCookie = cookiePairs(signedIn.headers);
    assert.ok(superCookie.includes("better-auth.session_token"));
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
      await mc.query(`DROP DATABASE IF EXISTS "${EMAIL_VERIFICATION_DB_NAME}"`);
      await mc.end();
    } catch {}
  });

  it("(a) admin-created user starts unverified; sign-in 403s EMAIL_NOT_VERIFIED with its own audit row", async () => {
    const email = `${uniq("unverified")}@example.com`;
    const user = await createStaffUser(email);

    // The creation response carries the user flag AND the honest
    // verification-email result (SMTP is not configured in this suite,
    // so the send is honestly reported as failed — never faked).
    assert.equal(user.createdBody.data.user.email_verified, false);
    assert.equal(user.createdBody.data.verification_email.sent, false);
    assert.match(
      String(user.createdBody.data.verification_email.error ?? ""),
      /not configured/i
    );

    // The flag is visible in the DB row and in the admin detail view.
    const row = await dbUserRow(email);
    assert.ok(row);
    assert.equal(row.email_verified, false);
    assert.equal(row.id, user.id);
    const detail = await apiRequest(`/api/v1/admin/users/${user.id}`, {
      cookie: superCookie,
    });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.email_verified, false);

    // Wrong password: the generic 401, not the 403 — so the 403 below
    // proves the password was right.
    const wrong = await signIn(email, "WrongPass123!");
    assert.equal(wrong.status, 401, JSON.stringify(wrong.body));
    assert.equal(wrong.body.error.code, "UNAUTHORIZED");

    // Right password, unverified email: the distinct 403.
    const denied = await signIn(email, user.password);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "EMAIL_NOT_VERIFIED");
    assert.match(denied.body.error.message, /not verified/i);

    // The denial is audited under its own action, distinguishable
    // from a bad-password denial.
    const audit = await auditRow("identity.auth.sign_in_denied_unverified", email);
    assert.ok(audit, "the unverified denial must be audited");
    assert.equal(audit.outcome, "denied");
    assert.equal(audit.resource_id, email);
  });

  it("(b) verify endpoint success: valid token redirects to the callbackURL, flips the flag, no session, sign-in then succeeds", async () => {
    const email = `${uniq("verify")}@example.com`;
    const user = await createStaffUser(email);
    assert.equal((await dbUserRow(email))?.email_verified, false);

    const token = await createEmailVerificationToken(
      env.BETTER_AUTH_SECRET,
      email,
      undefined,
      3600,
      { userId: user.id }
    );
    assert.ok(typeof token === "string" && token.length > 0, "a token must be minted");

    const callbackURL = buildVerificationCallbackUrl(env);
    assert.ok(callbackURL.endsWith("/?verified=1"), `callbackURL carries ?verified=1: ${callbackURL}`);
    const res = await apiRequest(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(callbackURL)}`
    );
    assert.equal(res.status, 302, JSON.stringify(res.body));
    assert.equal(res.headers.get("Location"), callbackURL);
    // autoSignInAfterVerification is false: verification mints no session.
    assert.ok(
      !cookiePairs(res.headers).includes("better-auth.session_token"),
      "verification must not sign the user in"
    );

    const row = await dbUserRow(email);
    assert.ok(row);
    assert.equal(row.email_verified, true, "the flag must flip in the DB");
    // Better Auth wrote the row directly, bypassing the shared store's
    // in-memory mirror — reload before signing in (production creates
    // a store per request, so this staleness does not exist there).
    await store.loadState();
    const detail = await apiRequest(`/api/v1/admin/users/${user.id}`, {
      cookie: superCookie,
    });
    assert.equal(detail.body.data.email_verified, true);
    const signedIn = await signIn(email, user.password);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));

    // (h) re-clicking the same link redirects cleanly instead of erroring.
    const again = await apiRequest(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(callbackURL)}`
    );
    assert.equal(again.status, 302, JSON.stringify(again.body));
    assert.equal(again.headers.get("Location"), callbackURL);
  });

  it("(b2) verify without a callbackURL answers JSON { status: true } and flips the flag", async () => {
    const email = `${uniq("verify-json")}@example.com`;
    const user = await createStaffUser(email);
    const token = await createEmailVerificationToken(
      env.BETTER_AUTH_SECRET,
      email,
      undefined,
      3600,
      { userId: user.id }
    );
    const res = await apiRequest(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, true);
    assert.equal((await dbUserRow(email))?.email_verified, true);
    await store.loadState();
    const signedIn = await signIn(email, user.password);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  });

  it("(c) invalid token → honest INVALID_TOKEN error, no flip, no fake success", async () => {
    const email = `${uniq("badtoken")}@example.com`;
    const user = await createStaffUser(email);

    // Garbage token, no callbackURL: 401 with the Better Auth code
    // preserved in error.details (the envelope code itself is the
    // mapped UNAUTHORIZED).
    const garbage = await apiRequest("/api/auth/verify-email?token=not-a-token");
    assert.equal(garbage.status, 401, JSON.stringify(garbage.body));
    assert.equal(garbage.body.error.code, "UNAUTHORIZED");
    assert.equal(garbage.body.error.details?.better_auth_code, "INVALID_TOKEN");

    // Garbage token WITH a callbackURL: 302 to callbackURL?error=INVALID_TOKEN.
    const callbackURL = buildVerificationCallbackUrl(env);
    const garbageCb = await apiRequest(
      `/api/auth/verify-email?token=not-a-token&callbackURL=${encodeURIComponent(callbackURL)}`
    );
    assert.equal(garbageCb.status, 302, JSON.stringify(garbageCb.body));
    const location = garbageCb.headers.get("Location") ?? "";
    assert.ok(location.startsWith(callbackURL), `redirect stays on the callbackURL: ${location}`);
    assert.ok(location.includes("error=INVALID_TOKEN"), `error rides on the redirect: ${location}`);

    // A well-formed JWT signed with the WRONG secret is invalid too.
    const wrongSecret = await createEmailVerificationToken(
      "wrong-secret-that-is-at-least-32-chars-long!!",
      email,
      undefined,
      3600,
      { userId: user.id }
    );
    const wrongSecretRes = await apiRequest(
      `/api/auth/verify-email?token=${encodeURIComponent(wrongSecret)}`
    );
    assert.equal(wrongSecretRes.status, 401, JSON.stringify(wrongSecretRes.body));
    assert.equal(wrongSecretRes.body.error.details?.better_auth_code, "INVALID_TOKEN");

    // Nothing flipped, and sign-in still 403s.
    assert.equal((await dbUserRow(email))?.email_verified, false);
    const denied = await signIn(email, user.password);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "EMAIL_NOT_VERIFIED");
  });

  it("(d) expired token → TOKEN_EXPIRED, no flip", async () => {
    const email = `${uniq("expired")}@example.com`;
    const user = await createStaffUser(email);
    // A token whose expiry is already in the past.
    const token = await createEmailVerificationToken(
      env.BETTER_AUTH_SECRET,
      email,
      undefined,
      -60,
      { userId: user.id }
    );
    const res = await apiRequest(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`
    );
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.error.details?.better_auth_code, "TOKEN_EXPIRED");

    const callbackURL = buildVerificationCallbackUrl(env);
    const resCb = await apiRequest(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(callbackURL)}`
    );
    assert.equal(resCb.status, 302, JSON.stringify(resCb.body));
    assert.ok(
      (resCb.headers.get("Location") ?? "").includes("error=TOKEN_EXPIRED"),
      `expired redirect carries ?error=TOKEN_EXPIRED: ${resCb.headers.get("Location")}`
    );

    assert.equal((await dbUserRow(email))?.email_verified, false);
    const denied = await signIn(email, user.password);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "EMAIL_NOT_VERIFIED");
  });

  it("(e) admin resend: 200 with the honest send result, 409 already-verified, 404 unknown, 429 on rapid repeat", async () => {
    const email = `${uniq("resend")}@example.com`;
    const user = await createStaffUser(email);

    // SMTP is not configured, so the send is honestly reported as
    // failed — the route still answers 200; the failure never fails
    // the mutation, and the attempt still counts against the bucket.
    const first = await apiRequest(
      `/api/v1/admin/users/${user.id}/resend-verification`,
      { method: "POST", cookie: superCookie }
    );
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.sent, false);
    assert.ok(first.body.data.error, "the honest failure reason must be reported");
    const audit = await auditRow("identity.user.verification_email_resent", user.id);
    assert.ok(audit, "the resend must be audited");
    assert.equal(audit.outcome, "failed");

    // Rapid repeat: the 1/min per-user bucket trips.
    const second = await apiRequest(
      `/api/v1/admin/users/${user.id}/resend-verification`,
      { method: "POST", cookie: superCookie }
    );
    assert.equal(second.status, 429, JSON.stringify(second.body));
    assert.equal(second.body.error.code, "RATE_LIMIT_EXCEEDED");

    // Already-verified user: 409.
    const verified = await createStaffUser(`${uniq("resend-verified")}@example.com`);
    const verifiedToken = await createEmailVerificationToken(
      env.BETTER_AUTH_SECRET,
      verified.email,
      undefined,
      3600,
      { userId: verified.id }
    );
    const verifyRes = await apiRequest(
      `/api/auth/verify-email?token=${encodeURIComponent(verifiedToken)}`
    );
    assert.equal(verifyRes.status, 200, JSON.stringify(verifyRes.body));
    // Better Auth flipped the DB row directly, bypassing the shared
    // store's in-memory mirror — reload before the resend, or the
    // route's `email_verified` check reads the stale `false` (same
    // accommodation as the sign-in tests; production creates a store
    // per request, so this staleness does not exist there).
    await store.loadState();
    const already = await apiRequest(
      `/api/v1/admin/users/${verified.id}/resend-verification`,
      { method: "POST", cookie: superCookie }
    );
    assert.equal(already.status, 409, JSON.stringify(already.body));
    assert.equal(already.body.error.code, "CONFLICT");

    // Unknown user: 404.
    const unknown = await apiRequest(
      "/api/v1/admin/users/00000000-0000-0000-0000-000000000000/resend-verification",
      { method: "POST", cookie: superCookie }
    );
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, "NOT_FOUND");
  });

  it("(f) public resend always answers 200 and sends only for an existing unverified active user", async () => {
    // Unknown address: generic 200, and no send is attempted — the
    // per-email bucket is NOT counted, so a prober cannot burn a
    // victim's resend budget with unknown-address requests.
    const unknownEmail = `${uniq("ghost")}@example.com`;
    const unknown = await apiRequest("/api/auth/resend-verification", {
      method: "POST",
      body: { email: unknownEmail },
    });
    assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
    assert.deepEqual(unknown.body.data, { ok: true });
    assert.equal(
      await publicResendBucketCounted(unknownEmail),
      false,
      "unknown address must not count against any per-email bucket"
    );

    // Already-verified address (the bootstrap admin): generic 200, no send.
    const verified = await apiRequest("/api/auth/resend-verification", {
      method: "POST",
      body: { email: superEmail },
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.deepEqual(verified.body.data, { ok: true });
    assert.equal(
      await publicResendBucketCounted(superEmail),
      false,
      "already-verified address must not trigger a send"
    );

    // Existing UNVERIFIED active user: generic 200 — and this time a
    // send IS attempted, so the per-email bucket IS counted. (The
    // send itself fails honestly — no SMTP transport in Node — but
    // the attempt is what this assertion observes.)
    const email = `${uniq("public-resend")}@example.com`;
    const user = await createStaffUser(email);
    assert.equal(await publicResendBucketCounted(email), false);
    const resend = await apiRequest("/api/auth/resend-verification", {
      method: "POST",
      body: { email },
    });
    assert.equal(resend.status, 200, JSON.stringify(resend.body));
    assert.deepEqual(resend.body.data, { ok: true });
    assert.equal(
      await publicResendBucketCounted(email),
      true,
      "an unverified active user must trigger a send attempt"
    );
    void user;

    // Suspended user: generic 200, no send.
    const suspendedEmail = `${uniq("suspended")}@example.com`;
    const suspended = await createStaffUser(suspendedEmail);
    const suspendRes = await apiRequest(
      `/api/v1/admin/users/${suspended.id}/suspend`,
      { method: "PATCH", cookie: superCookie }
    );
    assert.equal(suspendRes.status, 200, JSON.stringify(suspendRes.body));
    const suspendedResend = await apiRequest("/api/auth/resend-verification", {
      method: "POST",
      body: { email: suspendedEmail },
    });
    assert.equal(suspendedResend.status, 200, JSON.stringify(suspendedResend.body));
    assert.deepEqual(suspendedResend.body.data, { ok: true });
    assert.equal(
      await publicResendBucketCounted(suspendedEmail),
      false,
      "a suspended user must not trigger a send"
    );

    // Validation only: malformed / missing email is a 422, never the
    // generic 200.
    const malformed = await apiRequest("/api/auth/resend-verification", {
      method: "POST",
      body: { email: "not-an-email" },
    });
    assert.equal(malformed.status, 422, JSON.stringify(malformed.body));
    const missing = await apiRequest("/api/auth/resend-verification", {
      method: "POST",
      body: {},
    });
    assert.equal(missing.status, 422, JSON.stringify(missing.body));
  });

  it("(g/h) already-verified user signs in normally (no regression)", async () => {
    const email = `${uniq("verified-signin")}@example.com`;
    const user = await createStaffUser(email);
    const token = await createEmailVerificationToken(
      env.BETTER_AUTH_SECRET,
      email,
      undefined,
      3600,
      { userId: user.id }
    );
    const verifyRes = await apiRequest(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`
    );
    assert.equal(verifyRes.status, 200, JSON.stringify(verifyRes.body));
    await store.loadState();
    // Sign in twice: verification is not a one-shot gate.
    for (let i = 0; i < 2; i++) {
      const signedIn = await signIn(email, user.password);
      assert.equal(signedIn.status, 200, `sign-in #${i + 1}: ${JSON.stringify(signedIn.body)}`);
      assert.ok(signedIn.body.data.principal, "a principal must be returned");
      assert.equal(signedIn.body.data.principal.user.email, email);
    }
  });
});

describe("Invite-accepted user is verified (OD-06, in-memory)", () => {
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let superCookie = "";

  async function apiRequest(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string } = {}
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (options.cookie) headers.set("Cookie", options.cookie);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(new Request(`http://localhost:8787${path}`, init), env);
    return { status: res.status, body: await res.json(), headers: res.headers };
  }

  function sessionCookieFromHeaders(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    const pair = setCookies.find((c) => c.startsWith("stackmate_session="));
    assert.ok(pair, "sign-in must set a stackmate_session cookie");
    return pair!.split(";")[0]!;
  }

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
  });

  it("(g) invite-accepted user IS verified and can sign in immediately", async () => {
    const invited = await apiRequest("/api/v1/admin/users/invitations", {
      method: "POST",
      cookie: superCookie,
      body: { email: "joiner@stackmate.local", name: "Joiner Person", role_keys: ["support_agent"] },
    });
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    const token = invited.body.data.token_once as string;
    assert.ok(token, "token_once must be returned");

    const accepted = await apiRequest("/api/auth/accept-invitation", {
      method: "POST",
      body: { token, name: "Joiner Person", password: "JoinerPass123!" },
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.user.email, "joiner@stackmate.local");

    // The invite token email IS the verification step: the accepted
    // user starts verified (contrast with admin-created users, who
    // start unverified) and signs in without any verification step.
    const created = store.state.users.find((u) => u.email === "joiner@stackmate.local");
    assert.ok(created, "the accepted user must exist in the store");
    assert.equal(created.email_verified, true, "invite-accepted user must start verified");
    const signIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "joiner@stackmate.local", password: "JoinerPass123!" },
    });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
  });
});
