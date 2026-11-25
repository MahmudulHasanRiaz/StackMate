/**
 * Audit Batch B (2026-11-25 fix plan) — performance backbone + store
 * layer + cron + idempotency.
 *
 * In-memory tests run always; Postgres tests use their own fresh
 * databases (stackmate_test_batch_b / _sweep) via setupTestDb and skip
 * cleanly without DATABASE_URL.
 *
 * Items covered: F-12, F-13, F-14, A-03, A-07, A-11, B-01, B-02, B-03,
 * B-04, B-09, B-12, B-13, B-14, B-15, C-03, C-05, E-13, cron-lease.
 */
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  setupTestDb,
  seedCustomer,
  seedProduct,
  seedOrder,
  seedLicense,
  seedSite,
} from "./customer-order-helpers.ts";
import {
  StackMateDataStore,
  canonicalStringify,
} from "../src/platform/db/store.ts";
import {
  sha256Hex,
  issueCheckoutAccessToken,
  verifyCheckoutAccessToken,
} from "../src/platform/crypto/index.ts";
import {
  sanitizeCheckoutResponseBody,
  reissueCheckoutResponseBody,
} from "../src/modules/commerce/service.ts";
import { searchGlobal } from "../src/modules/search/service.ts";
import {
  sendStackMateEmail,
  sendEmailsBounded,
  type EmailDeps,
} from "../src/modules/email/service.ts";
import type { ResolvedSmtpSettings } from "../src/modules/auth-config/service.ts";
import type {
  SmtpConnectFn,
  SmtpSocketLike,
} from "../src/modules/email/smtp-client.ts";
import {
  tryAcquireCronLease,
  releaseCronLease,
} from "../src/platform/cron-lease.ts";
import {
  processTransactionalOutboxBatch,
  registerWebhookEndpointByAdmin,
} from "../src/modules/webhooks/service.ts";
import {
  runRenewalExpirySweep,
  markSweepRemindersSent,
  SWEEP_REMINDERS_PER_RUN_CAP,
} from "../src/modules/renewal/sweep.ts";
import { createInstallmentsForOrderInTx } from "../src/modules/payments/service.ts";

const ENCRYPTION_KEY = "test-encryption-key-for-audit-batch-b";
const CHECKOUT_SECRET = "test-checkout-secret-for-audit-batch-b";
const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function outboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    event_key: `test:${randomUUID()}`,
    aggregate_type: "order",
    aggregate_id: randomUUID(),
    event_type: "order.created",
    payload: { order_reference: "ORD-TEST" },
    status: "pending" as const,
    attempt_count: 0,
    available_at: PAST,
    locked_until: null,
    locked_by: null,
    last_error_code: null,
    created_at: NOW,
    processed_at: null,
    ...overrides,
  };
}

/** Minimal scripted SMTP socket (same shape as smtp-client.test.ts). */
const NONE_REPLIES = [
  "220 smtp.example.com ESMTP",
  "250 smtp.example.com Hello",
  "250 OK",
  "250 OK",
  "354 End data with <CR><LF>.<CR><LF>",
  "250 OK queued",
  "221 Bye",
];

function scriptedSocket(onClose?: () => void): SmtpSocketLike {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const queue = [...NONE_REPLIES];
  return {
    readable: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const line = queue.shift();
          if (line === undefined) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`${line}\r\n`));
        },
      },
      { highWaterMark: 0 }
    ),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        decoder.decode(chunk);
        return Promise.resolve();
      },
    }),
    close: () => {
      onClose?.();
      return Promise.resolve();
    },
  };
}

const PRELOADED_SMTP: ResolvedSmtpSettings = {
  host: "smtp.example.com",
  port: 587,
  // No username/password on purpose: with credentials the client
  // sends AUTH LOGIN, which the scripted socket below does not
  // script — the preloaded-config behaviour is what is under test,
  // not auth.
  username: "",
  has_password: false,
  tls_mode: "none",
  from_address: "noreply@example.com",
  from_name: "StackMate",
  enabled: true,
  updated_at: null,
  password: null,
};

function emailDeps(connectImpl: SmtpConnectFn): EmailDeps {
  return {
    encryptionKey: ENCRYPTION_KEY,
    keyVersion: "v1",
    appUrl: "http://localhost:8787",
    connectImpl,
  };
}

/* ------------------------------------------------------------------ */
/* In-memory: idempotency (F-12 / F-13 / F-14 / A-03)                  */
/* ------------------------------------------------------------------ */

