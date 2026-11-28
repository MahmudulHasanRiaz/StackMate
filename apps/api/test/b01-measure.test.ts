/**
 * B-01 Phase 0 MEASUREMENT ONLY (2026-11-26).
 *
 * Measures, logs, asserts nothing about timings:
 *  - DrizzleStore.create() (full-state load) wall time + pg query count
 *    + combined-load payload size (JSON bytes of the single-statement
 *    result row) vs DrizzleStore.createTargeted() (no state load).
 *  - Runs against the LOCAL test DB only (DATABASE_URL, default
 *    stackmate_test). Run BEFORE seeding (empty DB) and AFTER seeding
 *    (~/workspace/stackmate-work/b01-measure/seed-b01.sql) and compare.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stackmate_test \
 *     node_modules/.bin/vitest run test/b01-measure.test.ts
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { Client } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test";

if (!DATABASE_URL) {
  console.log("[b01-measure] DATABASE_URL is not set — skipping.");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    // mid >= 1 and mid < length here (array is non-empty at call sites).
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

describe.skipIf(!DATABASE_URL)("B-01 Phase 0 measurement", () => {
  const stores: Array<{ close: () => Promise<void> }> = [];
  // pg query counter + combined-load payload capture. The combined load
  // is the single SELECT whose text carries the per-table json_agg
  // columns (e.g. AS "audit").
  let queryCount = 0;
  let combinedPayloadBytes = 0;
  let combinedRowsSeen = 0;
  let origQuery: unknown = null;

  beforeAll(() => {
    const orig = Client.prototype.query as (...args: unknown[]) => unknown;
    origQuery = orig;
    const patched = async function (this: unknown, ...args: unknown[]) {
      queryCount += 1;
      const sql = String(
        (args[0] as { text?: unknown } | undefined)?.text ?? args[0] ?? ""
      );
      const result = (await (
        orig as (...a: unknown[]) => Promise<{ rows: unknown[] }>
      ).apply(this, args)) as { rows: unknown[] };
      if (sql.includes('AS "audit"') && sql.includes('AS "users"')) {
        combinedRowsSeen += 1;
        combinedPayloadBytes = Buffer.byteLength(
          JSON.stringify(result.rows),
          "utf8"
        );
      }
      return result;
    };
    Client.prototype.query = patched as never;
  });

  afterAll(async () => {
    for (const s of stores) await s.close().catch(() => {});
    if (origQuery) Client.prototype.query = origQuery as never;
  });

  it("create() vs createTargeted() — wall time, query count, payload size", async () => {
    const { DrizzleStore } = await import(
      "../src/platform/db/drizzle-store.ts"
    );

    // Warm-up: first create() pays the signing-key transaction and
    // populates the M-16 per-isolate cache; exclude it from timings.
    const warm = await DrizzleStore.create({ connectionString: DATABASE_URL });
    stores.push(warm);
    console.log(
      `[b01-measure] warm-up create(): ${queryCount} pg queries so far (includes warm-up)`
    );
    queryCount = 0;

    const fullMs: number[] = [];
    const fullQueries: number[] = [];
    const payloadBytes: number[] = [];
    for (let i = 0; i < 3; i++) {
      queryCount = 0;
      combinedPayloadBytes = 0;
      const t0 = performance.now();
      const store = await DrizzleStore.create({
        connectionString: DATABASE_URL,
      });
      const ms = performance.now() - t0;
      stores.push(store);
      fullMs.push(ms);
      fullQueries.push(queryCount);
      payloadBytes.push(combinedPayloadBytes);
      await store.close();
    }

    const targetedMs: number[] = [];
    const targetedQueries: number[] = [];
    for (let i = 0; i < 3; i++) {
      queryCount = 0;
      const t0 = performance.now();
      const store = await DrizzleStore.createTargeted({
        connectionString: DATABASE_URL,
      });
      const ms = performance.now() - t0;
      stores.push(store);
      targetedMs.push(ms);
      targetedQueries.push(queryCount);
      await store.close();
    }

    // One targeted-method call on a fresh targeted store, for scale:
    // findLicenseForValidation with a dummy key (expected: not found).
    queryCount = 0;
    const tStore = await DrizzleStore.createTargeted({
      connectionString: DATABASE_URL,
    });
    stores.push(tStore);
    const t0 = performance.now();
    const lic = await tStore.findLicenseForValidation("B01-MEASURE-DUMMY-KEY");
    const licMs = performance.now() - t0;
    const licQueries = queryCount;
    await tStore.close();

    console.log("[b01-measure] ---- RESULTS (local stackmate_test) ----");
    console.log(
      `[b01-measure] create() full load: runs=${fullMs.map((v) => v.toFixed(1)).join(", ")} ms | median=${median(fullMs).toFixed(1)} ms | pg queries/run=${fullQueries.join(", ")}`
    );
    console.log(
      `[b01-measure] createTargeted(): runs=${targetedMs.map((v) => v.toFixed(1)).join(", ")} ms | median=${median(targetedMs).toFixed(1)} ms | pg queries/run=${targetedQueries.join(", ")}`
    );
    console.log(
      `[b01-measure] combined-load payload: runs=${payloadBytes.map(fmtBytes).join(", ")} | median=${fmtBytes(median(payloadBytes))} (${median(payloadBytes)} bytes, JSON of the single-statement result row; combined-load statements seen=${combinedRowsSeen})`
    );
    console.log(
      `[b01-measure] targeted findLicenseForValidation(dummy key): ${licMs.toFixed(1)} ms, ${licQueries} pg queries, found=${lic !== null && lic !== undefined}`
    );
    console.log(
      `[b01-measure] speedup (median full / median targeted): ${(median(fullMs) / Math.max(median(targetedMs), 0.01)).toFixed(1)}x`
    );
  }, 120_000);
});
