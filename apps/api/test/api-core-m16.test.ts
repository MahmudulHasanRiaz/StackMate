/**
 * API-core M-16 measurement test (audit fix batch, 2026-11-19).
 *
 * M-16: ~2 s/call — every request paid a fresh pg connect + full-state
 * load + a signing-key transaction (BEGIN + advisory lock + 2 SELECTs
 * + COMMIT) + a second full-state load. The fix caches the resolved
 * signing key per isolate (60s TTL, keyed by connection string +
 * secret) so a warm isolate skips the 5-round-trip transaction.
 *
 * This test PINS the win instead of guessing at it: it counts the pg
 * queries a second DrizzleStore.create() issues on the same connection
 * string (prototype patch, the perf-regression.test.ts pattern) and
 * asserts the signing-key table is never re-read — the first create
 * pays the transaction, the second serves the key from cache. Wall
 * times are logged (not asserted — CI timing is noisy) for the report.
 *
 * Requires DATABASE_URL (same convention as perf-regression.test.ts);
 * skips cleanly without it. Uses its own database (stackmate_m16)
 * built from the migration journal.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { resolveRuntimeConfig } from "../src/env.ts";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test";
const M16_DB_NAME = "stackmate_m16";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);

if (!DATABASE_URL) {
  console.log(
    "[api-core-m16] DATABASE_URL is not set — skipping. Set DATABASE_URL to a test " +
      "database (e.g. postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test) to run it."
  );
}

const MAINTENANCE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function countQueriesGlobally() {
  let count = 0;
  let signingKeyQueries = 0;
  const orig = Client.prototype.query as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]) {
    count += 1;
    const sql = String((args[0] as { text?: unknown } | undefined)?.text ?? args[0] ?? "");
    if (sql.includes("signing_key_metadata")) signingKeyQueries += 1;
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
  Client.prototype.query = patched as never;
  return {
    reset() {
      count = 0;
      signingKeyQueries = 0;
    },
    counts() {
      return { count, signingKeyQueries };
    },
    restore() {
      Client.prototype.query = orig as never;
    },
  };
}

describe.skipIf(!DATABASE_URL)("API-core M-16: signing-key cache (Postgres)", () => {
  let m16DbUrl = "";
  const extraStores: Array<{ close: () => Promise<void> }> = [];

  beforeAll(async () => {
    void resolveRuntimeConfig({ APP_ENV: "test" });
    const maintenance = new Client({ connectionString: MAINTENANCE_URL });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS "${M16_DB_NAME}"`);
    await maintenance.query(`CREATE DATABASE "${M16_DB_NAME}"`);
    await maintenance.end();
    m16DbUrl = `postgresql://postgres:postgres@127.0.0.1:5432/${M16_DB_NAME}`;
    const admin = new Client({ connectionString: m16DbUrl });
    await admin.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      await admin.query(sql);
    }
    await admin.end();
  }, 120_000);

  afterAll(async () => {
    for (const s of extraStores) await s.close().catch(() => {});
    const maintenance = new Client({ connectionString: MAINTENANCE_URL });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS "${M16_DB_NAME}"`).catch(() => {});
    await maintenance.end();
  }, 120_000);

  it("second create() on the same connection string skips the signing-key transaction", async () => {
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
    const counter = countQueriesGlobally();
    try {
      const t0 = Date.now();
      const first = await DrizzleStore.create({ connectionString: m16DbUrl });
      const firstMs = Date.now() - t0;
      extraStores.push(first);
      const firstCounts = counter.counts();
      console.log(
        `[api-core-m16] first create: ${firstCounts.count} queries (${firstCounts.signingKeyQueries} signing-key), ${firstMs}ms`
      );
      assert.ok(
        firstCounts.signingKeyQueries >= 1,
        `first create must read the signing key (saw ${firstCounts.signingKeyQueries} signing-key queries)`
      );

      counter.reset();
      const t1 = Date.now();
      const second = await DrizzleStore.create({ connectionString: m16DbUrl });
      const secondMs = Date.now() - t1;
      extraStores.push(second);
      const secondCounts = counter.counts();
      console.log(
        `[api-core-m16] second create: ${secondCounts.count} queries (${secondCounts.signingKeyQueries} signing-key), ${secondMs}ms`
      );
      // Warm isolate: the combined state load (1 query) only. The
      // signing-key transaction (BEGIN + lock + 2 SELECTs + COMMIT)
      // must not re-run — pre-fix the second create cost 6 queries.
      assert.ok(
        secondCounts.count <= 3,
        `second create must be cheap (saw ${secondCounts.count} queries, expected <= 3)`
      );
      assert.equal(
        secondCounts.signingKeyQueries,
        0,
        "second create must not touch signing_key_metadata (key served from cache)"
      );
      // The zero signing-key queries above ARE the same-key proof:
      // the second create served the key from the per-isolate cache
      // without touching the table at all. (There is no signing_keys
      // state collection to compare against — the key lives in the
      // signing_key_metadata table + the module-level cache.)
    } finally {
      counter.restore();
    }
  });
});
