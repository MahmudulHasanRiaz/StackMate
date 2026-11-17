/**
 * DrizzleStore integration tests (Postgres-backed).
 *
 * Requires a reachable Postgres database named for testing, supplied via
 * DATABASE_URL, e.g.:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test
 *
 * When DATABASE_URL is unset the whole suite SKIPS cleanly (it does not
 * fake-pass and does not fail). The suite never touches a database whose
 * name does not contain "test" — it refuses to apply migrations otherwise.
 *
 * The DrizzleStore under test lives in ../src/platform/db/drizzle-store.ts
 * and is loaded with a dynamic import inside beforeAll, so the skip path
 * works even before that module exists.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import type {
  CustomerRecord,
  DatabaseState,
  OrderRecord,
} from "../src/platform/db/store.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);

if (!DATABASE_URL) {
  console.log(
    "[drizzle-store.integration] DATABASE_URL is not set — skipping the " +
      "DrizzleStore Postgres integration suite. Set DATABASE_URL to a test " +
      "database (e.g. postgresql://postgres:postgres@127.0.0.1:5432/stackmate_test) to run it."
  );
}

function makeCustomer(): CustomerRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    customer_number: `CUST-TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
    customer_type: "person",
    name: "Integration Test Customer",
    email: "integration-test@stackmate.local",
    normalized_email: "integration-test@stackmate.local",
    phone: null,
    normalized_phone: null,
    whatsapp: null,
    credit_balance_minor: 0,
    company_name: null,
    country_code: "BD",
    status: "active",
    registration_source: "admin",
    notes: "created by drizzle-store.integration.test.ts",
    created_at: now,
    updated_at: now,
  };
}

function makeOrder(customerId: string): OrderRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    order_number: `ORD-TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
    public_reference: `SM-TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
    customer_id: customerId,
    source: "admin",
    integrated_site_id: null,
    status: "awaiting_payment",
    payment_status: "unpaid",
    currency_code: "BDT",
    subtotal_minor: 5000,
    discount_minor: 0,
    tax_minor: 0,
    total_minor: 5000,
    customer_note: null,
    internal_note: "created by drizzle-store.integration.test.ts",
    items: [],
    attribution: null,
    created_by_user_id: null,
    activation_mode: "on_full_payment",
    activation_percent: null,
    activation_date: null,
    suspend_on_missed_schedule: false,
    grace_days: 3,
    payment_method_id: null,
    lead_id: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    cancelled_at: null,
  };
}

describe.skipIf(!DATABASE_URL)("DrizzleStore (Postgres) integration", () => {
  let adminClient: Client;
  // The concrete store type is only known once the module under test exists;
  // keep it loose so this file compiles/runs against the documented contract.
  let store: {
    loadState: () => Promise<DatabaseState>;
    withTransaction: <T>(
      fn: (state: DatabaseState) => Promise<T> | T
    ) => Promise<T>;
    executeIdempotent: <T>(
      scopeKey: string,
      idempotencyKey: string,
      requestPayload: unknown,
      statusCode: number,
      fn: (state: DatabaseState) => Promise<T> | T
    ) => Promise<{ status: number; body: T; replayed: boolean }>;
    close: () => Promise<void>;
  };
  const extraStores: Array<{ close: () => Promise<void> }> = [];

  async function freshStore() {
    const { DrizzleStore } = await import(
      "../src/platform/db/drizzle-store.ts"
    );
    const next = await DrizzleStore.create({
      connectionString: DATABASE_URL!,
    });
    extraStores.push(next);
    return next as typeof store;
  }

  async function freshLoadState(): Promise<DatabaseState> {
    const second = await freshStore();
    return second.loadState();
  }

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const dbName = new URL(DATABASE_URL).pathname.replace(/^\//, "");
    assert.ok(
      dbName.includes("test"),
      `Refusing to apply migrations: database name "${dbName}" does not contain "test". ` +
        `Use a dedicated test database such as stackmate_test.`
    );

    adminClient = new Client({ connectionString: DATABASE_URL });
    await adminClient.connect();

    // Fresh test database: apply every migration listed in the journal, in
    // order (0000 schema, 0001 seed, 0002 counters/columns, 0003 role
    // grants, ...). All migrations are idempotent (IF NOT EXISTS /
    // ON CONFLICT DO NOTHING), so re-running this suite against the same
    // test database is safe.
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
        "utf8"
      );
      await adminClient.query(sql);
    }

    let DrizzleStore: any;
    try {
      ({ DrizzleStore } = await import(
        "../src/platform/db/drizzle-store.ts"
      ));
    } catch (error) {
      throw new Error(
        "DrizzleStore module not found at apps/api/src/platform/db/drizzle-store.ts " +
          "(the other agent has not created it yet). Integration test cannot run. " +
          `Underlying import error: ${(error as Error).message}`
      );
    }
    store = await DrizzleStore.create({ connectionString: DATABASE_URL });
  }, 60_000);

  afterAll(async () => {
    for (const s of [...extraStores, store]) {
      try {
        await s?.close();
      } catch {
        // Best-effort teardown; a close failure must not mask test results.
      }
    }
    try {
      await adminClient?.end();
    } catch {
      // Best-effort teardown.
    }
  });

  it("(i) withTransaction commit is persisted and visible from a second store instance", async () => {
    const customer = makeCustomer();
    const order = makeOrder(customer.id);

    await store.withTransaction(async (state) => {
      state.customers.push(customer);
      state.orders.push(order);
    });

    const reloaded = await freshLoadState();
    const foundCustomer = reloaded.customers.find((c) => c.id === customer.id);
    const foundOrder = reloaded.orders.find((o) => o.id === order.id);
    assert.ok(foundCustomer, "customer written in the transaction was not visible after reload");
    assert.equal(foundCustomer?.customer_number, customer.customer_number);
    assert.equal(foundCustomer?.email, customer.email);
    assert.ok(foundOrder, "order written in the transaction was not visible after reload");
    assert.equal(foundOrder?.customer_id, customer.id);
    assert.equal(foundOrder?.order_number, order.order_number);
    assert.equal(foundOrder?.total_minor, 5000);
  });

  it("(ii) withTransaction callback that throws rolls back", async () => {
    const customer = makeCustomer();

    await assert.rejects(
      store.withTransaction(async (state) => {
        state.customers.push(customer);
        throw new Error("intentional rollback probe");
      }),
      /intentional rollback probe/
    );

    const reloaded = await freshLoadState();
    assert.equal(
      reloaded.customers.find((c) => c.id === customer.id),
      undefined,
      "customer from the rolled-back transaction must not be visible after reload"
    );
  });

  it("(iii) executeIdempotent replays the same key and rejects a different payload", async () => {
    const scopeKey = "drizzle-store-integration-test";
    const idempotencyKey = `test-${randomUUID()}`;
    const payload = { orderId: randomUUID(), amountMinor: 5000 };
    const marker = `idem-${randomUUID()}`;

    const first = await store.executeIdempotent(
      scopeKey,
      idempotencyKey,
      payload,
      201,
      async () => ({ ok: true, marker })
    );
    assert.equal(first.replayed, false);
    assert.equal(first.status, 201);
    assert.deepEqual(first.body, { ok: true, marker });

    const replay = await store.executeIdempotent(
      scopeKey,
      idempotencyKey,
      payload,
      201,
      async () => ({ ok: true, marker: "must-not-run" })
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, { ok: true, marker });

    await assert.rejects(
      store.executeIdempotent(
        scopeKey,
        idempotencyKey,
        { ...payload, amountMinor: 5001 },
        201,
        async () => ({ ok: true, marker: "different-payload" })
      ),
      /IDEMPOTENCY_KEY_REUSED|already used with a different/i
    );
  });

  it("(iv) seed reference data from migration 0001 is visible", async () => {
    const roles = await adminClient.query(
      "SELECT key FROM roles ORDER BY key"
    );
    const providers = await adminClient.query(
      "SELECT provider_key FROM payment_providers ORDER BY provider_key"
    );
    assert.ok(roles.rowCount !== null && roles.rowCount >= 8, `expected >= 8 seeded roles, got ${roles.rowCount}`);
    assert.ok(
      roles.rows.some((r) => r.key === "super_admin"),
      "seeded role super_admin missing"
    );
    assert.ok(
      providers.rowCount !== null && providers.rowCount >= 4,
      `expected >= 4 seeded payment providers, got ${providers.rowCount}`
    );
    assert.ok(
      providers.rows.some((r) => r.provider_key === "bkash_manual"),
      "seeded payment provider bkash_manual missing"
    );

    // The same seed rows must also be visible through the store's loadState().
    const reloaded = await store.loadState();
    assert.ok(reloaded.roles.length >= 8, `loadState roles empty/too few: ${reloaded.roles.length}`);
    assert.ok(reloaded.roles.some((r) => r.key === "super_admin"));
    assert.ok(
      reloaded.payment_providers.length >= 4,
      `loadState payment_providers empty/too few: ${reloaded.payment_providers.length}`
    );
    assert.ok(
      reloaded.payment_providers.some((p) => p.provider_key === "bkash_manual")
    );
  });

  it("(v) migration 0003 grants permissions to all roles (not only super_admin)", async () => {
    const grants = await adminClient.query(
      `SELECT r.key AS role_key, count(*)::int AS n
         FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        GROUP BY r.key ORDER BY r.key`
    );
    const byRole = new Map<string, number>(
      grants.rows.map((row) => [row.role_key as string, row.n as number])
    );
    // seed-reference.ts matrix: super_admin 29, admin 28, finance_manager 13,
    // license_manager 7, product_manager 6, support_staff 11, marketing_manager 4,
    // read_only 9 = 107 total. Before migration 0003 only super_admin had any.
    // (ADR-0009 added 4 permissions — tickets.view/manage, leads.view/manage:
    // super_admin +4, admin +4, support_staff +4, read_only +2 = +14 total.)
    assert.equal(byRole.get("super_admin"), 29);
    assert.equal(byRole.get("admin"), 28);
    assert.equal(byRole.get("finance_manager"), 13);
    assert.equal(byRole.get("license_manager"), 7);
    assert.equal(byRole.get("product_manager"), 6);
    assert.equal(byRole.get("support_staff"), 11);
    assert.equal(byRole.get("marketing_manager"), 4);
    assert.equal(byRole.get("read_only"), 9);
    const total = [...byRole.values()].reduce((a, b) => a + b, 0);
    assert.equal(total, 107);

    // The grants must also be visible through the store's loaded roles.
    const reloaded = await store.loadState();
    const admin = reloaded.roles.find((r) => r.key === "admin");
    assert.ok(admin, "admin role missing from loadState");
    assert.equal(admin?.permission_keys.length, 28); // ADR-0009: +4 tickets/leads grants
    assert.ok(!admin?.permission_keys.includes("users.manage"));
    const readOnly = reloaded.roles.find((r) => r.key === "read_only");
    assert.equal(readOnly?.permission_keys.length, 9); // ADR-0009: +2 tickets/leads view grants
  });
});
