/**
 * Scheduled (cron) handler repro — the ~1/min uncaught-exception
 * investigation (2026-11-16).
 *
 * LIVE EVIDENCE: Cloudflare metrics 2026-11-16 ~21:20–21:28 +06 show 18
 * invocations with 8 errors, ALL "Uncaught Exception", 0 exceeded-CPU;
 * 24h totals are 2.59k invocations / 1.4k errors — ~1/min, which matches
 * the Worker cron trigger (`* * * * *`) exactly. The fetch path is
 * healthy (health 200s all day), so the prime suspect is the scheduled
 * handler (`index.ts` scheduled → `app.scheduled` → `handleScheduled`
 * → `processTransactionalOutboxBatch`). Unlike fetch, the scheduled
 * entrypoint has NO try/catch: any throw escapes as an uncaught Worker
 * exception.
 *
 * This suite drives the EXACT live path — `createStackMateApp` with a
 * storeFactory that mirrors `index.ts` `createRequestStore` (fresh
 * DrizzleStore per invocation) — against a real local Postgres, first
 * with an empty outbox and then with seeded outbox events (webhook
 * delivery via the default simulated transport, Meta CAPI dispatch, and
 * a poison event whose endpoint URL fails SSRF validation).
 *
 * If `app.scheduled` throws here, the throw IS the live cron error and
 * the message names the root cause. If it resolves everywhere, the cron
 * is exonerated and the ~1/min errors come from elsewhere (reported,
 * not guessed).
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; creates its own fresh
 * database `stackmate_test_cron` and drops it afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const CRON_DB_NAME = "stackmate_test_cron";
const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);
// Test-only fixture value (never a real secret).
const HEX64 = "0123456789abcdef".repeat(4);

describe.skipIf(!DATABASE_URL)("scheduled (cron) handler — live-path repro", () => {
  let envStaging: import("../src/env.ts").StackMateBindings;
  let app: import("../src/app.ts").StackMateAppInstance;
  let adminClient: Client;
  let dbUrl: string;

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
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${CRON_DB_NAME}"`);
    await maintenanceClient.query(`CREATE DATABASE "${CRON_DB_NAME}"`);
    await maintenanceClient.end();

    const cronUrl = new URL(DATABASE_URL);
    cronUrl.pathname = `/${CRON_DB_NAME}`;
    dbUrl = cronUrl.toString();

    envStaging = resolveRuntimeConfig({
      APP_ENV: "staging",
      BETTER_AUTH_SECRET: HEX64,
      ENCRYPTION_KEY_V1: HEX64,
      LICENSE_VERIFIER_SECRET: HEX64,
      CHECKOUT_TOKEN_SECRET: HEX64,
      SETUP_TOKEN: "test-setup-token-that-is-long-enough-32+",
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

    // EXACT live wiring (apps/api/src/index.ts createRequestStore):
    // a fresh DrizzleStore per invocation via the storeFactory.
    app = createStackMateApp({
      storeFactory: async (factoryEnv) =>
        DrizzleStore.create({
          connectionString: factoryEnv.HYPERDRIVE_NO_CACHE.connectionString,
          r2Bucket: null,
          signingKeyId: factoryEnv.LICENSE_SIGNING_KEY_ID,
          signingPrivateJwk: factoryEnv.LICENSE_SIGNING_PRIVATE_JWK,
          signingPublicJwk: factoryEnv.LICENSE_SIGNING_PUBLIC_JWK,
          encryptionSecret: factoryEnv.ENCRYPTION_KEY_V1,
          appEnv: factoryEnv.APP_ENV,
        }),
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await adminClient?.end();
    } catch {}
    try {
      const maintenanceUrl = new URL(DATABASE_URL!);
      maintenanceUrl.pathname = "/postgres";
      const mc = new Client({ connectionString: maintenanceUrl.toString() });
      await mc.connect();
      await mc.query(`DROP DATABASE IF EXISTS "${CRON_DB_NAME}"`);
      await mc.end();
    } catch {}
  });

  /** Seed one outbox row directly through a throwaway store. */
  async function seedOutboxEvent(event: {
    event_type: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
    const seedStore = await DrizzleStore.create({
      connectionString: dbUrl,
      encryptionSecret: HEX64,
      appEnv: "staging",
    });
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      await seedStore.withTransaction((state) => {
        state.outbox_events.push({
          id,
          event_key: `evt_${id.replace(/-/g, "").slice(0, 16)}`,
          aggregate_type: "test",
          aggregate_id: randomUUID(),
          event_type: event.event_type,
          payload: event.payload,
          status: "pending",
          attempt_count: 0,
          available_at: now,
          locked_until: null,
          locked_by: null,
          last_error_code: null,
          created_at: now,
          processed_at: null,
        });
      });
      return id;
    } finally {
      await seedStore.close();
    }
  }

  async function readOutboxStatus(
    eventId: string
  ): Promise<{ status: string; attempt_count: number; last_error_code: string | null }> {
    const row = await adminClient.query(
      "SELECT status, attempt_count, last_error_code FROM outbox_events WHERE id = $1",
      [eventId]
    );
    assert.equal(row.rows.length, 1, `outbox event ${eventId} must exist`);
    return row.rows[0] as {
      status: string;
      attempt_count: number;
      last_error_code: string | null;
    };
  }

  it("empty outbox: scheduled resolves (no throw) and claims nothing", async () => {
    const result = await app.scheduled({}, envStaging, { waitUntil: () => {} });
    assert.deepEqual(
      {
        claimed: result.claimed,
        delivered: result.delivered,
        simulated: result.simulated,
        skipped: result.skipped,
        retrying: result.retrying,
        dead_lettered: result.dead_lettered,
      },
      { claimed: 0, delivered: 0, simulated: 0, skipped: 0, retrying: 0, dead_lettered: 0 }
    );
    // B-02: the drain result carries its wall time (the drain ran —
    // the zeroed fallback for a skipped drain has no duration_ms).
    assert.equal(typeof (result as { duration_ms?: unknown }).duration_ms, "number");
  }, 60_000);

  it("webhook event with no subscribed endpoints: skipped, no throw", async () => {
    const id = await seedOutboxEvent({
      event_type: "catalog.product.created",
      payload: { product_id: "prod_test" },
    });
    const result = await app.scheduled({}, envStaging, { waitUntil: () => {} });
    assert.equal(result.claimed, 1, JSON.stringify(result));
    // Q3: nothing subscribed, so nothing was delivered — the row is
    // terminal "skipped", never "delivered".
    assert.equal(result.delivered, 0, JSON.stringify(result));
    assert.equal(result.skipped, 1, JSON.stringify(result));
    assert.equal((await readOutboxStatus(id)).status, "skipped");
  }, 60_000);

  it("Meta CAPI dispatch event: simulated, no throw", async () => {
    const id = await seedOutboxEvent({
      event_type: "tracking.meta_capi.dispatch",
      payload: { tracking_event_id: randomUUID() },
    });
    const result = await app.scheduled({}, envStaging, { waitUntil: () => {} });
    assert.equal(result.claimed, 1, JSON.stringify(result));
    assert.equal(result.delivered, 0, JSON.stringify(result));
    assert.equal(result.simulated, 1, JSON.stringify(result));
    assert.equal((await readOutboxStatus(id)).status, "simulated");
  }, 60_000);

  it("poison event (endpoint URL fails SSRF validation): retried, NOT thrown", async () => {
    const { DrizzleStore } = await import("../src/platform/db/drizzle-store.ts");
    const { encryptSecretAtRest } = await import("../src/platform/crypto/index.ts");
    const seedStore = await DrizzleStore.create({
      connectionString: dbUrl,
      encryptionSecret: HEX64,
      appEnv: "staging",
    });
    try {
      const endpointId = randomUUID();
      await seedStore.withTransaction((state) => {
        state.webhook_endpoints.push({
          id: endpointId,
          integrated_site_id: null,
          url: "http://169.254.1.1/hook",
          description: "poison endpoint",
          subscribed_events: ["catalog.product.created"],
          status: "active",
          secret_key_id: "whsec_test",
          secret_ciphertext: encryptSecretAtRest(
            "test-secret",
            HEX64,
            "v1",
            `webhook_endpoints:${endpointId}`
          ),
          key_version: "v1",
          created_at: new Date().toISOString(),
        });
      });
    } finally {
      await seedStore.close();
    }
    const id = await seedOutboxEvent({
      event_type: "catalog.product.created",
      payload: { product_id: "prod_poison" },
    });
    const result = await app.scheduled({}, envStaging, { waitUntil: () => {} });
    assert.equal(result.claimed, 1, JSON.stringify(result));
    assert.equal(result.retrying, 1, JSON.stringify(result));
    const after = await readOutboxStatus(id);
    assert.equal(after.status, "pending");
    assert.equal(after.attempt_count, 1);
    assert.ok(after.last_error_code, "poison failure must record an error code");
  }, 60_000);
});