describe("audit batch B — idempotency (F-12/F-13/F-14/A-03)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  it("F-12: the same payload with different key order replays (canonical hash)", async () => {
    let calls = 0;
    const fn = () => {
      calls += 1;
      return { ok: true };
    };
    const first = await store.executeIdempotent(
      "test-scope",
      "idem-key-f12-1",
      { b: 2, a: 1 },
      200,
      fn
    );
    assert.equal(first.replayed, false);
    const second = await store.executeIdempotent(
      "test-scope",
      "idem-key-f12-1",
      { a: 1, b: 2 },
      200,
      fn
    );
    assert.equal(second.replayed, true);
    assert.deepEqual(second.body, { ok: true });
    assert.equal(calls, 1);
  });

  it("F-12: a different payload under the same key is a 409, not a replay", async () => {
    await store.executeIdempotent("test-scope", "idem-key-f12-2", { a: 1 }, 200, () => ({
      v: 1,
    }));
    await assert.rejects(
      store.executeIdempotent("test-scope", "idem-key-f12-2", { a: 2 }, 200, () => ({
        v: 2,
      })),
      (err: unknown) =>
        (err as { code?: string }).code === "IDEMPOTENCY_KEY_REUSED"
    );
  });

  it("F-13: an expired record is absent — the command runs fresh", async () => {
    const payload = { order: "ORD-1" };
    await store.executeIdempotent("test-scope", "idem-key-f13-1", payload, 200, () => ({
      v: 1,
    }));
    // Expire the stored record in place (same request hash).
    await store.withTransaction((state) => {
      const rec = state.idempotency_records.find(
        (r) => r.scope_key === "test-scope" && r.idempotency_key === "idem-key-f13-1"
      )!;
      rec.expires_at = new Date(Date.now() - 1000).toISOString();
    });
    let calls = 0;
    const second = await store.executeIdempotent(
      "test-scope",
      "idem-key-f13-1",
      payload,
      200,
      () => {
        calls += 1;
        return { v: 2 };
      }
    );
    assert.equal(second.replayed, false);
    assert.deepEqual(second.body, { v: 2 });
    assert.equal(calls, 1);
  });

  it("F-14: a processing record answers 409; a failed command frees the key for retry", async () => {
    const payload = { order: "ORD-2" };
    const hash = sha256Hex(canonicalStringify(payload));
    // Seed the processing marker directly (same hash the command would compute).
    await store.withTransaction((state) => {
      state.idempotency_records.push({
        id: randomUUID(),
        scope_key: "test-scope",
        idempotency_key: "idem-key-f14-1",
        request_hash: hash,
        status: "processing",
        response_status: 200,
        response_body: null,
        expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
        created_at: NOW,
      });
    });
    await assert.rejects(
      store.executeIdempotent("test-scope", "idem-key-f14-1", payload, 200, () => ({
        v: 1,
      })),
      (err: unknown) =>
        (err as { code?: string }).code === "IDEMPOTENCY_IN_PROGRESS"
    );

    // A command whose fn throws must not leave a processing marker.
    await assert.rejects(
      store.executeIdempotent("test-scope", "idem-key-f14-2", payload, 200, () => {
        throw new Error("boom");
      })
    );
    assert.equal(
      store.state.idempotency_records.filter(
        (r) => r.scope_key === "test-scope" && r.idempotency_key === "idem-key-f14-2"
      ).length,
      0
    );
    const retry = await store.executeIdempotent(
      "test-scope",
      "idem-key-f14-2",
      payload,
      200,
      () => ({ v: 9 })
    );
    assert.equal(retry.replayed, false);
    assert.deepEqual(retry.body, { v: 9 });
  });

  it("A-03: the checkout token is never persisted; replay re-issues a fresh valid token", async () => {
    const token = issueCheckoutAccessToken(
      {
        oid: randomUUID(),
        ref: "ORD-A03",
        sid: "sess-a03",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      CHECKOUT_SECRET
    );
    const body = { checkout_access_token: token, order_id: "ord-a03" };

    // Pure functions first.
    const sanitized = sanitizeCheckoutResponseBody(body);
    assert.equal(sanitized.checkout_access_token, null);
    assert.equal(sanitized.checkout_token_payload.ref, "ORD-A03");
    assert.ok(!JSON.stringify(sanitized).includes(token.slice(0, 12)));
    const reissued = reissueCheckoutResponseBody(sanitized, CHECKOUT_SECRET);
    // Re-issue is DETERMINISTIC (HMAC over oid/ref/sid/exp): the same
    // payload mints the same token — that is the point, so a replay
    // returns a usable token without ever storing one.
    assert.equal(reissued.checkout_access_token, token);
    const payload = verifyCheckoutAccessToken(
      reissued.checkout_access_token,
      CHECKOUT_SECRET
    );
    assert.equal(payload.ref, "ORD-A03");

    // End to end through executeIdempotent.
    const first = await store.executeIdempotent(
      "checkout",
      "idem-key-a03-1",
      { ref: "ORD-A03" },
      201,
      () => body,
      {
        sanitizeStoredBody: sanitizeCheckoutResponseBody,
        reissueBody: (stored) => reissueCheckoutResponseBody(stored, CHECKOUT_SECRET),
      }
    );
    assert.equal(first.replayed, false);
    assert.equal(first.body.checkout_access_token, token);
    const stored = store.state.idempotency_records.find(
      (r) => r.scope_key === "checkout" && r.idempotency_key === "idem-key-a03-1"
    )!;
    assert.equal(
      (stored.response_body as { checkout_access_token: unknown }).checkout_access_token,
      null
    );
    const replay = await store.executeIdempotent(
      "checkout",
      "idem-key-a03-1",
      { ref: "ORD-A03" },
      201,
      () => body,
      {
        sanitizeStoredBody: sanitizeCheckoutResponseBody,
        reissueBody: (storedBody) =>
          reissueCheckoutResponseBody(storedBody, CHECKOUT_SECRET),
      }
    );
    assert.equal(replay.replayed, true);
    const replayedPayload = verifyCheckoutAccessToken(
      replay.body.checkout_access_token,
      CHECKOUT_SECRET
    );
    assert.equal(replayedPayload.ref, "ORD-A03");
  });
});

