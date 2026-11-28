/**
 * General Settings tests (Auth + Email batch, owner order 2026-11-16).
 *
 * Covers: defaults on the public endpoint, PUT validation (name/title/
 * description/email), save → public render, favicon upload (PNG ok,
 * wrong magic 415, oversize 413, SVG with script rejected), favicon
 * streaming via GET /api/v1/favicon, favicon clear, and the audit row.
 * Runs against a hermetic Postgres database (migrations 0000–0008).
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { drainConnectionCache } from "../src/platform/db/connection-cache.ts";

const DATABASE_URL = process.env.DATABASE_URL!;
const DB_NAME = "stackmate_test_general_settings";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);
const SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// A minimal 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe.skipIf(!DATABASE_URL)("General Settings (Postgres)", () => {
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let store: { close: () => Promise<void> };
  let adminClient: Client;
  let superCookie = "";

  const api = async (
    p: string,
    opts: { method?: string; body?: unknown; cookie?: string } = {}
  ) => {
    const headers = new Headers();
    if (opts.body !== undefined) headers.set("Content-Type", "application/json");
    if (opts.cookie) headers.set("Cookie", opts.cookie);
    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await app.fetch(
      new Request(`http://localhost:8787${p}`, init),
      env
    );
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body: body as Record<string, any> };
  };

  const cookiePairs = (headers: Headers): string => {
    const setCookies =
      typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    return setCookies.map((c) => c.split(";")[0]!).join("; ");
  };

  beforeAll(async () => {
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN });
    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await maintenance.query(`CREATE DATABASE "${DB_NAME}"`);
    await maintenance.end();

    const dbUrl = new URL(DATABASE_URL);
    dbUrl.pathname = `/${DB_NAME}`;
    adminClient = new Client({ connectionString: dbUrl.toString() });
    await adminClient.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      await adminClient.query(
        await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8")
      );
    }
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
    store = await DrizzleStore.create({ connectionString: dbUrl.toString() });
    app = createStackMateApp(store as never);

    const boot = await api("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "Super Admin",
        email: "super@example.com",
        password: "SuperAdminPass123!",
        setupToken: SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signedIn = await api("/api/auth/sign-in", {
      method: "POST",
      body: { email: "super@example.com", password: "SuperAdminPass123!" },
    });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    superCookie = cookiePairs(signedIn.headers);
    assert.ok(superCookie.includes("better-auth.session_token"));
  }, 120_000);

  afterAll(async () => {
    await store.close();
    await adminClient.end();
    // B-01 reuse: close() parks the store's client in the connection
    // cache instead of ending it — drain it or DROP DATABASE refuses
    // while the backend is still attached.
    drainConnectionCache();
    const maintenanceUrl = new URL(DATABASE_URL);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await maintenance.end();
  });

  it("public config returns defaults before any save", async () => {
    const res = await api("/api/v1/general-config");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.app_name, "StackMate");
    assert.equal(res.body.data.app_title, "StackMate Admin");
    assert.equal(res.body.data.app_description, "");
    assert.equal(res.body.data.support_email, "");
    assert.equal(res.body.data.favicon_url, null);
    // M-20: with no favicon configured the endpoint serves the embedded
    // default SVG instead of 404ing.
    const fav = await api("/api/v1/favicon");
    assert.equal(fav.status, 200);
    assert.equal(fav.headers.get("Content-Type"), "image/svg+xml");
  });

  it("PUT validates: empty name/title, bad email, long description", async () => {
    for (const body of [
      { app_name: "  " },
      { app_title: "" },
      { support_email: "not-an-email" },
      { app_description: "x".repeat(501) },
    ]) {
      const res = await api("/api/v1/admin/general-settings", {
        method: "PUT",
        body,
        cookie: superCookie,
      });
      assert.equal(res.status, 422, JSON.stringify(body));
    }
  });

  it("PUT saves and the public endpoint renders the new values", async () => {
    const saved = await api("/api/v1/admin/general-settings", {
      method: "PUT",
      body: {
        app_name: "Acme Admin",
        app_title: "Acme — Admin",
        app_description: "One platform for everything.",
        support_email: "support@acme.example",
      },
      cookie: superCookie,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.app_name, "Acme Admin");
    const pub = await api("/api/v1/general-config");
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.data.app_name, "Acme Admin");
    assert.equal(pub.body.data.app_title, "Acme — Admin");
    assert.equal(pub.body.data.app_description, "One platform for everything.");
    assert.equal(pub.body.data.support_email, "support@acme.example");
    assert.equal(pub.body.data.favicon_url, null);
  });

  it("favicon: PNG upload stores in R2 and streams back; bad files rejected", async () => {
    const uploaded = await api("/api/v1/admin/general-settings/favicon", {
      method: "POST",
      body: {
        filename: "favicon.png",
        content_type: "image/png",
        content_base64: PNG_1X1_BASE64,
      },
      cookie: superCookie,
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.data.favicon_url, "/api/v1/favicon");
    assert.equal(uploaded.body.data.content_type, "image/png");

    const pub = await api("/api/v1/general-config");
    assert.equal(pub.body.data.favicon_url, "/api/v1/favicon");

    const fav = await api("/api/v1/favicon");
    assert.equal(fav.status, 200);
    assert.equal(fav.headers.get("Content-Type"), "image/png");
    // Byte-exactness of the streamed file is asserted in the next test
    // (this helper parses bodies as JSON/text, so it cannot compare bytes).

    // Wrong magic bytes for the declared type.
    const badMagic = await api("/api/v1/admin/general-settings/favicon", {
      method: "POST",
      body: {
        filename: "fake.png",
        content_type: "image/png",
        content_base64: Buffer.from("not a png at all").toString("base64"),
      },
      cookie: superCookie,
    });
    assert.equal(badMagic.status, 415, JSON.stringify(badMagic.body));

    // SVG containing a script is rejected.
    const badSvg = await api("/api/v1/admin/general-settings/favicon", {
      method: "POST",
      body: {
        filename: "evil.svg",
        content_type: "image/svg+xml",
        content_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64"),
      },
      cookie: superCookie,
    });
    assert.equal(badSvg.status, 415, JSON.stringify(badSvg.body));

    // Oversize (>256KB).
    const big = await api("/api/v1/admin/general-settings/favicon", {
      method: "POST",
      body: {
        filename: "big.png",
        content_type: "image/png",
        content_base64: Buffer.alloc(300 * 1024, 0).toString("base64"),
      },
      cookie: superCookie,
    });
    assert.equal(big.status, 413, JSON.stringify(big.body));

    // Clear the favicon: public URL goes back to null, endpoint serves
    // the embedded default again (M-20).
    const cleared = await api("/api/v1/admin/general-settings", {
      method: "PUT",
      body: { clear_favicon: true },
      cookie: superCookie,
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.data.favicon_url, null);
    const pub2 = await api("/api/v1/general-config");
    assert.equal(pub2.body.data.favicon_url, null);
    const fav2 = await api("/api/v1/favicon");
    assert.equal(fav2.status, 200);
    assert.equal(fav2.headers.get("Content-Type"), "image/svg+xml");
  });

  it("favicon bytes stream back exactly", async () => {
    const uploaded = await api("/api/v1/admin/general-settings/favicon", {
      method: "POST",
      body: {
        filename: "favicon.png",
        content_type: "image/png",
        content_base64: PNG_1X1_BASE64,
      },
      cookie: superCookie,
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    // Raw fetch (no JSON parsing) to compare bytes.
    const res = await app.fetch(
      new Request("http://localhost:8787/api/v1/favicon"),
      env
    );
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(
      buf.toString("base64"),
      PNG_1X1_BASE64,
      "the streamed favicon must be byte-identical to the upload"
    );
    // Clean up for the audit test below.
    await api("/api/v1/admin/general-settings", {
      method: "PUT",
      body: { clear_favicon: true },
      cookie: superCookie,
    });
  });

  it("PUT is audit-logged as general.settings.updated", async () => {
    const logs = await api(
      "/api/v1/admin/audit-logs?resource_type=general_settings",
      { cookie: superCookie }
    );
    assert.equal(logs.status, 200, JSON.stringify(logs.body));
    const actions = (logs.body.data.items as Array<{ action: string }>).map((r) => r.action);
    assert.ok(
      actions.includes("general.settings.updated"),
      `expected general.settings.updated in ${JSON.stringify(actions)}`
    );
  });
});
