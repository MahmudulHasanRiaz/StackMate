/**
 * Perf regression tests (2026-11-15) — the staging slowness fix.
 *
 * Staging measured 13–35s per request: every request ran a fresh pg
 * Client + connect + detectCapabilities + assertRequiredTables + a
 * 48-query sequential full-state load, and every withTransaction
 * re-ran the full load. The fix: ONE combined JSON load statement,
 * caps/tables cached per client, and ONE shared pg Client per Worker
 * isolate (passed as `existingClient`). These tests pin the new
 * behavior so it cannot silently regress:
 *
 *  1. caps/tables are queried once per client, not once per create().
 *  2. The combined load returns the same state a fresh store sees
 *     (per-table row counts + exact seeded rows).
 *  3. Concurrent withTransactions on stores sharing one client do not
 *     corrupt each other (per-client serialization queue).
 *  4. close() on a shared-client store does not end the shared client.
 *  5. App-level GET /api/v1/health + GET /api/v1/setup-status through
 *     a storeFactory mimicking apps/api/src/index.ts stay cheap in pg
 *     queries per request (was 55 + 51; now ~6 + ~4).
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
    company_name: null,
    country_code: "BD",
    status: "active",
    registration_source: "admin",
    notes: "created by perf-regression.test.ts",
    created_at: now,
    updated_at: now,
  };
}

/** Count queries on one client instance (restores the original after). */
function countQueriesOn(client: Client) {
  let count = 0;
  let infoSchema = 0;
  const orig = client.query.bind(client) as (...args: unknown[]) => unknown;
  const patched = (...args: unknown[]) => {
    count += 1;
    const sql = String((args[0] as { text?: unknown } | undefined)?.text ?? args[0] ?? "");
    if (sql.includes("information_schema")) infoSchema += 1;
    return orig(...args);
  };
  (client as unknown as { query: unknown }).query = patched;
  return {
    reset() {
      count = 0;
      infoSchema = 0;
    },
    counts() {
      return { count, infoSchema };
    },
    restore() {
      (client as unknown as { query: unknown }).query = orig;
    },
  };
}

describe.skipIf(!DATABASE_URL)("perf regression (Postgres)", () => {
  let regressionDbUrl = "";
  let env: ReturnType<typeof resolveRuntimeConfig>;
  let sharedClient: Client;
  let storeA: Awaited<ReturnType<typeof import("../src/platform/db/drizzle-store.ts").DrizzleStore.create>>;
  const extraStores: Array<{ close: () => Promise<void> }> = [];

  async function freshSharedStore() {
    const { DrizzleStore } = await import(
      "../src/platform/db/drizzle-store.ts"
    );
    const next = await DrizzleStore.create({
      connectionString: regressionDbUrl,
      existingClient: sharedClient,
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
    sharedClient = new Client({ connectionString: regressionDbUrl });
    await sharedClient.connect();
    storeA = await freshSharedStore();
  }, 120_000);

  afterAll(async () => {
    for (const s of extraStores) await s.close().catch(() => {});
    await storeA?.close().catch(() => {});
    await sharedClient?.end().catch(() => {});
    const maintenance = new Client({ connectionString: MAINTENANCE_URL });
    await maintenance.connect();
    await maintenance
      .query(`DROP DATABASE IF EXISTS "${REGRESSION_DB_NAME}"`)
      .catch(() => {});
    await maintenance.end();
  }, 120_000);

  it("queries capabilities + required tables once per client, not per create()", async () => {
    const { DrizzleStore } = await import(
      "../src/platform/db/drizzle-store.ts"
    );
    // A fresh client, so the first create pays the schema checks.
    const probe = new Client({ connectionString: regressionDbUrl });
    await probe.connect();
    const counter = countQueriesOn(probe);
    try {
      const first = await DrizzleStore.create({
        connectionString: regressionDbUrl,
        existingClient: probe,
      });
      const firstCounts = counter.counts();
      assert.ok(
        firstCounts.infoSchema >= 2,
        `first create on a fresh client should run the schema checks (saw ${firstCounts.infoSchema} information_schema queries)`
      );
      counter.reset();
      const second = await DrizzleStore.create({
        connectionString: regressionDbUrl,
        existingClient: probe,
      });
      const secondCounts = counter.counts();
      assert.equal(
        secondCounts.infoSchema,
        0,
        `second create on the same client must not re-run schema checks (saw ${secondCounts.infoSchema})`
      );
      // And the second create is cheaper overall: load (1) + signing-key
      // section (BEGIN + lock + 2 SELECTs + COMMIT = 5) = 6 queries.
      assert.ok(
        secondCounts.count <= 8,
        `second create should issue ~6 queries, saw ${secondCounts.count}`
      );
      await first.close();
      await second.close();
    } finally {
      counter.restore();
      await probe.end().catch(() => {});
    }
  }, 60_000);

  it("combined load returns the same state a fresh store sees", async () => {
    const seeded = [makeCustomer("LOAD-A"), makeCustomer("LOAD-B")];
    await storeA.withTransaction((state) => {
      for (const c of seeded) state.customers.push(c);
    });
    const storeB = await freshSharedStore();
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

  it("concurrent withTransactions on stores sharing one client do not corrupt", async () => {
    const storeB = await freshSharedStore();
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

  it("close() on a shared-client store does not end the shared client", async () => {
    const doomed = await freshSharedStore();
    await doomed.close();
    // The shared client must still serve other stores afterwards.
    const survivor = await freshSharedStore();
    const state = await survivor.loadState();
    assert.ok(Array.isArray(state.customers));
    // And the closed store itself refuses further use.
    await assert.rejects(doomed.loadState(), /closed/);
  }, 60_000);

  it("health + setup-status through a shared-client storeFactory stay cheap", async () => {
    const { DrizzleStore } = await import(
      "../src/platform/db/drizzle-store.ts"
    );
    const counter = countQueriesOn(sharedClient);
    const app = createStackMateApp({
      storeFactory: async () =>
        DrizzleStore.create({
          connectionString: regressionDbUrl,
          existingClient: sharedClient,
        }),
    });
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
    // Before the fix: create 55 queries + setup-status 51 = 106 per
    // request. After: create ~6 + handler (BEGIN + lock + load + COMMIT
    // = 4) = ~10. The bound leaves headroom for the signing-key section.
    for (const q of setupQueries) {
      assert.ok(q <= 15, `setup-status request issued ${q} pg queries (expected <= 15)`);
    }
  }, 60_000);
});