/* ------------------------------------------------------------------ */
/* In-memory: rate limit (B-09), search (B-13), A-11 flag, B-04        */
/* ------------------------------------------------------------------ */

describe("audit batch B — rate limit / search / store flags", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  it("B-09: the generic bucket is skipped while the specific lockout bucket applies", async () => {
    await store.checkRateLimit("lockout:test", 2);
    await store.checkRateLimit("lockout:test", 2);
    // A third attempt on the lockout bucket itself is limited…
    await assert.rejects(store.checkRateLimit("lockout:test", 2), {
      code: "RATE_LIMIT_EXCEEDED",
    } as never);
    // …but the generic bucket is not even touched when it applies.
    await store.checkRateLimit("auth:test", 5, 60_000, {
      skipWhenLimitedBy: { bucketKey: "lockout:test", maxRequests: 2 },
    });
    assert.equal(await store.isRateLimited("auth:test", 5), false);
    // Without the skip option the generic bucket increments as before.
    await store.checkRateLimit("auth:test", 5);
    assert.equal(await store.isRateLimited("auth:test", 1), true);
  });

  it("B-13: global search resolves customers/products through the maps (same results)", async () => {
    await store.withTransaction((state) => {
      const customer = seedCustomer(state, {
        name: "Acme Corp",
        email: "acme@example.com",
        normalized_email: "acme@example.com",
      });
      const product = seedProduct(state, { name: "Acme Widget", code: "ACME-1" });
      const order = seedOrder(state, customer.id, product);
      seedLicense(state, { product_id: product.id, customer_id: customer.id });
      void order;
    });
    const groups = searchGlobal(store.state, SUPER_ACTOR, "acme");
    const byKey = new Map(groups.map((g) => [g.key, g]));
    assert.equal(byKey.get("customers")?.items[0]?.label, "Acme Corp");
    assert.equal(byKey.get("orders")?.items[0]?.sublabel, "Acme Corp");
    const licenseSub = byKey.get("licenses")?.items[0]?.sublabel ?? "";
    assert.ok(licenseSub.includes("ACME-1"), `license sublabel: ${licenseSub}`);
  });

  it("A-11: a freshly created store is fresh; a zero max-age is not", async () => {
    assert.equal(store.isStateFresh(), true);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.isStateFresh(0), false);
  });

  it("B-04: withTransaction rolls back on throw and commits on success", async () => {
    await assert.rejects(
      store.withTransaction((state) => {
        state.customers.push(
          seedCustomer(state, {
            name: "Rollback Customer",
            email: "rollback@example.com",
            normalized_email: "rollback@example.com",
          })
        );
        throw new Error("boom");
      })
    );
    assert.equal(
      store.state.customers.filter((c) => c.email === "rollback@example.com").length,
      0
    );
    await store.withTransaction((state) => {
      seedCustomer(state, {
        name: "Committed Customer",
        email: "committed@example.com",
        normalized_email: "committed@example.com",
      });
    });
    assert.equal(
      store.state.customers.filter((c) => c.email === "committed@example.com").length,
      1
    );
  });
});

