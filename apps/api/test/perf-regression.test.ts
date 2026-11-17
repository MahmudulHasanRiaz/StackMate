/**
 * Perf regression tests (2026-11-15) — the staging slowness fix, as
 * reverted the same evening.
 *
 * Staging measured 13–35s per request: every request ran a fresh pg
 * Client + connect + detectCapabilities + assertRequiredTables + a
 * 48-query sequential full-state load, and every withTransaction
 * re-ran the full load. The Batch 0 fix (ONE combined JSON load
 * statement, caps/tables cached, ONE shared pg Client per Worker
 * isolate) cut that to ~10 queries/request — but the shared client
 * poisoned warm isolates: its per-client promise-chain queue created
 * promises in one request and awaited them in another, which throws
 * under Cloudflare's handle_cross_request_promise_resolution flag
 * (live Worker logs, 12/12 store-dependent calls failing). The
 * revert (ADR-0005, evening amendment) keeps the combined load + the
 * caps/tables cache and goes back to REQUEST-SCOPED clients: one
 * fresh client per create(), closed when the request finishes. These
 * tests pin the reverted behavior so it cannot silently regress:
 *
 *  1. Caps/tables are detected once per connection string (plain-value
 *     cache), not once per create(); a different connection string
 *     re-detects.
 *  2. The combined load returns the same state a fresh store sees
 *     (per-table row counts + exact seeded rows).
 *  3. Concurrent withTransactions on SEPARATE stores (own clients) do
 *     not corrupt each other (the advisory lock serializes writers).
 *  4. close() ends the store's OWN client; other stores keep working.
 *  5. App-level GET /api/v1/health + GET /api/v1/setup-status through
 *     a request-scoped storeFactory stay cheap in pg queries per
 *     request (was 55 + 51 before Batch 0; ~10 with the singleton)
 *     AND use a fresh client per request, closed afterwards.
 *
 * Requires DATABASE_URL (same convention as the other Postgres suites);
 * skips cleanly without it. Uses its own database
 * (stackmate_perf_regression) built from the migration journal.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import type { CustomerRecord } from "../src/platform/db/store.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const REGRESSION_DB_NAME = "stackmate_perf_regression";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);

if (!DATABASE_URL) {
  console.log(
    "[perf-regression] DATABASE_URL is not set — skipping. Set DATABASE_URL to a test " +
      "database (e.g. postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test) to run it."
  );
}

const MAINTENANCE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function makeCustomer(tag: string): CustomerRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    customer_number: `CUST-PERF-${tag}-${randomUUID().slice(0, 8).toUpperCase()}`,
    customer_type: "person",
    name: `Perf Regression Customer ${tag}`,
    email: `perf-${tag.toLowerCase()}@stackmate.local`,
    normalized_email: `perf-${tag.toLowerCase()}@stackmate.local`,
    phone: null,
    normalized_phone: null,
    whatsapp: null,
    credit_balance_minor: 0,
    company_name: null,
    website: null,
    country_code: "BD",
    status: "active",
    registration_source: "admin",
    notes: "created by perf-regression.test.ts",
    created_at: now,
    updated_at: now,
  };
}

/**
 * Assert a query on the given client fails (ended clients reject;
 * pg may also throw synchronously, so wrap in a promise first).
 */
async function queryMustReject(client: Client, why: string): Promise<void> {
  await assert.rejects(
    Promise.resolve().then(() => client.query("SELECT 1")),
    why
  );
}

/**
 * Count queries issued on EVERY pg Client while patched (restores the
 * original after). Request-scoped clients are created inside
 * DrizzleStore.create, so per-client patching can no longer see them —
 * prototype patching counts the true per-request total instead.
 */
function countQueriesGlobally() {
  let count = 0;
  let infoSchema = 0;
  const orig = Client.prototype.query as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]) {
    count += 1;
    const sql = String((args[0] as { text?: unknown } | undefined)?.text ?? args[0] ?? "");
    if (sql.includes("information_schema")) infoSchema += 1;
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
  Client.prototype.query = patched as never;
  return {
    reset() {
      count = 0;
      infoSchema = 0;
    },
    counts() {
      return { count, infoSchema };
    },
    restore() {
      Client.prototype.query = orig as never;
    },
  };
}

