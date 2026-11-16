/**
 * Two-factor origin check regression (Auth + Email fix batch).
 *
 * LIVE BUG: the 2FA setup password gate returned 403 with the CORRECT
 * password. The password was fine — Better Auth's originCheckMiddleware
 * 403s any POST to /api/auth/* whose Origin is not trusted, and the
 * live BETTER_AUTH_URL/TRUSTED_ORIGINS did not cover the Worker URL
 * the same-origin SPA posts from. The suite never saw it because the
 * check is skipped in tests by default: skipOriginCheck =
 * disableOriginCheck ?? isTest(), and isTest() is true under vitest
 * (NODE_ENV=test AND TEST=true, which vitest sets — so no env tweak
 * can turn it on). The product therefore pins
 * `advanced.disableOriginCheck: false` in createBetterAuth, so the
 * check runs in vitest exactly as in production; this file proves it
 * (an untrusted origin MUST 403) and proves the fix (the app's own
 * API_URL origin is trusted even when BETTER_AUTH_URL points
 * elsewhere and TRUSTED_ORIGINS does not cover it).
 *
 * Env here mirrors the live suspicion: BETTER_AUTH_URL points at an
 * unrelated host and TRUSTED_ORIGINS does not cover the request
 * origin — only API_URL does.
 *
 * Rate limit note: the two-factor plugin allows 3 calls per 10s on
 * /two-factor/*, so the enable attempts sleep 11s apart (~33s total).
 *
 * Requires DATABASE_URL to a LOCAL test Postgres (same pattern as
 * auth-email.test.ts); creates its own fresh database
 * `stackmate_test_two_factor_origin` and drops it afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const ORIGIN_DB_NAME = "stackmate_test_two_factor_origin";
const API_BASE = "http://localhost:8787";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** RFC 6238 TOTP (SHA-1, 30s period, 6 digits) — same helper as auth-email.test.ts. */
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

describe.skipIf(!DATABASE_URL)("two-factor origin check (check ON)", () => {
  let env: import("../src/env.ts").StackMateBindings;
  let app: import("../src/app.ts").StackMateAppInstance;
  let store: any;
  let adminClient: Client;
  let sessionCookie = "";

  async function apiRequest(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      origin?: string;
      referer?: string;
    } = {}
  ): Promise<{ status: number; headers: Headers; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.origin !== undefined) headers.set("Origin", options.origin);
    if (options.referer !== undefined) headers.set("Referer", options.referer);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(new Request(`${API_BASE}${path}`, init), env);
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

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const url = new URL(DATABASE_URL);
    assert.ok(
      url.pathname.replace(/^\//, "").includes("test"),
      "Refusing to run: DATABASE_URL database name must contain 'test'."
    );

    // Dynamic imports AFTER the NODE_ENV assignment above, so
    // better-auth's module-level nodeENV reads "development".
    const { createStackMateApp } = await import("../src/app.ts");
    const { resolveRuntimeConfig } = await import("../src/env.ts");
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");

    env = resolveRuntimeConfig({
      APP_ENV: "test",
      SETUP_TOKEN: TEST_SETUP_TOKEN,
      // Deliberately NOT the request origin: the live suspicion is a
      // stale BETTER_AUTH_URL. Only API_URL (the SPA's own origin)
      // covers the request — the fix trusts exactly that.
      BETTER_AUTH_URL: "https://auth.example.com",
      TRUSTED_ORIGINS: "https://trusted.example.com",
      API_URL: API_BASE,
      APP_URL: API_BASE,
    });

    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    const maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${ORIGIN_DB_NAME}"`);
    await maintenanceClient.query(`CREATE DATABASE "${ORIGIN_DB_NAME}"`);
    await maintenanceClient.end();

    const originUrl = new URL(DATABASE_URL);
    originUrl.pathname = `/${ORIGIN_DB_NAME}`;
    const dbUrl = originUrl.toString();

    adminClient = new Client({ connectionString: dbUrl });
    await adminClient.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      await adminClient.query(sql);
    }

    store = await DrizzleStore.create({ connectionString: dbUrl });
    app = createStackMateApp(store);

    // Bootstrap the super admin (same shape as the live account) and
    // sign in via the custom endpoint — the live failure was exactly
    // this account's 2FA setup.
    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Two Factor Origin",
        email: "origin-2fa@example.com",
        password: "SuperAdminPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signedIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "origin-2fa@example.com", password: "SuperAdminPass123!" },
    });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    sessionCookie = cookiePairs(signedIn.headers);
    assert.ok(sessionCookie.includes("better-auth.session_token"));
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
      await mc.query(`DROP DATABASE IF EXISTS "${ORIGIN_DB_NAME}"`);
      await mc.end();
    } catch {}
  });

  async function enableTwoFactor(origin?: string, referer?: string) {
    // exactOptionalPropertyTypes: only pass origin/referer when set —
    // the no-Origin case is a real test (MISSING_OR_NULL_ORIGIN).
    return apiRequest("/api/auth/two-factor/enable", {
      method: "POST",
      body: { password: "SuperAdminPass123!" },
      cookie: sessionCookie,
      ...(origin !== undefined ? { origin } : {}),
      ...(referer !== undefined ? { referer } : {}),
    });
  }

  it("rejects an untrusted cross-site origin (proves the check is ON in this file)", async () => {
    const res = await enableTwoFactor("https://evil.example.com", "https://evil.example.com/");
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "INVALID_ORIGIN");
  }, 60_000);

  it("accepts the app's own API_URL origin (the fix: stale BETTER_AUTH_URL cannot lock out the SPA)", async () => {
    await sleep(11_000);
    const res = await enableTwoFactor(API_BASE, `${API_BASE}/`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(
      typeof res.body.totpURI === "string" && res.body.totpURI.startsWith("otpauth://totp/"),
      "enable must return a totpURI (the QR)"
    );
    assert.ok(
      Array.isArray(res.body.backupCodes) && res.body.backupCodes.length > 0,
      "enable must return backup codes"
    );
  }, 60_000);

  it("rejects a request with a session cookie but no Origin/Referer", async () => {
    await sleep(11_000);
    const res = await enableTwoFactor();
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "MISSING_OR_NULL_ORIGIN");
  }, 60_000);

  it("completes the full setup flow with the origin check on (password gate → QR → verify)", async () => {
    await sleep(11_000);
    const enable = await enableTwoFactor(API_BASE, `${API_BASE}/`);
    assert.equal(enable.status, 200, `enable failed: ${JSON.stringify(enable.body)}`);
    const secret = new URL(enable.body.totpURI as string).searchParams.get("secret");
    assert.ok(secret, "totpURI must carry a secret");

    const verify = await apiRequest("/api/auth/two-factor/verify-totp", {
      method: "POST",
      body: { code: totp(secret), trustDevice: false },
      cookie: sessionCookie,
      origin: API_BASE,
      referer: `${API_BASE}/`,
    });
    assert.equal(verify.status, 200, `verify-totp failed: ${JSON.stringify(verify.body)}`);

    // verify-totp rotates the session: the pre-2FA cookie is dead,
    // the response carries the new session cookie.
    const cookieAfterVerify = cookiePairs(verify.headers) || sessionCookie;
    const me = await apiRequest("/api/v1/admin/me", { cookie: cookieAfterVerify });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.two_factor_enabled, true);
  }, 120_000);
});