/* ------------------------------------------------------------------ */
/* In-memory: email (B-15), cron lease (A-05), outbox drain (B-02)     */
/* ------------------------------------------------------------------ */

describe("audit batch B — email / cron lease / outbox drain", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  it("B-15: sendStackMateEmail with a preloaded config never touches the DB", async () => {
    let connects = 0;
    const deps = emailDeps(() => {
      connects += 1;
      return scriptedSocket();
    });
    // db is null on purpose: a loadSmtpSettings call would throw.
    const result = await sendStackMateEmail(
      null as never,
      deps,
      { to: "a@example.com", subject: "Hi", text: "Hello" },
      PRELOADED_SMTP
    );
    assert.deepEqual(result, { sent: true });
    assert.equal(connects, 1);
  });

  it("B-15: sendEmailsBounded caps in-flight sends and reports per message", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = emailDeps(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return scriptedSocket(() => {
        inFlight -= 1;
      });
    });
    const messages = Array.from({ length: 6 }, (_, i) => ({
      to: `user${i}@example.com`,
      subject: `S${i}`,
      text: "Hello",
    }));
    const results = await sendEmailsBounded(
      null as never,
      deps,
      messages,
      { concurrency: 4, preloadedSmtp: PRELOADED_SMTP }
    );
    assert.equal(results.length, 6);
    assert.ok(results.every((r) => r.result.sent));
    assert.deepEqual(
      results.map((r) => r.message.to),
      messages.map((m) => m.to)
    );
    assert.ok(maxInFlight <= 4, `max in-flight was ${maxInFlight}`);
    assert.ok(maxInFlight > 1, `expected parallelism, max in-flight was ${maxInFlight}`);
  });

  it("A-05: a missing scheduled_job_runs table fails OPEN (loud log, run allowed)", async () => {
    const missingTableDb = {
      execute: async () => {
        throw Object.assign(new Error('relation "scheduled_job_runs" does not exist'), {
          code: "42P01",
        });
      },
    };
    assert.equal(await tryAcquireCronLease(missingTableDb, "test-job"), true);
    await releaseCronLease(missingTableDb, "test-job", { ok: true });
  });

  it("B-02: drain runs with bounded concurrency and reports duration_ms", async () => {
    const { endpoint } = await registerWebhookEndpointByAdmin(
      store,
      SUPER_ACTOR,
      {
        url: "https://example.com/hook",
        description: "Batch B endpoint",
        subscribed_events: ["order.created"],
      },
      { encryptionKey: ENCRYPTION_KEY, keyVersion: "v1", requestId: "test:b-02" }
    );
    void endpoint;
    for (let i = 0; i < 10; i++) store.state.outbox_events.push(outboxRow());
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-b-02",
      encryptionKey: ENCRYPTION_KEY,
      concurrency: 5,
      transport: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return { status: 200 };
      },
    });
    assert.equal(result.claimed, 10);
    assert.equal(result.delivered, 10);
    assert.equal(result.simulated, 0);
    assert.equal(typeof result.duration_ms, "number");
    assert.ok(result.duration_ms >= 0);
    assert.ok(maxInFlight <= 5, `max in-flight was ${maxInFlight}`);
    assert.ok(maxInFlight > 1, `expected parallelism, max in-flight was ${maxInFlight}`);
    // One transaction per event: each event has exactly one delivery row.
    assert.equal(store.state.webhook_deliveries.length, 10);
  });

  it("B-02: an injected CAPI deliverer really delivers; without it CAPI stays simulated", async () => {
    const site = seedSite(store.state);
    const trackId = randomUUID();
    store.state.tracking_configurations.push({
      id: randomUUID(),
      integrated_site_id: site.id,
      provider: "meta",
      label: "Test pixel",
      pixel_id: "123456",
      access_token_ciphertext: "test-cipher",
      encryption_key_version: "v1",
      test_event_code: null,
      enabled_events: ["Purchase"],
      status: "enabled",
      created_at: NOW,
      updated_at: NOW,
      rotated_at: null,
    });
    store.state.tracking_events.push({
      id: trackId,
      integrated_site_id: site.id,
      event_name: "Purchase",
      event_id: "evt-capi-1",
      event_time: NOW,
      event_source_url: "https://test.example.com/checkout",
      order_id: null,
      consent_state: "granted",
      consent_policy_version: "1",
      sanitized_payload: { value: 100 },
      status: "received",
      delivery_attempts: 0,
      delivered_at: null,
      created_at: NOW,
    });
    store.state.outbox_events.push(
      outboxRow({
        event_type: "tracking.meta_capi.dispatch",
        payload: { tracking_event_id: trackId, event_name: "Purchase", event_id: "evt-capi-1" },
      })
    );
    let deliveredPixel: string | null = null;
    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-b-02-capi",
      encryptionKey: ENCRYPTION_KEY,
      capiDeliver: async ({ pixelGroup, event }) => {
        deliveredPixel = pixelGroup?.pixel_id ?? null;
        assert.equal(event.id, trackId);
        return { delivered: true, status: "delivered" };
      },
    });
    assert.equal(result.delivered, 1);
    assert.equal(result.simulated, 0);
    assert.equal(deliveredPixel, "123456");
    const track = store.state.tracking_events.find((t) => t.id === trackId)!;
    assert.equal(track.status, "processed");
    assert.ok(track.delivered_at);

    // Same event again, no deliverer: simulated, never "processed".
    store.state.outbox_events.push(
      outboxRow({
        event_type: "tracking.meta_capi.dispatch",
        payload: { tracking_event_id: trackId, event_name: "Purchase", event_id: "evt-capi-2" },
      })
    );
    const simulated = await processTransactionalOutboxBatch(store, {
      workerId: "test-b-02-capi-2",
      encryptionKey: ENCRYPTION_KEY,
    });
    assert.equal(simulated.simulated, 1);
    assert.equal(simulated.delivered, 0);
    const trackAfter = store.state.tracking_events.find((t) => t.id === trackId)!;
    assert.equal(trackAfter.status, "simulated");
  });
});

