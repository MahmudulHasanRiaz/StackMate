/**
 * API-domain audit fixes — webhooks/outbox (C-2/D-6, M-3, M-14e).
 *
 *  - C-2/D-6: with NO transport the dispatcher is SIMULATED — webhook
 *    delivery rows, tracking events and outbox events are recorded as
 *    "simulated" (never "delivered"/"processed"), `delivered_at`
 *    stays null, and the result counts them in `simulated`. With a
 *    real transport a 2xx records "delivered" + `delivered_at`.
 *  - C-2: `tracking.meta_capi.dispatch` is ALWAYS simulated (the
 *    Meta client is a known stub) — no delivery attempt is counted.
 *  - M-3: delivery-time DNS re-check + redirect re-validation —
 *    a redirect to a private IP is blocked, a hostname resolving
 *    to a private IP is blocked, a public destination delivers.
 *  - M-14e: terminal outcomes (simulated / delivered / dead-letter)
 *    write audit rows; retries write none.
 *
 * In-memory (no Postgres). `globalThis.fetch` is stubbed ONLY for
 * the M-3 tests (DoH + target fetches) and restored afterwards.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SUPER_ACTOR } from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  assertHostnameResolvesToPublicIp,
  fetchWithSsrfCheckedRedirects,
  processTransactionalOutboxBatch,
  registerWebhookEndpointByAdmin,
} from "../src/modules/webhooks/service.ts";
import type { AppError } from "../src/shared/errors.ts";

const ENCRYPTION_KEY = "test-encryption-key-for-audit-fixes";
const KEY_VERSION = "v1";
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

describe("webhooks/outbox — audit fixes (C-2, M-3, M-14e)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedEndpoint() {
    const { endpoint } = await registerWebhookEndpointByAdmin(
      store,
      SUPER_ACTOR,
      {
        url: "https://example.com/hook",
        description: "Audit test endpoint",
        subscribed_events: ["order.created"],
      },
      { encryptionKey: ENCRYPTION_KEY, keyVersion: KEY_VERSION, requestId: "test:hook-1" },
    );
    return endpoint;
  }

  it("C-2/D-6: no transport → simulated — rows say 'simulated', delivered_at null, counted in simulated", async () => {
    await seedEndpoint();
    const ev = outboxRow();
    store.state.outbox_events.push(ev);

    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-worker",
      encryptionKey: ENCRYPTION_KEY,
    });

    assert.deepEqual(result, {
      claimed: 1,
      delivered: 0,
      simulated: 1,
      retrying: 0,
      dead_lettered: 0,
    });
    const outbox = store.state.outbox_events.find((e) => e.id === ev.id)!;
    assert.equal(outbox.status as string, "simulated");
    assert.ok(outbox.processed_at);
    const delivery = store.state.webhook_deliveries.find((d) => d.event_id === ev.id)!;
    assert.equal(delivery.status as string, "simulated");
    assert.equal(delivery.delivered_at, null);
    assert.equal(delivery.last_http_status, 200);
    const audit = store.state.audit_logs.find(
      (l) => l.action === "webhooks.outbox_event.simulated",
    );
    assert.ok(audit);
    assert.equal(audit?.request_id, "worker:test-worker");
    assert.equal(audit?.actor_type, "system");
  });

  it("C-2/D-6: a real transport 2xx → 'delivered' + delivered_at, counted in delivered", async () => {
    await seedEndpoint();
    const ev = outboxRow();
    store.state.outbox_events.push(ev);

    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-worker",
      encryptionKey: ENCRYPTION_KEY,
      transport: async () => ({ status: 200 }),
    });

    assert.equal(result.delivered, 1);
    assert.equal(result.simulated, 0);
    const outbox = store.state.outbox_events.find((e) => e.id === ev.id)!;
    assert.equal(outbox.status, "delivered");
    const delivery = store.state.webhook_deliveries.find((d) => d.event_id === ev.id)!;
    assert.equal(delivery.status, "delivered");
    assert.ok(delivery.delivered_at);
    assert.ok(
      store.state.audit_logs.some((l) => l.action === "webhooks.outbox_event.delivered"),
    );
  });

  it("C-2: Meta CAPI dispatch is always simulated — no attempt counted, no delivered_at", async () => {
    const trackId = randomUUID();
    store.state.tracking_events.push({
      id: trackId,
      integrated_site_id: randomUUID(),
      event_name: "Lead",
      event_id: `lead_${trackId}`,
      event_time: NOW,
      event_source_url: null,
      order_id: null,
      consent_state: "granted",
      consent_policy_version: "1",
      sanitized_payload: {},
      status: "queued",
      delivery_attempts: 0,
      delivered_at: null,
      created_at: NOW,
    });
    const ev = outboxRow({
      event_type: "tracking.meta_capi.dispatch",
      payload: { tracking_event_id: trackId },
    });
    store.state.outbox_events.push(ev);

    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-worker",
      encryptionKey: ENCRYPTION_KEY,
      transport: async () => ({ status: 200 }),
    });

    // Even with a REAL transport, the CAPI branch stays simulated.
    assert.equal(result.simulated, 1);
    assert.equal(result.delivered, 0);
    const track = store.state.tracking_events.find((t) => t.id === trackId)!;
    assert.equal(track.status as string, "simulated");
    assert.equal(track.delivery_attempts, 0);
    assert.equal(track.delivered_at, null);
  });

  it("M-14e: a dead-lettered dispatch writes a failed audit row; a retry writes none", async () => {
    await seedEndpoint();
    const ev = outboxRow({ attempt_count: 4 });
    store.state.outbox_events.push(ev);

    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-worker",
      encryptionKey: ENCRYPTION_KEY,
      transport: async () => {
        throw new Error("boom");
      },
    });

    assert.equal(result.dead_lettered, 1);
    assert.equal(result.retrying, 0);
    const outbox = store.state.outbox_events.find((e) => e.id === ev.id)!;
    assert.equal(outbox.status, "dead_letter");
    const audit = store.state.audit_logs.find(
      (l) => l.action === "webhooks.outbox_event.dead_lettered",
    );
    assert.ok(audit);
    assert.equal(audit?.outcome, "failed");
    assert.equal(audit?.changes?.error_code, "boom");

    // Retry path: attempt 1 of 5 → back to pending, NO audit row.
    const ev2 = outboxRow();
    store.state.outbox_events.push(ev2);
    const before = store.state.audit_logs.length;
    const result2 = await processTransactionalOutboxBatch(store, {
      workerId: "test-worker",
      encryptionKey: ENCRYPTION_KEY,
      transport: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(result2.retrying, 1);
    assert.equal(
      store.state.outbox_events.find((e) => e.id === ev2.id)?.status,
      "pending",
    );
    assert.equal(store.state.audit_logs.length, before);
  });

  function stubFetch(
    dohIp: string,
    target: (url: string) => Response,
  ): void {
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, _init?: RequestInit): Promise<Response> => {
        const href = String(url);
        if (href.startsWith("https://cloudflare-dns.com/dns-query")) {
          return new Response(
            JSON.stringify({ Answer: [{ data: dohIp, type: 1 }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return target(href);
      },
    );
  }

  it("M-3: a redirect to a private IP is blocked (SSRF_BLOCKED)", async () => {
    stubFetch("93.184.216.34", (url) =>
      url === "https://example.com/hook"
        ? new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/admin" },
          })
        : new Response("ok", { status: 200 }),
    );
    await assert.rejects(
      () =>
        fetchWithSsrfCheckedRedirects("https://example.com/hook", {
          method: "POST",
          body: "{}",
        }),
      (err: AppError) => {
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );
  });

  it("M-3: a hostname resolving to a private IP is blocked (SSRF_BLOCKED)", async () => {
    stubFetch("10.0.0.5", () => new Response("ok", { status: 200 }));
    await assert.rejects(
      () => assertHostnameResolvesToPublicIp("evil.example.com"),
      (err: AppError) => {
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );
  });

  it("M-3: a public destination delivers through the checked fetch", async () => {
    stubFetch("93.184.216.34", () => new Response("ok", { status: 200 }));
    const res = await fetchWithSsrfCheckedRedirects("https://example.com/hook", {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 200);
  });
});
