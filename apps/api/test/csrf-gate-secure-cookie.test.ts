/**
 * CSRF-gate fix — the app's own CSRF gate must see the staging cookie
 * (ADR-0008 decision 10, follow-up batch 2026-11-16).
 *
 * BACKGROUND: `parseSessionCookie` (app.ts:190) recognised only
 * `stackmate_session`, `__Host-stackmate_session` and the bare
 * `better-auth.session_token`, but in staging/production Better Auth
 * sets the session cookie as `__Secure-better-auth.session_token`
 * (`useSecureCookies: isProd`). The gate's `sessionCookie && …`
 * condition was therefore never true live, so a cross-site POST with
 * the victim's cookies passed the app's `/api/v1/admin/*` protection.
 * The diagnosis suite
 * (`two-factor-origin-diagnosis.test.ts`, staging-shape test) proved
 * the blindness: PATCH /api/v1/admin/me with an untrusted Origin
 * under the all-localhost env returned 200.
 *
 * FIX: one line — add `"__Secure-better-auth.session_token"` to
 * `parseSessionCookie`. The tests below run against the staging env
 * shape (APP_ENV=staging, all four URL vars naming the staging
 * origin — the env the live Worker now has, with the vars durable in
 * `wrangler.jsonc` env.staging.vars):
 *   (a) same-origin PATCH with the __Secure- cookie → 200 (gate passes)
 *   (b) cross-origin PATCH with the __Secure- cookie + untrusted
 *       Origin → 403 (gate enforces — this row MUST fail before the
 *       fix: the blind gate lets it through as 200)
 *   (c) 2FA enable with the vars set → 200 + QR (no regression:
 *       the gate fix must not break the flow the vars were set for)
 *
 * Requires DATABASE_URL to a LOCAL test Postgres (same pattern as
 * two-factor-origin-diagnosis.test.ts); creates its own fresh database
 * `stackmate_test_csrf_gate` and drops it afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const GATE_DB_NAME = "stackmate_test_csrf_gate";
const API_BASE = "http://localhost:8787";
// The live staging origin (the browser's Origin header on the real
// SPA — no trailing slash, no path).
const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";
const EVIL_ORIGIN = "https://evil.example.com";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN = "0123456789abcdef".repeat(4);

describe.skipIf(!DATABASE_URL)("CSRF gate sees the __Secure- session cookie (check ON)", () => {
  let envStaging: import("../src/env.ts").StackMateBindings;
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
    } = {}
  ): Promise<{ status: number; headers: Headers; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.origin !== undefined) headers.set("Origin", options.origin);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await app.fetch(new Request(`${API_BASE}${path}`, init), envStaging);
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

    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    const maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${GATE_DB_NAME}"`);
    await maintenanceClient.query(`CREATE DATABASE "${GATE_DB_NAME}"`);
    await maintenanceClient.end();

    const gateUrl = new URL(DATABASE_URL);
    gateUrl.pathname = `/${GATE_DB_NAME}`;
    const dbUrl = gateUrl.toString();

    // Staging env shape, all four URL vars naming the staging origin
    // (the env the live Worker now has — vars durable in
    // wrangler.jsonc env.staging.vars, decision 10). The Hyperdrive
    // binding is validated by resolveRuntimeConfig in staging/prod;
    // the store itself is created directly from dbUrl below.
    const hex64 = "0123456789abcdef".repeat(4);
    envStaging = resolveRuntimeConfig({
      APP_ENV: "staging",
      BETTER_AUTH_SECRET: hex64,
      ENCRYPTION_KEY_V1: hex64,
      LICENSE_VERIFIER_SECRET: hex64,
      CHECKOUT_TOKEN_SECRET: hex64,
      SETUP_TOKEN: TEST_SETUP_TOKEN,
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
      BETTER_AUTH_URL: STAGING_ORIGIN,
      TRUSTED_ORIGINS: STAGING_ORIGIN,
      API_URL: STAGING_ORIGIN,
      APP_URL: STAGING_ORIGIN,
    });

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
        name: "CSRF Gate",
        email: "csrf-gate@example.com",
        password: "SuperAdminPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signedIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "csrf-gate@example.com", password: "SuperAdminPass123!" },
    });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    sessionCookie = cookiePairs(signedIn.headers);
    assert.ok(
      sessionCookie.startsWith("__Secure-better-auth.session_token="),
      `staging session cookie must be __Secure- prefixed, got ${sessionCookie}`
    );
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
      await mc.query(`DROP DATABASE IF EXISTS "${GATE_DB_NAME}"`);
      await mc.end();
    } catch {}
  });

  it("(a) same-origin PATCH /api/v1/admin/me with the __Secure- cookie passes the gate → 200", async () => {
    const res = await apiRequest("/api/v1/admin/me", {
      method: "PATCH",
      body: { name: "CSRF Gate" },
      cookie: sessionCookie,
      origin: STAGING_ORIGIN,
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  }, 60_000);

  it("(b) cross-origin PATCH with the __Secure- cookie and an untrusted Origin → 403 (gate enforces)", async () => {
    const res = await apiRequest("/api/v1/admin/me", {
      method: "PATCH",
      body: { name: "CSRF Gate" },
      cookie: sessionCookie,
      origin: EVIL_ORIGIN,
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(
      JSON.stringify(res.body).includes("blocked by CSRF policy"),
      `403 must be the app CSRF gate, got ${JSON.stringify(res.body)}`
    );
  }, 60_000);

  it("(c) 2FA enable with the vars set still → 200 + QR (no regression)", async () => {
    const res = await apiRequest("/api/auth/two-factor/enable", {
      method: "POST",
      body: { password: "SuperAdminPass123!" },
      cookie: sessionCookie,
      origin: STAGING_ORIGIN,
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(
      typeof res.body.totpURI === "string" && res.body.totpURI.startsWith("otpauth://totp/"),
      "enable must return a totpURI (the QR)"
    );
  }, 60_000);
});
