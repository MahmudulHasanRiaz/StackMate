/**
 * TEMPORARY reproduction for the staging Worker 1101 (2026-11-15).
 *
 * Staging: GET /api/v1/admin/me returns Cloudflare error 1101
 * ("Worker threw exception") on ~10% of sequential requests and ~25%
 * of 20 concurrent requests. The throw escapes handleRequest, so it
 * must come from store creation (fetchHandler -> resolveRequestStore
 * -> createRequestStore -> DrizzleStore.create / getSharedClient).
 *
 * This file pins the two defenses added for it:
 *  1. Concurrent /me through the REAL Worker entrypoint (module-level
 *     shared client included) stays clean against local Postgres.
 *  2. A first connection rejected with PostgreSQL 53300
 *     (too_many_connections — "remaining connection slots…") is
 *     recovered by the connect-phase retry: a fake pg proxy rejects
 *     the first handshake with a 53300 ErrorResponse and TCP-proxies
 *     later handshakes to the real database; the request must still
 *     answer 401 (unauthenticated), never throw.
 *
 * Requires DATABASE_URL (same convention as the other Postgres suites).
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";
import { Client } from "pg";
import { resolveRuntimeConfig } from "../src/env.ts";
import worker from "../src/index.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const REPRO_DB_NAME = "stackmate_1101_repro";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);
const MAINTENANCE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

describe.skipIf(!DATABASE_URL)("worker 1101 repro (Postgres)", () => {
  let dbUrl = "";
  let env: ReturnType<typeof resolveRuntimeConfig>;

  beforeAll(async () => {
    const maintenance = new Client({ connectionString: MAINTENANCE_URL });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS "${REPRO_DB_NAME}"`);
    await maintenance.query(`CREATE DATABASE "${REPRO_DB_NAME}"`);
    await maintenance.end();
    dbUrl = `postgresql://postgres:postgres@127.0.0.1:5432/${REPRO_DB_NAME}`;
    const admin = new Client({ connectionString: dbUrl });
    await admin.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      await admin.query(sql);
    }
    await admin.end();
    env = resolveRuntimeConfig({
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
      HYPERDRIVE_CACHED: { connectionString: dbUrl },
    } as never);
  }, 120_000);

  afterAll(async () => {
    // The Worker entrypoint keeps a module-level shared client connected
    // to the repro DB (it has no close API); terminate its backends
    // first or DROP DATABASE waits forever.
    const maintenance = new Client({ connectionString: MAINTENANCE_URL });
    await maintenance.connect();
    await maintenance
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [REPRO_DB_NAME]
      )
      .catch(() => {});
    await maintenance
      .query(`DROP DATABASE IF EXISTS "${REPRO_DB_NAME}"`)
      .catch(() => {});
    await maintenance.end();
  }, 120_000);

  it("20 concurrent /me requests: none throws, none 500s", async () => {
    const runWave = async (wave: number) => {
      const results = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          try {
            const res = await worker.fetch(
              new Request("http://localhost:8787/api/v1/admin/me"),
              env as never,
              undefined as never
            );
            const body = await res.text();
            return { i, status: res.status, body: body.slice(0, 80) };
          } catch (e) {
            return {
              i,
              status: "THREW",
              body: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
            };
          }
        })
      );
      const bad = results.filter((r) => r.status !== 401);
      console.log(
        `[1101-repro] wave ${wave}: ok=${results.length - bad.length}/20 bad=${bad.length}`,
        JSON.stringify(bad, null, 2)
      );
      return bad;
    };

    const bad1 = await runWave(1);
    const bad2 = await runWave(2);
    const bad3 = await runWave(3);
    assert.deepEqual(
      [...bad1, ...bad2, ...bad3],
      [],
      "concurrent /me requests must all return 401 (unauthenticated), never throw or 500"
    );
  }, 120_000);

  it("a 53300 connect rejection recovers via the connect-phase retry", async () => {
    // Fake pg proxy: the FIRST handshake gets a 53300 ErrorResponse
    // (too_many_connections); later handshakes are TCP-proxied to the
    // real database. The entrypoint must answer 401, not throw.
    const proxy = net.createServer();
    let handshakes = 0;
    const liveSockets = new Set<net.Socket>();
    proxy.on("connection", (socket) => {
      liveSockets.add(socket);
      socket.on("close", () => liveSockets.delete(socket));
      handshakes += 1;
      if (handshakes === 1) {
        socket.once("data", () => {
          const message =
            "remaining connection slots are reserved for non-replication superuser connections";
          const fields = Buffer.concat([
            Buffer.from("SFATAL\0", "utf8"),
            Buffer.from("C53300\0", "utf8"),
            Buffer.from(`M${message}\0`, "utf8"),
            Buffer.from([0]),
          ]);
          const length = 4 + fields.length;
          const header = Buffer.alloc(5);
          header[0] = 0x45; // 'E' ErrorResponse
          header.writeInt32BE(length, 1);
          socket.end(Buffer.concat([header, fields]));
        });
        return;
      }
      const upstream = net.connect(5432, "127.0.0.1");
      liveSockets.add(upstream);
      upstream.on("close", () => liveSockets.delete(upstream));
      socket.pipe(upstream);
      upstream.pipe(socket);
      const destroyBoth = () => {
        socket.destroy();
        upstream.destroy();
      };
      socket.on("error", destroyBoth);
      upstream.on("error", destroyBoth);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address() as net.AddressInfo;
    try {
      const proxyUrl = `postgresql://postgres:postgres@127.0.0.1:${address.port}/${REPRO_DB_NAME}`;
      const proxyEnv = resolveRuntimeConfig({
        APP_ENV: "test",
        HYPERDRIVE_NO_CACHE: { connectionString: proxyUrl },
        HYPERDRIVE_CACHED: { connectionString: proxyUrl },
      } as never);
      const res = await worker.fetch(
        new Request("http://localhost:8787/api/v1/admin/me"),
        proxyEnv as never,
        undefined as never
      );
      const body = await res.text();
      console.log(`[1101-repro] 53300 test: fetch returned ${res.status} after ${handshakes} handshake(s)`);
      assert.equal(res.status, 401, `expected 401 after 53300 recovery, got ${res.status}: ${body.slice(0, 200)}`);
      assert.ok(handshakes >= 2, `expected a retry handshake, saw ${handshakes}`);
    } finally {
      // The Worker's shared client still holds the proxied connection;
      // destroy the sockets first or proxy.close() waits forever.
      for (const s of liveSockets) s.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }, 120_000);
});
