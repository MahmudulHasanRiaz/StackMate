/**
 * E-01 — Meta CAPI drain wiring (audit #2 Critical).
 *
 * Proves the outbox drain really calls `deliverMetaCapiEvent` through
 * `createCapiDeliver` (modules/webhooks/service.ts), with the honest
 * labelling intact:
 * - site-linked Purchase + enabled Meta group → real delivery,
 *   "processed" + delivered_at, event_source_url = site domain;
 * - no Meta destination (no enabled group / site-less event) →
 *   terminal "skipped", NO fetch call, never retried, never recorded
 *   delivered (C-2 Option A);
 * - Meta 4xx rejection → retrying, never recorded delivered.
 *
 * All delivery goes through a mocked fetch — no real Meta call.
 * In-memory store only; no DATABASE_URL needed.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { encryptSecretAtRest } from "../src/platform/crypto/index.ts";
import {
  createCapiDeliver,
  processTransactionalOutboxBatch,
} from "../src/modules/webhooks/service.ts";
import { seedSite } from "./customer-order-helpers.ts";

// Test-only fixture values (never real secrets).
const TEST_KEY = "test-capi-key-for-drain-wiring";
const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();
const PIXEL_ID = "1462719181041087";

function outboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    event_key: `test:${randomUUID()}`,
    aggregate_type: "tracking_event",
    aggregate_id: randomUUID(),
    event_type: "tracking.meta_capi.dispatch",
    payload: {},
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

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}

function mockFetch(
  calls: CapturedCall[],
  response: { status: number; json: Record<string, unknown> }
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    return new Response(JSON.stringify(response.json), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function mustNotFetch(): typeof fetch {
  return (async () => {
    throw new Error("fetch must not be called for a skipped CAPI event");
  }) as typeof fetch;
}

describe("E-01 CAPI drain wiring", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  function seedSiteWithDomain(domain: string) {
    const site = seedSite(store.state);
    site.domains.push({
      id: randomUUID(),
      domain,
      verification_method: "manual_review",
      verification_challenge: "",
      verification_status: "verified",
      verified_at: NOW,
      is_primary: true,
    });
    return site;
  }

  function seedMetaGroup(siteId: string, status: "enabled" | "disabled" = "enabled") {
    const groupId = randomUUID();
    store.state.tracking_configurations.push({
      id: groupId,
      integrated_site_id: siteId,
      provider: "meta",
      label: "Test pixel",
      pixel_id: PIXEL_ID,
      access_token_ciphertext: encryptSecretAtRest(
        "test-capi-access-token",
        TEST_KEY,
        "v1",
        `tracking_configurations:${groupId}`
      ),
      encryption_key_version: "v1",
      test_event_code: "TEST93801",
      enabled_events: ["Purchase", "Lead"],
      status,
      created_at: NOW,
      updated_at: NOW,
      rotated_at: null,
    });
    return groupId;
  }

  function seedTrackingEvent(overrides: Record<string, unknown> = {}) {
    const trackId = randomUUID();
    store.state.tracking_events.push({
      id: trackId,
      integrated_site_id: randomUUID(),
      event_name: "Purchase",
      event_id: `purchase_${trackId.slice(0, 8)}`,
      event_time: NOW,
      event_source_url: null,
      order_id: null,
      consent_state: "granted",
      consent_policy_version: "server-verified-v1",
      sanitized_payload: {},
      status: "queued",
      delivery_attempts: 0,
      delivered_at: null,
      created_at: NOW,
      ...overrides,
    });
    return trackId;
  }

  function capiDeliver(fetchFn: typeof fetch) {
    return createCapiDeliver(
      { ENCRYPTION_KEY_V1: TEST_KEY, META_GRAPH_API_VERSION: "v21.0" },
      { fetchFn, sleepMs: async () => {} }
    );
  }

  it("site-linked Purchase + enabled Meta group → real delivery, processed + delivered_at", async () => {
    const site = seedSiteWithDomain("test.example.com");
    seedMetaGroup(site.id);
    const trackId = seedTrackingEvent({
      integrated_site_id: site.id,
      event_id: "purchase_ORD-10001",
      order_id: randomUUID(),
      sanitized_payload: {
        order_reference: "ORD-10001",
        currency: "BDT",
        value_minor: 50000,
      },
    });
    store.state.outbox_events.push(
      outboxRow({
        event_type: "tracking.meta_capi.dispatch",
        payload: { tracking_event_id: trackId, event_name: "Purchase", event_id: "purchase_ORD-10001" },
      })
    );

    const calls: CapturedCall[] = [];
    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-capi-deliver",
      encryptionKey: TEST_KEY,
      capiDeliver: capiDeliver(
        mockFetch(calls, { status: 200, json: { events_received: 1, fbtrace_id: "trace-1" } })
      ),
    });

    assert.equal(result.delivered, 1);
    assert.equal(result.simulated, 0);
    assert.equal(result.skipped, 0);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.ok(call.url.includes("graph.facebook.com"), call.url);
    assert.ok(call.url.includes("v21.0"), call.url);
    assert.ok(call.url.includes(PIXEL_ID), call.url);
    const data = call.body.data as Array<Record<string, unknown>>;
    assert.equal(data.length, 1);
    const sent = data[0]!;
    assert.equal(sent.event_name, "Purchase");
    assert.equal(sent.event_id, "purchase_ORD-10001");
    // Purchase events carry event_source_url null — the drain derives
    // the site's own domain (API spec §17.5 / pixel allowlist).
    assert.equal(sent.event_source_url, "https://test.example.com");
    const customData = sent.custom_data as Record<string, unknown>;
    assert.equal(customData.value, 500);
    assert.equal(customData.currency, "BDT");
    assert.equal(customData.order_reference, undefined);
    assert.equal(call.body.test_event_code, "TEST93801");

    const track = store.state.tracking_events.find((t) => t.id === trackId)!;
    assert.equal(track.status, "processed");
    assert.equal(track.delivery_attempts, 1);
    assert.ok(track.delivered_at);
    const outbox = store.state.outbox_events.find(
      (e) => e.payload.tracking_event_id === trackId
    )!;
    assert.equal(outbox.status as string, "delivered");
    assert.ok(outbox.processed_at);
    assert.ok(
      store.state.audit_logs.some((l) => l.action === "webhooks.outbox_event.delivered")
    );
  });

  it("site-linked Purchase but NO enabled Meta pixel group → skipped, no fetch, never delivered", async () => {
    const site = seedSiteWithDomain("test.example.com");
    // Deliberately no tracking_configurations row at all.
    const trackId = seedTrackingEvent({
      integrated_site_id: site.id,
      event_id: "purchase_ORD-10002",
      order_id: randomUUID(),
      sanitized_payload: { currency: "BDT", value_minor: 10000 },
    });
    store.state.outbox_events.push(
      outboxRow({
        event_type: "tracking.meta_capi.dispatch",
        payload: { tracking_event_id: trackId },
      })
    );

    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-capi-no-group",
      encryptionKey: TEST_KEY,
      capiDeliver: capiDeliver(mustNotFetch()),
    });

    assert.equal(result.skipped, 1);
    assert.equal(result.delivered, 0);
    assert.equal(result.simulated, 0);
    assert.equal(result.retrying, 0);
    assert.equal(result.dead_lettered, 0);
    const outbox = store.state.outbox_events.find(
      (e) => e.payload.tracking_event_id === trackId
    )!;
    assert.equal(outbox.status as string, "skipped");
    assert.ok(outbox.processed_at);
    // The tracking_events CHECK has no "skipped" (migration 0015) —
    // "simulated" is the terminal non-delivered state there; the
    // outbox row + audit carry the precise outcome.
    const track = store.state.tracking_events.find((t) => t.id === trackId)!;
    assert.equal(track.status as string, "simulated");
    assert.equal(track.delivered_at, null);
    const audit = store.state.audit_logs.find(
      (l) => l.action === "webhooks.outbox_event.skipped_no_meta_destination"
    );
    assert.ok(audit, "skip must be audited with the no_meta_destination action");
    assert.equal(
      (audit!.changes as Record<string, unknown>).reason,
      "no_meta_destination"
    );
  });

  it("disabled Meta pixel group → skipped, no fetch", async () => {
    const site = seedSiteWithDomain("test.example.com");
    seedMetaGroup(site.id, "disabled");
    const trackId = seedTrackingEvent({
      integrated_site_id: site.id,
      event_id: "purchase_ORD-10003",
    });
    store.state.outbox_events.push(
      outboxRow({
        event_type: "tracking.meta_capi.dispatch",
        payload: { tracking_event_id: trackId },
      })
    );

    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-capi-disabled",
      encryptionKey: TEST_KEY,
      capiDeliver: capiDeliver(mustNotFetch()),
    });

    assert.equal(result.skipped, 1);
    assert.equal(result.delivered, 0);
    const outbox = store.state.outbox_events.find(
      (e) => e.payload.tracking_event_id === trackId
    )!;
    assert.equal(outbox.status as string, "skipped");
  });

  it("site-less Purchase (no integrated site) → skipped, no fetch (C-2 Option A)", async () => {
    const trackId = seedTrackingEvent({
      integrated_site_id: "",
      event_id: "purchase_ORD-10004",
    });
    store.state.outbox_events.push(
      outboxRow({
        event_type: "tracking.meta_capi.dispatch",
        payload: { tracking_event_id: trackId },
      })
    );

    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-capi-no-site",
      encryptionKey: TEST_KEY,
      capiDeliver: capiDeliver(mustNotFetch()),
    });

    assert.equal(result.skipped, 1);
    assert.equal(result.delivered, 0);
    const outbox = store.state.outbox_events.find(
      (e) => e.payload.tracking_event_id === trackId
    )!;
    assert.equal(outbox.status as string, "skipped");
    assert.equal(outbox.attempt_count, 1);
  });

  it("Meta 4xx rejection → retrying, never recorded delivered", async () => {
    const site = seedSiteWithDomain("test.example.com");
    seedMetaGroup(site.id);
    const trackId = seedTrackingEvent({
      integrated_site_id: site.id,
      event_id: "purchase_ORD-10005",
      sanitized_payload: { currency: "BDT", value_minor: 25000 },
    });
    store.state.outbox_events.push(
      outboxRow({
        event_type: "tracking.meta_capi.dispatch",
        payload: { tracking_event_id: trackId },
      })
    );

    const calls: CapturedCall[] = [];
    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-capi-rejected",
      encryptionKey: TEST_KEY,
      capiDeliver: capiDeliver(
        mockFetch(calls, {
          status: 400,
          json: {
            error: { message: "Invalid OAuth access token", code: 190 },
            fbtrace_id: "trace-400",
          },
        })
      ),
    });

    assert.equal(calls.length, 1);
    assert.equal(result.retrying, 1);
    assert.equal(result.delivered, 0);
    assert.equal(result.simulated, 0);
    assert.equal(result.skipped, 0);
    const outbox = store.state.outbox_events.find(
      (e) => e.payload.tracking_event_id === trackId
    )!;
    assert.equal(outbox.status as string, "pending");
    assert.equal(outbox.attempt_count, 1);
    // E-01 diagnostic fix: the recorded error must carry Meta's REAL
    // detail (HTTP status + message + fbtrace), not bare CAPI_rejected.
    assert.equal(
      outbox.last_error_code,
      "CAPI_rejected (HTTP 400: Meta error 190: Invalid OAuth access token) [fbtrace: trace-400]"
    );
    const track = store.state.tracking_events.find((t) => t.id === trackId)!;
    assert.equal(track.status as string, "queued");
    assert.equal(track.delivered_at, null);
  });

  it("Meta 2xx but 0 events received → rejected with HTTP status + message + fbtrace", async () => {
    const site = seedSiteWithDomain("test.example.com");
    seedMetaGroup(site.id);
    const trackId = seedTrackingEvent({
      integrated_site_id: site.id,
      event_id: "purchase_ORD-10006",
      sanitized_payload: { currency: "BDT", value_minor: 25000 },
    });
    store.state.outbox_events.push(
      outboxRow({
        event_type: "tracking.meta_capi.dispatch",
        payload: { tracking_event_id: trackId },
      })
    );

    const calls: CapturedCall[] = [];
    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-capi-zero-events",
      encryptionKey: TEST_KEY,
      capiDeliver: capiDeliver(
        mockFetch(calls, {
          status: 200,
          json: { events_received: 0, fbtrace_id: "trace-zero" },
        })
      ),
    });

    assert.equal(calls.length, 1);
    assert.equal(result.retrying, 1);
    assert.equal(result.delivered, 0);
    const outbox = store.state.outbox_events.find(
      (e) => e.payload.tracking_event_id === trackId
    )!;
    assert.equal(outbox.status as string, "pending");
    assert.equal(outbox.attempt_count, 1);
    // E-01 diagnostic fix: a 2xx that took 0 events is a rejection
    // whose cause must be visible — HTTP 200 + Meta's message +
    // fbtrace, still prefixed CAPI_rejected.
    assert.equal(
      outbox.last_error_code,
      "CAPI_rejected (HTTP 200: Meta accepted the request but received 0 events.) [fbtrace: trace-zero]"
    );
    const track = store.state.tracking_events.find((t) => t.id === trackId)!;
    assert.equal(track.status as string, "queued");
    assert.equal(track.delivered_at, null);
  });

  it("non-Purchase event (Lead) keeps its own event_source_url and delivers", async () => {
    const site = seedSiteWithDomain("test.example.com");
    seedMetaGroup(site.id);
    const trackId = seedTrackingEvent({
      integrated_site_id: site.id,
      event_name: "Lead",
      event_id: "lead_abc123",
      event_source_url: "https://test.example.com/lead-page",
      sanitized_payload: {
        action_source: "website",
        user_data_hashes: { em: "aabbccddeeff" },
        custom_data: { content_name: "Lead form" },
      },
    });
    store.state.outbox_events.push(
      outboxRow({
        event_type: "tracking.meta_capi.dispatch",
        payload: { tracking_event_id: trackId, event_name: "Lead", event_id: "lead_abc123" },
      })
    );

    const calls: CapturedCall[] = [];
    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-capi-lead",
      encryptionKey: TEST_KEY,
      capiDeliver: capiDeliver(
        mockFetch(calls, { status: 200, json: { events_received: 1 } })
      ),
    });

    assert.equal(result.delivered, 1);
    assert.equal(calls.length, 1);
    const sent = (calls[0]!.body.data as Array<Record<string, unknown>>)[0]!;
    assert.equal(sent.event_name, "Lead");
    // The event's own event_source_url wins over the site domain.
    assert.equal(sent.event_source_url, "https://test.example.com/lead-page");
    const userData = sent.user_data as Record<string, unknown>;
    assert.equal(userData.em, "aabbccddeeff");
    const customData = sent.custom_data as Record<string, unknown>;
    assert.equal(customData.content_name, "Lead form");
  });
});