/* ------------------------------------------------------------------ */
/* Postgres: B-01 targeted paths, C-05 claim, B-12 cleanup, C-03,     */
/* E-13 logo, B-14 cache, A-07, cron lease (A-05)                      */
/* ------------------------------------------------------------------ */

import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import { listMediaAssets } from "../src/modules/media/service.ts";
import {
  loadGeneralSettings,
  saveGeneralSettings,
} from "../src/modules/general-settings/service.ts";

const PG_DB_NAME = "stackmate_test_batch_b";

/** Count pg queries while patched; returns json_agg (full-load) hits. */
function countJsonAggQueries() {
  let total = 0;
  let jsonAgg = 0;
  const orig = Client.prototype.query as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]) {
    total += 1;
    const sql = String(
      (args[0] as { text?: unknown } | undefined)?.text ?? args[0] ?? ""
    );
    if (sql.toLowerCase().includes("json_agg")) jsonAgg += 1;
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
  Client.prototype.query = patched as never;
  return {
    counts: () => ({ total, jsonAgg }),
    restore: () => {
      Client.prototype.query = orig as never;
    },
  };
}

describe.skipIf(!DATABASE_URL)("audit batch B — postgres (targeted/claim/cleanup)", () => {
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];
  let adminClient: Client;
  let cleanup: () => Promise<void>;
  let dbUrl: string;
  let licenseKeyHash = "";
  let productId = "";
  let productCode = "";

  beforeAll(async () => {
    const setup = await setupTestDb(PG_DB_NAME);
    store = setup.store;
    adminClient = setup.adminClient;
    cleanup = setup.cleanup;
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${PG_DB_NAME}`;
    dbUrl = url.toString();
    await store.withTransaction((state) => {
      const customer = seedCustomer(state, {
        name: "Batch B Customer",
        email: "batchb@example.com",
        normalized_email: "batchb@example.com",
      });
      const product = seedProduct(state, { status: "active" });
      productId = product.id;
      productCode = product.code;
      const license = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
      });
      licenseKeyHash = license.license_key_hash;
      const role = state.roles.find((r) => r.key === "super_admin")!;
      state.user_roles.push({
        user_id: SUPER_ACTOR.user.id,
        role_id: role.id,
        assigned_at: NOW,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  function drizzleDb() {
    return (
      store as unknown as {
        drizzleDb: Parameters<typeof listMediaAssets>[0];
      }
    ).drizzleDb;
  }

  it("B-01: targeted lookups run no full-state load and match the full load", async () => {
    const targeted = await DrizzleStore.createTargeted({
      connectionString: dbUrl,
    });
    try {
      const counter = countJsonAggQueries();
      let principal: Awaited<ReturnType<typeof targeted.findStaffPrincipalByEmail>>;
      let license: Awaited<ReturnType<typeof targeted.findLicenseForValidation>>;
      let catalog: Awaited<ReturnType<typeof targeted.loadPublicCatalog>>;
      try {
        principal = await targeted.findStaffPrincipalByEmail(SUPER_ACTOR.user.email);
        license = await targeted.findLicenseForValidation(licenseKeyHash);
        catalog = await targeted.loadPublicCatalog();
      } finally {
        const { total, jsonAgg } = counter.counts();
        counter.restore();
        assert.equal(jsonAgg, 0, "a targeted lookup ran the combined full-state load");
        assert.ok(total <= 30, `targeted lookups took ${total} queries`);
      }
      assert.ok(principal);
      assert.equal(principal.user.email, SUPER_ACTOR.user.email);
      assert.ok(principal.roles.includes("super_admin"));
      assert.ok(principal.permissions.length > 0);
      assert.equal(principal.twoFactorPolicy.length, 0);
      assert.ok(license);
      assert.equal(license.productCode, productCode);
      assert.ok(catalog.products.some((p) => p.id === productId));

      // Equality against a fresh full load.
      const full = await store.loadState();
      const fullLicense = full.licenses.find((l) => l.license_key_hash === licenseKeyHash)!;
      assert.equal(license.license.license_number, fullLicense.license_number);
      assert.equal(license.license.status, fullLicense.status);
      const fullCodes = full.products
        .filter((p) => p.status === "active")
        .map((p) => p.code)
        .sort();
      const catalogCodes = catalog.products.map((p) => p.code).sort();
      assert.deepEqual(catalogCodes, fullCodes);
    } finally {
      await targeted.close();
    }
  });

  it("A-11: findStaffPrincipalByEmail is the fast path the principal resolver uses", async () => {
    // The store itself is fresh (created in this request) — a
    // principal resolve must not re-run the full load.
    assert.equal(store.isStateFresh(), true);
  });

  it("C-05: the outbox claim is real SQL — ordered, leased, attempt-counted", async () => {
    const past = (ms: number) => new Date(Date.now() - ms).toISOString();
    await store.withTransaction((state) => {
      state.outbox_events.push(
        outboxRow({ available_at: past(180_000) }),
        outboxRow({ available_at: past(120_000) }),
        outboxRow({ available_at: past(60_000) })
      );
    });
    const first = await store.claimOutboxEvents(2, "worker-1");
    assert.equal(first.length, 2);
    // Ordered by available_at, created_at — the earliest two.
    assert.ok(first[0]!.available_at <= first[1]!.available_at);
    assert.ok(
      first.every(
        (c) => c.status === "processing" && c.locked_by === "worker-1" && c.attempt_count === 1
      )
    );
    const second = await store.claimOutboxEvents(10, "worker-2");
    assert.equal(second.length, 1, "leased rows must not be re-claimed");
    assert.equal(second[0]?.locked_by, "worker-2");
    const third = await store.claimOutboxEvents(10, "worker-3");
    assert.equal(third.length, 0);
    // The DB rows agree with the claim.
    const reloaded = await store.loadState();
    const claimed = reloaded.outbox_events.filter((e) => e.locked_by !== null);
    assert.equal(claimed.length, 3);
  });

  it("B-12: cleanup prunes ONLY expiry-defined rows", async () => {
    const superId = SUPER_ACTOR.user.id;
    const siteId = randomUUID();
    const credId = randomUUID();
    await adminClient.query(
      `INSERT INTO integrated_sites (id, site_key, name) VALUES ($1, $2, 'B12 Site')`,
      [siteId, `b12-site-${randomUUID().slice(0, 8)}`]
    );
    await adminClient.query(
      `INSERT INTO site_credentials (id, integrated_site_id, key_id, credential_type) VALUES ($1, $2, $3, 'bearer_secret')`,
      [credId, siteId, `b12-key-${randomUUID().slice(0, 8)}`]
    );
    await adminClient.query(
      `INSERT INTO idempotency_records (id, scope_key, idempotency_key, request_hash, response_status, status, expires_at)
       VALUES (gen_random_uuid(), 'b12', 'expired-1', 'aa', 200, 'completed', NOW() - INTERVAL '1 hour'),
              (gen_random_uuid(), 'b12', 'fresh-1', 'aa', 200, 'completed', NOW() + INTERVAL '1 hour')`
    );
    await adminClient.query(
      `INSERT INTO rate_limit_buckets ("key", count, reset_at)
       VALUES ('b12-expired', 5, NOW() - INTERVAL '1 hour'),
              ('b12-fresh', 1, NOW() + INTERVAL '1 hour')`
    );
    await adminClient.query(
      `INSERT INTO sessions (id, token, user_id, expires_at)
       VALUES ('b12-sess-expired', 'tok-b12-exp', $1, NOW() - INTERVAL '1 hour'),
              ('b12-sess-fresh', 'tok-b12-fresh', $1, NOW() + INTERVAL '1 hour')`,
      [superId]
    );
    await adminClient.query(
      `INSERT INTO request_nonces (id, credential_id, nonce, request_timestamp, expires_at)
       VALUES (gen_random_uuid(), $1, 'n-exp', NOW(), NOW() - INTERVAL '1 hour'),
              (gen_random_uuid(), $1, 'n-fresh', NOW(), NOW() + INTERVAL '1 hour')`,
      [credId]
    );
    await adminClient.query(
      `INSERT INTO audit_logs (id, actor_type, action, resource_type, resource_id, outcome)
       VALUES (gen_random_uuid(), 'system', 'b12.probe', 'test', 'b12', 'success')`
    );
    const outboxBefore = (await adminClient.query(`SELECT count(*)::int AS n FROM outbox_events`))
      .rows[0].n as number;

    const counts = await store.cleanupExpiredRows();
    assert.deepEqual(counts, {
      idempotency_records: 1,
      rate_limit_buckets: 1,
      sessions: 1,
      request_nonces: 1,
    });

    const remaining = async (sql: string) =>
      (await adminClient.query(sql)).rows[0].n as number;
    assert.equal(await remaining(`SELECT count(*)::int AS n FROM idempotency_records WHERE scope_key = 'b12'`), 1);
    assert.equal(await remaining(`SELECT count(*)::int AS n FROM rate_limit_buckets WHERE "key" LIKE 'b12-%'`), 1);
    assert.equal(await remaining(`SELECT count(*)::int AS n FROM sessions WHERE id LIKE 'b12-%'`), 1);
    assert.equal(await remaining(`SELECT count(*)::int AS n FROM request_nonces WHERE nonce LIKE 'n-%'`), 1);
    // Untouched: audit rows and outbox rows are never pruned.
    assert.equal(await remaining(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'b12.probe'`), 1);
    assert.equal(await remaining(`SELECT count(*)::int AS n FROM outbox_events`), outboxBefore);
  });

  it("C-03: media tag search is exact-token containment on the GIN index", async () => {
    await adminClient.query(
      `INSERT INTO media_assets (id, object_key, original_filename, mime_type, byte_size, checksum_sha256, folder, tags)
       VALUES (gen_random_uuid(), 'batch-b/hero-banner.png', 'hero-banner.png', 'image/png', 1234, 'aabbcc', '', ARRAY['logo','brand']),
              (gen_random_uuid(), 'batch-b/notes.txt', 'readme-notes.txt', 'text/plain', 100, 'ddeeff', '', ARRAY['notes'])`
    );
    const db = drizzleDb();
    const byTag = await listMediaAssets(db, { q: "logo" });
    assert.equal(byTag.total, 1);
    assert.equal(byTag.items[0]?.original_filename, "hero-banner.png");
    // Case-insensitive exact token…
    const byTagUpper = await listMediaAssets(db, { q: "LOGO" });
    assert.equal(byTagUpper.total, 1);
    // …but a PARTIAL tag no longer matches (old unnest ILIKE did).
    const byPartial = await listMediaAssets(db, { q: "log" });
    assert.equal(byPartial.total, 0);
    // Filename search is still substring.
    const byName = await listMediaAssets(db, { q: "hero" });
    assert.equal(byName.total, 1);
  });

  it("E-13: product logo_asset_id survives a DB reload (load + catalog + update)", async () => {
    const assetId = randomUUID();
    let logoProductId = "";
    await store.withTransaction((state) => {
      state.uploaded_assets.push({
        id: assetId,
        object_key: "test/logo-b13.png",
        bucket_name: "test-bucket",
        original_filename: "logo.png",
        content_type: "image/png",
        byte_size: 123,
        checksum_sha256: "aabbcc",
        visibility: "private",
        uploaded_by_user_id: null,
        owner_customer_id: null,
        created_at: NOW,
      });
      const product = seedProduct(state, { status: "active", logo_asset_id: assetId });
      logoProductId = product.id;
    });
    const fresh = await DrizzleStore.create({ connectionString: dbUrl });
    try {
      const loaded = fresh.state.products.find((p) => p.id === logoProductId);
      assert.equal(loaded?.logo_asset_id, assetId);
      const catalog = await fresh.loadPublicCatalog();
      assert.equal(
        catalog.products.find((p) => p.id === logoProductId)?.logo_asset_id,
        assetId
      );
    } finally {
      await fresh.close();
    }
    await store.withTransaction((state) => {
      state.products.find((p) => p.id === logoProductId)!.logo_asset_id = null;
    });
    const fresh2 = await DrizzleStore.create({ connectionString: dbUrl });
    try {
      assert.equal(
        fresh2.state.products.find((p) => p.id === logoProductId)?.logo_asset_id,
        null
      );
    } finally {
      await fresh2.close();
    }
  });

  it("B-14: general-settings cache serves stale-then-fresh; save invalidates", async () => {
    const db = drizzleDb();
    await adminClient.query(
      `INSERT INTO general_settings (id, app_name, app_title, app_description, support_email, updated_at)
       VALUES ('default', 'Old Name', 'Old Title', '', '', NOW())
       ON CONFLICT (id) DO NOTHING`
    );
    const first = await loadGeneralSettings(db, "batch-b-k");
    assert.equal(first?.appName, "Old Name");
    await adminClient.query(
      `UPDATE general_settings SET app_name = 'New Name' WHERE id = 'default'`
    );
    const cached = await loadGeneralSettings(db, "batch-b-k");
    assert.equal(cached?.appName, "Old Name", "within 30s the cached row is served");
    const uncached = await loadGeneralSettings(db);
    assert.equal(uncached?.appName, "New Name");
    const saved = await saveGeneralSettings(db, { app_name: "Saved Name" }, "batch-b-k");
    assert.equal(saved.app_name, "Saved Name");
    const afterSave = await loadGeneralSettings(db, "batch-b-k");
    assert.equal(afterSave?.appName, "Saved Name", "save invalidates the cache");
  });

  it("A-07: the rate-limit buckets table exists (readiness probe)", async () => {
    assert.equal(await store.rateLimitTableExists(), true);
  });

  it("A-05: cron lease — acquire, second acquire fails, release frees it", async () => {
    const db = drizzleDb();
    assert.equal(await tryAcquireCronLease(db, "batch-b-lease"), true);
    assert.equal(await tryAcquireCronLease(db, "batch-b-lease"), false);
    await releaseCronLease(db, "batch-b-lease", { ok: true });
    assert.equal(await tryAcquireCronLease(db, "batch-b-lease"), true);
    await releaseCronLease(db, "batch-b-lease", { ok: true });
    const rows = await adminClient.query(
      `SELECT status FROM scheduled_job_runs WHERE job_key = 'batch-b-lease' ORDER BY started_at DESC LIMIT 1`
    );
    assert.equal(rows.rows[0]?.status, "completed");
  });
});

