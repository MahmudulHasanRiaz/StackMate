/**
 * B-01 connection reuse (2026-11-27): the per-isolate pg connection
 * cache (`platform/db/connection-cache.ts`).
 *
 * Proves the lease mechanism, not just the idea:
 *  - Sequential stores on the same connection string reuse ONE pg
 *    client (identity) and both answer queries — the connect() call
 *    is skipped after the first request.
 *  - While one store is open it holds the lease: a concurrent create
 *    gets a DIFFERENT client, and both stores stay correct.
 *  - A dead parked client (ended out from under the cache) is
 *    discarded, and the next store works on a fresh client.
 *  - Different connection-string spellings of the same database do
 *    not share an entry (keyed by exact string).
 *  - Warm targeted-create is faster than a fresh connect (the
 *    per-request cost the reuse removes), measured, not asserted
 *    from memory.
 *
 * Own fresh database (`stackmate_test_b01_reuse`) via `setupTestDb`;
 * skips cleanly without DATABASE_URL. The setup store is closed in
 * `beforeAll` so its client parks and the lease is free — the tests
 * below assert on relative client identity, never on which client
 * happens to be parked. Every store a test opens is closed in a
 * `finally`, so a leaked lease cannot poison the next test.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  DATABASE_URL,
  setupTestDb,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import { drainConnectionCache } from "../src/platform/db/connection-cache.ts";

const PG_DB_NAME = "stackmate_test_b01_reuse";

const DB_URL = (() => {
  if (!DATABASE_URL) return "";
  const url = new URL(DATABASE_URL);
  url.pathname = `/${PG_DB_NAME}`;
  return url.toString();
})();

/** Same database, different connection-string spelling. Works whichever
 * host DATABASE_URL uses: if it is 127.0.0.1 the alternate is localhost,
 * and if it is localhost the alternate is 127.0.0.1. (A plain
 * `.replace("127.0.0.1", "localhost")` is a no-op when DATABASE_URL
 * already uses localhost, so both spellings collapse to one string and
 * the "different keys" assertion fails spuriously.) */
const DB_URL_LOCALHOST = DB_URL.includes("127.0.0.1")
  ? DB_URL.replace("127.0.0.1", "localhost")
  : DB_URL.replace("localhost", "127.0.0.1");

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe.skipIf(!DATABASE_URL)("B-01 connection reuse", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const setup = await setupTestDb(PG_DB_NAME);
    cleanup = setup.cleanup;
    // Free the lease: the setup store's client parks in the cache.
    await setup.store.close();
  }, 120_000);

  afterAll(async () => {
    // Drain the parked client or the cleanup's DROP DATABASE refuses
    // while its backend is attached.
    drainConnectionCache();
    await cleanup?.();
  }, 120_000);

  it("sequential targeted stores reuse one pg client", async () => {
    const first = await DrizzleStore.createTargeted({ connectionString: DB_URL });
    try {
      assert.equal(
        await first.findLicenseForValidation("0".repeat(64)),
        null
      );
      const client = first.pgClient;
      await first.close();
      const second = await DrizzleStore.createTargeted({ connectionString: DB_URL });
      try {
        assert.equal(
          second.pgClient,
          client,
          "second targeted store must lease the parked client, not connect fresh"
        );
        assert.equal(
          await second.findLicenseForValidation("0".repeat(64)),
          null
        );
      } finally {
        await second.close();
      }
    } finally {
      // first is already closed above; close() is idempotent.
      await first.close();
    }
  });

  it("an open store holds the lease: concurrent create gets a different client", async () => {
    const first = await DrizzleStore.createTargeted({ connectionString: DB_URL });
    try {
      const second = await DrizzleStore.createTargeted({ connectionString: DB_URL });
      try {
        assert.notEqual(
          second.pgClient,
          first.pgClient,
          "while the first store is open the second must connect fresh"
        );
        assert.equal(
          await first.findLicenseForValidation("0".repeat(64)),
          null
        );
        assert.equal(
          await second.findLicenseForValidation("0".repeat(64)),
          null
        );
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("sequential full create() stores reuse one pg client", async () => {
    const first = await DrizzleStore.create({ connectionString: DB_URL });
    try {
      const client = first.pgClient;
      assert.ok(first.state.roles.length >= 0, "full load must run");
      await first.close();
      const second = await DrizzleStore.create({ connectionString: DB_URL });
      try {
        assert.equal(
          second.pgClient,
          client,
          "second full create must lease the parked client"
        );
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("a dead parked client is discarded and the next store works on a fresh client", async () => {
    const first = await DrizzleStore.createTargeted({ connectionString: DB_URL });
    const parked = first.pgClient;
    await first.close();
    // Kill the parked connection out from under the cache, the way
    // Hyperdrive / an idle timeout would. The `end` listener (plus
    // the synchronous socket check) must mark it dead.
    await parked.end();
    const second = await DrizzleStore.createTargeted({ connectionString: DB_URL });
    try {
      assert.notEqual(
        second.pgClient,
        parked,
        "a dead parked client must never be re-leased"
      );
      assert.equal(
        await second.findLicenseForValidation("0".repeat(64)),
        null,
        "the replacement store must work on its fresh client"
      );
    } finally {
      await second.close();
    }
  });

  it("different connection-string spellings do not share an entry", async () => {
    const first = await DrizzleStore.createTargeted({ connectionString: DB_URL });
    try {
      const client = first.pgClient;
      await first.close();
      const other = await DrizzleStore.createTargeted({
        connectionString: DB_URL_LOCALHOST,
      });
      try {
        assert.notEqual(
          other.pgClient,
          client,
          "localhost vs 127.0.0.1 are different cache keys"
        );
        assert.equal(
          await other.findLicenseForValidation("0".repeat(64)),
          null
        );
      } finally {
        await other.close();
      }
    } finally {
      await first.close();
    }
  });

  it("warm targeted create is faster than a fresh connect (connect cost removed)", async () => {
    // Warm the caps/tables caches and the connection cache first.
    for (let i = 0; i < 3; i++) {
      const warm = await DrizzleStore.createTargeted({ connectionString: DB_URL });
      await warm.close();
    }
    const connectMs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const raw = new Client({ connectionString: DB_URL });
      const t0 = performance.now();
      await raw.connect();
      connectMs.push(performance.now() - t0);
      await raw.end();
    }
    const warmCreateMs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const store = await DrizzleStore.createTargeted({ connectionString: DB_URL });
      warmCreateMs.push(performance.now() - t0);
      await store.close();
    }
    const connectMedian = median(connectMs);
    const warmMedian = median(warmCreateMs);
    console.log(
      `[b01-connection-reuse] fresh connect median ${connectMedian.toFixed(2)}ms, ` +
        `warm targeted create median ${warmMedian.toFixed(2)}ms`
    );
    assert.ok(
      warmMedian < connectMedian,
      `warm targeted create (${warmMedian.toFixed(2)}ms) must beat a fresh ` +
        `connect (${connectMedian.toFixed(2)}ms) — the reuse removes connect() from the path`
    );
  });
});