describe.skipIf(!DATABASE_URL)("perf regression (Postgres)", () => {
  let regressionDbUrl = "";
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let storeA: Awaited<ReturnType<typeof import("../src/platform/db/drizzle-store.ts").DrizzleStore.create>>;
  const extraStores: Array<{ close: () => Promise<void> }> = [];

  async function freshStore() {
    const { DrizzleStore } = await import(
      "../src/platform/db/drizzle-store.ts"
    );
    const next = await DrizzleStore.create({
      connectionString: regressionDbUrl,
    });
    extraStores.push(next);
    return next;
  }

  beforeAll(async () => {
    env = resolveRuntimeConfig({ APP_ENV: "test" });
    const maintenance = new Client({ connectionString: MAINTENANCE_URL });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS "${REGRESSION_DB_NAME}"`);
    await maintenance.query(`CREATE DATABASE "${REGRESSION_DB_NAME}"`);
    await maintenance.end();
    regressionDbUrl = `postgresql://postgres:postgres@127.0.0.1:5432/${REGRESSION_DB_NAME}`;
    const admin = new Client({ connectionString: regressionDbUrl });
    await admin.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
        "utf8"
      );
      await admin.query(sql);
    }
    await admin.end();
    storeA = await freshStore();
  }, 120_000);

  afterAll(async () => {
    for (const s of extraStores) await s.close().catch(() => {});
    await storeA?.close().catch(() => {});
    const maintenance = new Client({ connectionString: MAINTENANCE_URL });
    await maintenance.connect();
    await maintenance
      .query(`DROP DATABASE IF EXISTS "${REGRESSION_DB_NAME}"`)
      .catch(() => {});
    await maintenance.end();
  }, 120_000);

  it("queries capabilities + required tables once per connection string, not per create()", async () => {
    const { DrizzleStore } = await import(
      "../src/platform/db/drizzle-store.ts"
    );
    // A fresh connection string (new cache key), so the first create
    // pays the schema checks.
    const probeUrl = `${regressionDbUrl}?application_name=perf-caps-probe`;
    const counter = countQueriesGlobally();
    try {
      const first = await DrizzleStore.create({ connectionString: probeUrl });
      const firstCounts = counter.counts();
      assert.ok(
        firstCounts.infoSchema >= 2,
        `first create on a fresh connection string should run the schema checks (saw ${firstCounts.infoSchema} information_schema queries)`
      );
      counter.reset();
      const second = await DrizzleStore.create({ connectionString: probeUrl });
      const secondCounts = counter.counts();
      assert.equal(
        secondCounts.infoSchema,
        0,
        `second create on the same connection string must not re-run schema checks (saw ${secondCounts.infoSchema})`
      );
      // And the second create is cheaper overall: load (1) + signing-key
      // section (BEGIN + lock + 2 SELECTs + COMMIT = 5) = 6 queries.
      assert.ok(
        secondCounts.count <= 8,
        `second create should issue ~6 queries, saw ${secondCounts.count}`
      );
      await first.close();
      await second.close();
      // A DIFFERENT connection string is a different cache key and
      // re-detects (no cross-database leakage of the plain-value cache).
      counter.reset();
      const third = await DrizzleStore.create({
        connectionString: `${regressionDbUrl}?application_name=perf-caps-probe-2`,
      });
      const thirdCounts = counter.counts();
      assert.ok(
        thirdCounts.infoSchema >= 2,
        `create on a different connection string must re-run schema checks (saw ${thirdCounts.infoSchema})`
      );
      await third.close();
    } finally {
      counter.restore();
    }
  }, 60_000);

  it("combined load returns the same state a fresh store sees", async () => {
    const seeded = [makeCustomer("LOAD-A"), makeCustomer("LOAD-B")];
    await storeA.withTransaction((state) => {
      for (const c of seeded) state.customers.push(c);
    });
    const storeB = await freshStore();
    await storeB.loadState();
    const a = await storeA.loadState();
    // Same DB content, same load path: identical row counts everywhere.
    const counts = (s: typeof a) =>
      Object.fromEntries(
        Object.entries(s)
          .filter(([, v]) => Array.isArray(v))
          .map(([k, v]) => [k, (v as unknown[]).length])
      );
    assert.deepEqual(counts(storeB.state), counts(a));
    // Exact seeded rows, field for field (timestamps included — the
    // combined JSON load must reproduce the direct-pg values).
    const byId = new Map(a.customers.map((c) => [c.id, c]));
    for (const c of seeded) {
      const loaded = storeB.state.customers.find((x) => x.id === c.id);
      assert.ok(loaded, `seeded customer ${c.id} visible in fresh load`);
      assert.deepEqual(loaded, byId.get(c.id));
    }
  }, 60_000);

  it("concurrent withTransactions on separate stores (own clients) do not corrupt", async () => {
    const storeB = await freshStore();
    const tags = Array.from({ length: 8 }, (_, i) => `CONC-${i}`);
    await Promise.all(
      tags.map((tag, i) =>
        (i % 2 === 0 ? storeA : storeB).withTransaction((state) => {
          state.customers.push(makeCustomer(tag));
        })
      )
    );
    const fresh = await storeA.loadState();
    for (const tag of tags) {
      assert.ok(
        fresh.customers.some((c) => c.name === `Perf Regression Customer ${tag}`),
        `customer ${tag} survived concurrent transactions`
      );
    }
  }, 60_000);

  it("close() ends the store's OWN client and other stores keep working", async () => {
    const doomed = await freshStore();
    const doomedClient = doomed.pgClient;
    await doomed.close();
    // The store's own client is ended: queries on it reject.
    await queryMustReject(doomedClient, "ended client must reject queries");
    // And the closed store itself refuses further use.
    await assert.rejects(doomed.loadState(), /closed/);
    // Other stores on the same database are unaffected.
    const survivor = await freshStore();
    const state = await survivor.loadState();
    assert.ok(Array.isArray(state.customers));
  }, 60_000);

  it("health + setup-status through a request-scoped storeFactory stay cheap and use a fresh client per request", async () => {
    const { DrizzleStore } = await import(
      "../src/platform/db/drizzle-store.ts"
    );
    // Record every client the factory creates: each request must get
    // its own instance, and the app must close it when the request
    // finishes (no cross-request reuse, no leaked connections).
    const createdClients: Client[] = [];
    const app = createStackMateApp({
      storeFactory: async () => {
        const store = await DrizzleStore.create({
          connectionString: regressionDbUrl,
        });
        createdClients.push(store.pgClient);
        return store;
      },
    });
    const counter = countQueriesGlobally();
    const healthMs: number[] = [];
    const setupMs: number[] = [];
    const setupQueries: number[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        counter.reset();
        const t0 = process.hrtime.bigint();
        const h = await app.fetch(
          new Request("http://localhost:8787/api/v1/health"),
          env
        );
        const t1 = process.hrtime.bigint();
        assert.equal(h.status, 200, await h.text());
        healthMs.push(Number(t1 - t0) / 1e6);
        counter.reset();
        const t2 = process.hrtime.bigint();
        const s = await app.fetch(
          new Request("http://localhost:8787/api/v1/setup-status"),
          env
        );
        const t3 = process.hrtime.bigint();
        const setupText = await s.text();
        assert.equal(s.status, 200, setupText);
        const body = JSON.parse(setupText) as {
          data?: { setup_required?: unknown };
        };
        assert.equal(body.data?.setup_required, true);
        assert.deepEqual(Object.keys(body.data ?? {}).sort(), ["setup_required"]);
        setupMs.push(Number(t3 - t2) / 1e6);
        setupQueries.push(counter.counts().count);
      }
    } finally {
      counter.restore();
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(
      `PERF-REGRESSION health ms: ${healthMs.map((v) => v.toFixed(0)).join(", ")} avg ${avg(healthMs).toFixed(0)}`
    );
    console.log(
      `PERF-REGRESSION setup-status ms: ${setupMs.map((v) => v.toFixed(0)).join(", ")} avg ${avg(setupMs).toFixed(0)}`
    );
    console.log(
      `PERF-REGRESSION pg queries per setup-status request: ${setupQueries.join(", ")}`
    );
    // Structural: 6 requests → 6 distinct clients, each closed after
    // its request (a shared client would show 1 distinct instance and
    // a live connection afterwards).
    assert.equal(createdClients.length, 6, `expected 6 store creations, saw ${createdClients.length}`);
    assert.equal(
      new Set(createdClients).size,
      6,
      "each request must get a FRESH pg Client instance (no cross-request reuse)"
    );
    for (const [i, client] of createdClients.entries()) {
      await queryMustReject(
        client,
        `client ${i} must be ended after its request (store closed by the app)`
      );
    }
    // Before Batch 0: create 55 queries + setup-status 51 = 106 per
    // request. With the singleton: create ~6 + handler (BEGIN + lock +
    // load + COMMIT = 4) = ~10. Request-scoped keeps the combined load
    // + caps cache, so warm-cache create is still ~6 and a
    // setup-status request stays ~10. The bound leaves headroom for
    // the signing-key section and a cold-cache first request.
    for (const q of setupQueries) {
      assert.ok(q <= 15, `setup-status request issued ${q} pg queries (expected <= 15)`);
    }
  }, 60_000);
});