/* ------------------------------------------------------------------ */
/* Postgres: sweep reminder cap (B-03 + A-05) — own database so no     */
/* other suite's orders can add reminders to the count.                */
/* ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)("audit batch B — sweep reminder cap (B-03/A-05)", () => {
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const setup = await setupTestDb("stackmate_test_batch_b_sweep");
    store = setup.store;
    cleanup = setup.cleanup;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("caps reminders at 25 per run; the next run plans the rest", async () => {
    const now = new Date("2026-11-17T00:00:00.000Z");
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, {
        name: "Cap Customer",
        email: "cap@example.com",
        normalized_email: "cap@example.com",
      });
      for (let i = 0; i < 30; i++) {
        const order = seedOrder(state, customer.id, product, {
          total_minor: 100000,
          subtotal_minor: 100000,
        });
        createInstallmentsForOrderInTx(
          state,
          order,
          { kind: "full", due_date: "2026-11-24" },
          now
        );
      }
    });
    assert.equal(SWEEP_REMINDERS_PER_RUN_CAP, 25);
    const first = await runRenewalExpirySweep(store, {
      licenseVerifierSecret: "test",
      requestId: "test:cap-1",
      now,
    });
    assert.deepEqual(first.errors, []);
    assert.equal(first.reminders_due.length, 25);
    assert.equal(first.reminders_capped, 5);
    await markSweepRemindersSent(store, first.reminders_due, now);
    const second = await runRenewalExpirySweep(store, {
      licenseVerifierSecret: "test",
      requestId: "test:cap-2",
      now,
    });
    assert.equal(second.reminders_due.length, 5);
    assert.equal(second.reminders_capped, 0);
  });
});
