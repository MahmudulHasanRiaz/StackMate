/**
 * Two-factor origin DIAGNOSIS (2026-11-16) — NOT another guess-fix.
 *
 * LIVE SYMPTOM: POST /api/auth/two-factor/enable returns Better Auth
 * INVALID_ORIGIN ("Invalid origin") with the CORRECT password, on the
 * real staging SPA. Fix #1 (trustedOrigins incl. API_URL/APP_URL +
 * disableOriginCheck: false) and fix #2 (normalizeTrustedOrigin on
 * every entry) both pass vitest but BOTH fail live, on a deploy
 * confirmed live (Cloudflare dashboard: version 51e76ebf, commit
 * b29433f4, Success, 100% traffic; clean re-test after the deploy
 * finished still fails). The "mid-rollout" explanation is dead.
 *
 * This file pins down the mechanism with POSITIVE evidence, through
 * the FULL app dispatcher (createStackMateApp + fetch, the exact path
 * the SPA takes):
 *
 * 1. `$context` probe — `auth.$context.trustedOrigins` is the exact
 *    list Better Auth's originCheckMiddleware compares against (the
 *    handler re-computes it per request via getTrustedOrigins, from the
 *    SAME init options — verified against the installed
 *    better-auth 1.7.23 dist, dist/auth/base.mjs). Each env shape
 *    asserts the exact list contents.
 * 2. HTTP matrix — POST /api/auth/two-factor/enable with the exact
 *    live request shape (session cookie + Origin header) under each
 *    env shape. A shape MUST fail before a fix and pass after — if a
 *    shape already passes here, no code fix for that shape may ship.
 * 3. Admin CSRF-gate probe — PATCH /api/v1/admin/me with the same
 *    Origin under the trusted-only shape: the app's own gate
 *    (app.ts, exact `.includes` on env.TRUSTED_ORIGINS) must pass
 *    exactly when Better Auth passes, or the two gates disagree about
 *    the same env — which would itself be the mechanism.
 *
 * Env shapes (request Origin is STAGING_ORIGIN in every row — the
 * exact value a browser sends for the staging SPA):
 * - S1 all-correct: all four URL vars name the staging origin.
 * - S2 trusted-only: ONLY TRUSTED_ORIGINS names it (exact, no
 *   trailing slash); BETTER_AUTH_URL/API_URL/APP_URL are localhost.
 *   This is the shape the live admin POSTs prove: state-changing
 *   /api/v1/admin/* POSTs succeed live, and the app CSRF gate passes
 *   them ONLY when env.TRUSTED_ORIGINS contains the exact Origin.
 * - S3 all-localhost: no var names the staging origin (the
 *   dashboard-vars-unset shape). MUST fail 403 INVALID_ORIGIN —
 *   the repro of the live failure under the missing-vars hypothesis.
 * - S4 trusted-empty: TRUSTED_ORIGINS empty, the other three name
 *   the staging origin (proves the other vars cover).
 *
 * Rate limit note: the two-factor plugin allows 3 calls per 10s on
 * /two-factor/*, so the enable attempts sleep 11s apart.
 *
 * UPDATE (ADR-0008 decision 10, follow-up batch 2026-11-16): the
 * blind-gate finding below is FIXED — `parseSessionCookie` now
 * recognises `__Secure-better-auth.session_token`, so the staging
 * test's PATCH assertion is 403 (gate enforces), not 200. The
 * dedicated enforcement suite is `csrf-gate-secure-cookie.test.ts`
 * (same-origin 200 / cross-origin 403 / 2FA 200 + QR, staging env
 * with all four URL vars set).
 *
 * Requires DATABASE_URL to a LOCAL test Postgres (same pattern as
 * two-factor-origin.test.ts); creates its own fresh database
 * `stackmate_test_two_factor_origin_diag` and drops it afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const ORIGIN_DB_NAME = "stackmate_test_two_factor_origin_diag";
const API_BASE = "http://localhost:8787";
// The live staging origin (the browser's Origin header on the real
// SPA — no trailing slash, no path).
const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";
const LOCALHOST_URLS = "http://localhost:5173,http://localhost:8787";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN = "0123456789abcdef".repeat(4);
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!DATABASE_URL)("two-factor origin diagnosis (check ON)", () => {
  let env: import("../src/env.ts").StackMateBindings;
  let envS1: import("../src/env.ts").StackMateBindings;
  let envS2: import("../src/env.ts").StackMateBindings;
  let envS3: import("../src/env.ts").StackMateBindings;
  let envS4: import("../src/env.ts").StackMateBindings;
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
    } = {},
    envOverride?: import("../src/env.ts").StackMateBindings
  ): Promise<{ status: number; headers: Headers; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.origin !== undefined) headers.set("Origin", options.origin);
    if (options.referer !== undefined) headers.set("Referer", options.referer);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(new Request(`${API_BASE}${path}`, init), envOverride ?? env);
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

    const { createStackMateApp } = await import("../src/app.ts");
    const { resolveRuntimeConfig } = await import("../src/env.ts");
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");

    env = resolveRuntimeConfig({
      APP_ENV: "test",
SETUP_TOKEN: TEST_SETUP_TOKEN,
      BETTER_AUTH_URL: "https://auth.example.com",
      TRUSTED_ORIGINS: "https://trusted.example.com",
      API_URL: API_BASE,
      APP_URL: API_BASE,
    });

    // S1: every URL var names the staging origin.
    envS1 = {
      ...env,
      BETTER_AUTH_URL: STAGING_ORIGIN,
      TRUSTED_ORIGINS: STAGING_ORIGIN,
      API_URL: STAGING_ORIGIN,
      APP_URL: STAGING_ORIGIN,
    };
    // S2: ONLY TRUSTED_ORIGINS names it (exact, no trailing slash);
    // the other three are the localhost fallbacks a live Worker sees
    // when the dashboard vars are unset.
    envS2 = {
      ...env,
      BETTER_AUTH_URL: "http://localhost:8787",
      TRUSTED_ORIGINS: STAGING_ORIGIN,
      API_URL: "http://localhost:8787",
      APP_URL: "http://localhost:5173",
    };
    // S3: nothing names the staging origin (dashboard vars unset).
    envS3 = {
      ...env,
      BETTER_AUTH_URL: "http://localhost:8787",
      TRUSTED_ORIGINS: LOCALHOST_URLS,
      API_URL: "http://localhost:8787",
      APP_URL: "http://localhost:5173",
    };
    // S4: TRUSTED_ORIGINS empty; the other three name the origin.
    envS4 = {
      ...env,
      BETTER_AUTH_URL: STAGING_ORIGIN,
      TRUSTED_ORIGINS: "",
      API_URL: STAGING_ORIGIN,
      APP_URL: STAGING_ORIGIN,
    };

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

    const boot = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Two Factor Diagnosis",
        email: "diag-2fa@example.com",
        password: "SuperAdminPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signedIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "diag-2fa@example.com", password: "SuperAdminPass123!" },
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

  async function enableTwoFactor(
    origin?: string,
    referer?: string,
    envOverride?: import("../src/env.ts").StackMateBindings
  ) {
    return apiRequest(
      "/api/auth/two-factor/enable",
      {
        method: "POST",
        body: { password: "SuperAdminPass123!" },
        cookie: sessionCookie,
        ...(origin !== undefined ? { origin } : {}),
        ...(referer !== undefined ? { referer } : {}),
      },
      envOverride
    );
  }

  /** The exact trusted-origin list Better Auth compares against. */
  async function trustedList(
    envOverride: import("../src/env.ts").StackMateBindings
  ): Promise<string[]> {
    const { createBetterAuth } = await import("../src/modules/identity/better-auth.ts");
    const auth = createBetterAuth(envOverride, store.drizzleDb);
    const ctx = (await (
      auth as unknown as {
        $context: Promise<{
          trustedOrigins: string[];
          options: { trustedOrigins: unknown };
        }>;
      }
    ).$context) as { trustedOrigins: string[]; options: { trustedOrigins: unknown } };
    return ctx.trustedOrigins;
  }

  it("S1 $context list contains the staging origin (all vars correct)", async () => {
    const list = await trustedList(envS1);
    assert.ok(
      list.includes(STAGING_ORIGIN),
      `S1 list must contain the staging origin, got ${JSON.stringify(list)}`
    );
  }, 60_000);

  it("S2 $context list contains the staging origin (TRUSTED_ORIGINS only)", async () => {
    const list = await trustedList(envS2);
    assert.ok(
      list.includes(STAGING_ORIGIN),
      `S2 list must contain the staging origin, got ${JSON.stringify(list)}`
    );
  }, 60_000);

  it("S3 $context list does NOT contain the staging origin (all localhost)", async () => {
    const list = await trustedList(envS3);
    assert.ok(
      !list.includes(STAGING_ORIGIN),
      `S3 list must NOT contain the staging origin, got ${JSON.stringify(list)}`
    );
  }, 60_000);

  it("S4 $context list contains the staging origin (TRUSTED_ORIGINS empty)", async () => {
    const list = await trustedList(envS4);
    assert.ok(
      list.includes(STAGING_ORIGIN),
      `S4 list must contain the staging origin, got ${JSON.stringify(list)}`
    );
  }, 60_000);

  it("S1 enable accepts the staging origin (control)", async () => {
    const res = await enableTwoFactor(STAGING_ORIGIN, `${STAGING_ORIGIN}/settings/authentication`, envS1);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(
      typeof res.body.totpURI === "string" && res.body.totpURI.startsWith("otpauth://totp/"),
      "enable must return a totpURI (the QR)"
    );
  }, 60_000);

  it("S2 enable accepts the staging origin (TRUSTED_ORIGINS only — the proven-live shape)", async () => {
    await sleep(11_000);
    const res = await enableTwoFactor(STAGING_ORIGIN, `${STAGING_ORIGIN}/settings/authentication`, envS2);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(
      typeof res.body.totpURI === "string" && res.body.totpURI.startsWith("otpauth://totp/"),
      "enable must return a totpURI (the QR)"
    );
  }, 60_000);

  it("S3 enable rejects the staging origin with INVALID_ORIGIN (all localhost — the missing-vars repro)", async () => {
    await sleep(11_000);
    const res = await enableTwoFactor(STAGING_ORIGIN, `${STAGING_ORIGIN}/settings/authentication`, envS3);
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "INVALID_ORIGIN");
  }, 60_000);

  it("S4 enable accepts the staging origin (TRUSTED_ORIGINS empty, others cover)", async () => {
    await sleep(11_000);
    const res = await enableTwoFactor(STAGING_ORIGIN, `${STAGING_ORIGIN}/settings/authentication`, envS4);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(
      typeof res.body.totpURI === "string" && res.body.totpURI.startsWith("otpauth://totp/"),
      "enable must return a totpURI (the QR)"
    );
  }, 60_000);

  it("no Origin + staging Referer accepts (Referer fallback path)", async () => {
    await sleep(11_000);
    const res = await enableTwoFactor(undefined, `${STAGING_ORIGIN}/settings/authentication`, envS1);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(
      typeof res.body.totpURI === "string" && res.body.totpURI.startsWith("otpauth://totp/"),
      "enable must return a totpURI (the QR)"
    );
  }, 60_000);

  it("admin CSRF gate passes the same Origin under S2 (the two gates must agree)", async () => {
    const res = await apiRequest(
      "/api/v1/admin/me",
      {
        method: "PATCH",
        body: { name: "Two Factor Diagnosis" },
        cookie: sessionCookie,
        origin: STAGING_ORIGIN,
      },
      envS2
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  }, 60_000);

  it("admin CSRF gate rejects the same Origin under S3 (the gate reads the same env)", async () => {
    const res = await apiRequest(
      "/api/v1/admin/me",
      {
        method: "PATCH",
        body: { name: "Two Factor Diagnosis" },
        cookie: sessionCookie,
        origin: STAGING_ORIGIN,
      },
      envS3
    );
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  }, 60_000);

  // LIVE-SHAPE PROOF (the paradox, resolved): in staging/production
  // Better Auth sets the session cookie as
  // `__Secure-better-auth.session_token` (useSecureCookies, verified
  // against dist/cookies/index.mjs:23), but parseSessionCookie
  // (app.ts:190) recognised only `stackmate_session`,
  // `__Host-stackmate_session` and the bare
  // `better-auth.session_token`. The app CSRF gate therefore NEVER
  // fired live — admin POSTs passed whatever env.TRUSTED_ORIGINS
  // held, so they proved NOTHING about the dashboard vars. Better
  // Auth's own cookie parser DOES check the `__Secure-` name first
  // (dist/cookies/index.mjs:269), so its origin check fires normally.
  // Under the all-localhost (S3) env shape the live combination was
  // exactly: admin POST passes, 2FA enable 403s INVALID_ORIGIN.
  // FIXED (ADR-0008 decision 10, follow-up batch): parseSessionCookie
  // now recognises `__Secure-better-auth.session_token`, so the gate
  // enforces — the PATCH below now 403s under S3 env instead of
  // passing. The 2FA 403 INVALID_ORIGIN is unchanged (the vars are
  // still missing in this shape); the dedicated enforcement suite is
  // `csrf-gate-secure-cookie.test.ts`.
  // UPDATE (H-7, audit fix 2026-11-19): staging/production FAILS
  // CLOSED when any URL var points at localhost, so the literal
  // all-localhost S3 shape can no longer boot. The env below keeps
  // the S3 mismatch structure with placeholder hosts that still do
  // not name the staging origin: TRUSTED_ORIGINS excludes it (the
  // PATCH still 403s via the app CSRF gate) and BETTER_AUTH_URL
  // names a different host (2FA enable still 403s INVALID_ORIGIN).
  it("staging cookie is __Secure- prefixed and the app CSRF gate now enforces it (S3 env, decision 10)", async () => {
    const originUrl = new URL(DATABASE_URL!);
    originUrl.pathname = `/${ORIGIN_DB_NAME}`;
    const dbUrl = originUrl.toString();
    const { createStackMateApp } = await import("../src/app.ts");
    const { resolveRuntimeConfig } = await import("../src/env.ts");
    const hex64 = "0123456789abcdef".repeat(4);
    const envStaging = resolveRuntimeConfig({
      APP_ENV: "staging",
      BETTER_AUTH_SECRET: hex64,
      ENCRYPTION_KEY_V1: hex64,
      LICENSE_VERIFIER_SECRET: hex64,
      CHECKOUT_TOKEN_SECRET: hex64,
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
      BETTER_AUTH_URL: "https://auth.example.com",
      TRUSTED_ORIGINS: "https://app.example.com,https://api.example.com",
      API_URL: "https://api.example.com",
      APP_URL: "https://app.example.com",
    });
    const stagingApp = createStackMateApp(store);
    const stagingFetch = async (
      path: string,
      options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}
    ) => {
      const headers = new Headers();
      if (options.body !== undefined) headers.set("Content-Type", "application/json");
      if (options.cookie) headers.set("Cookie", options.cookie);
      if (options.origin !== undefined) headers.set("Origin", options.origin);
      const init: RequestInit = { method: options.method ?? "GET", headers };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      const res = await stagingApp.fetch(
        new Request(`${API_BASE}${path}`, init),
        envStaging
      );
      const text = await res.text();
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, headers: res.headers, body };
    };
    const signedIn = await stagingFetch("/api/auth/sign-in", {
      method: "POST",
      body: { email: "diag-2fa@example.com", password: "SuperAdminPass123!" },
    });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    const stagingCookie = cookiePairs(signedIn.headers);
    assert.ok(
      stagingCookie.startsWith("__Secure-better-auth.session_token="),
      `staging session cookie must be __Secure- prefixed, got ${stagingCookie}`
    );
    // Same Origin, same cookie, S3 env: the app gate now sees the
    // __Secure- cookie and enforces — the staging Origin is NOT in
    // this env's TRUSTED_ORIGINS (placeholder hosts only), so the PATCH 403s.
    // Before decision 10 this returned 200 (blind gate).
    const patched = await stagingFetch("/api/v1/admin/me", {
      method: "PATCH",
      body: { name: "Two Factor Diagnosis" },
      cookie: stagingCookie,
      origin: STAGING_ORIGIN,
    });
    assert.equal(patched.status, 403, `expected 403, got ${patched.status}: ${JSON.stringify(patched.body)}`);
    assert.ok(
      JSON.stringify(patched.body).includes("blocked by CSRF policy"),
      `403 must be the app CSRF gate, got ${JSON.stringify(patched.body)}`
    );
    // And the 2FA gate on the same app, same cookie, same Origin:
    // Better Auth's check fires — the live symptom, reproduced.
    await sleep(11_000);
    const enable = await stagingFetch("/api/auth/two-factor/enable", {
      method: "POST",
      body: { password: "SuperAdminPass123!" },
      cookie: stagingCookie,
      origin: STAGING_ORIGIN,
    });
    assert.equal(enable.status, 403, `expected 403, got ${enable.status}: ${JSON.stringify(enable.body)}`);
    assert.equal(enable.body.code, "INVALID_ORIGIN");
  }, 120_000);
});
