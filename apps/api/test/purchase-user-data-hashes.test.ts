/**
 * E-01 — Purchase CAPI events must carry hashed user_data.
 *
 * Meta rejects a Purchase event with empty user_data (HTTP 400,
 * error 100 "Invalid parameter", proven live 2026-11-26). The
 * approve-payment flow records the Purchase tracking event in
 * modules/payments/service.ts; it must populate
 * `sanitized_payload.user_data_hashes` from the order's customer
 * (same transforms as the website-ingested path in
 * modules/tracking/service.ts):
 * - em = sha256(trimmed + lowercased email)
 * - ph = sha256(digits of the E.164-normalized phone)
 * Only fields the customer actually has are included, and raw
 * email/phone must NEVER appear in the recorded event.
 *
 * Expected hashes are computed here with node:crypto directly on
 * literal strings — never via the service's own helpers — so the
 * test is independent of the implementation.
 *
 * In-memory (no Postgres): seeds run against StackMateDataStore
 * state via the shared seed helpers; delivery goes through a
 * mocked fetch — no real Meta call.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { encryptSecretAtRest } from "../src/platform/crypto/index.ts";
import {
  approvePaymentSubmissionByStaff,
  createInstallmentsForOrderInTx,
  submitManualPaymentClaim,
} from "../src/modules/payments/service.ts";
import {
  createCapiDeliver,
  processTransactionalOutboxBatch,
} from "../src/modules/webhooks/service.ts";
import {
  SUPER_ACTOR,
  seedCustomer,
  seedInvoice,
  seedOrder,
  seedPaymentMethod,
  seedProduct,
  seedSite,
} from "./customer-order-helpers.ts";

const APPROVE_CONFIG = { licenseVerifierSecret: "test-verifier-secret", requestId: "test:approve" };
const TEST_KEY = "test-capi-key-for-purchase-user-data";
const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();
const PIXEL_ID = "1462719181041087";

// Mixed case + surrounding whitespace + dashes prove the
// trim/lowercase/E.164 transforms; the expected hashes below are
// over the CANONICAL forms only.
const RAW_EMAIL = "  Test@Example.com ";
const CANONICAL_EMAIL = "test@example.com";
const RAW_PHONE = "01601-701567";
const CANONICAL_PHONE_DIGITS = "8801601701567";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("E-01 Purchase user_data hashes (payments/service.ts)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  async function seedSiteLinkedOrder(customerOverrides: Record<string, unknown>) {
    let orderId = "";
    let methodId = "";
    let siteId = "";
    await store.withTransaction((state) => {
      const site = seedSite(state);
      site.domains.push({
        id: randomUUID(),
        domain: "test.example.com",
        verification_method: "manual_review",
        verification_challenge: "",
        verification_status: "verified",
        verified_at: NOW,
        is_primary: true,
      });
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Purchase Hash Test", ...customerOverrides });
      const order = seedOrder(state, customer.id, product, {
        total_minor: 100_000,
        subtotal_minor: 100_000,
        integrated_site_id: site.id,
      });
      const method = seedPaymentMethod(state);
      seedInvoice(state, order, customer.id);
      createInstallmentsForOrderInTx(
        state,
        order,
        { kind: "full", due_date: "2026-12-01" },
        new Date("2026-11-17T00:00:00.000Z"),
      );
      orderId = order.id;
      methodId = method.id;
      siteId = site.id;
    });
    const order = store.state.orders.find((o) => o.id === orderId)!;
    return { order, methodId, siteId };
  }

  async function claimAndApproveFull(orderPublicReference: string, methodId: string, keySuffix: string) {
    const claim = await submitManualPaymentClaim(store, {
      orderPublicReference,
      idempotencyKey: `test:pay-hash-${keySuffix}`,
      rawBody: {
        payment_method_id: methodId,
        amount_minor: 100_000,
        currency_code: "BDT",
        transfer_rail: "npsb",
      },
      requestId: "test:claim",
    });
    await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      claim.payment_submission.id,
      {
        verified_amount_minor: 100_000,
        currency_code: "BDT",
        verification_reference: `TXN-HASH-${keySuffix}`,
      },
      APPROVE_CONFIG,
    );
  }

  function purchaseTrackingEvent(orderId: string) {
    const track = store.state.tracking_events.find(
      (t) => t.order_id === orderId && t.event_name === "Purchase",
    );
    assert.ok(track, "approving a site-linked order must record a Purchase tracking event");
    return track!;
  }

  function userDataHashes(orderId: string) {
    const track = purchaseTrackingEvent(orderId);
    const payload = track.sanitized_payload as Record<string, unknown>;
    const hashes = payload.user_data_hashes as Record<string, unknown> | undefined;
    assert.ok(hashes, "Purchase event must carry sanitized_payload.user_data_hashes");
    return { track, hashes: hashes! };
  }

  it("customer with email + phone → em + ph are the sha256 of the canonical forms; no raw PII stored", async () => {
    const { order, methodId } = await seedSiteLinkedOrder({
      email: RAW_EMAIL,
      normalized_email: CANONICAL_EMAIL,
      phone: RAW_PHONE,
      normalized_phone: "+8801601701567",
    });
    await claimAndApproveFull(order.public_reference, methodId, "both");

    const { track, hashes } = userDataHashes(order.id);
    assert.equal(hashes.em, sha256(CANONICAL_EMAIL));
    assert.equal(hashes.ph, sha256(CANONICAL_PHONE_DIGITS));
    assert.equal(Object.keys(hashes).sort().join(","), "em,ph");

    // Raw PII must never be stored in the tracking event.
    const serialized = JSON.stringify(track);
    assert.ok(!serialized.includes("Test@Example.com"), "raw email must not be stored");
    assert.ok(!serialized.includes("test@example.com"), "lowercased email must not be stored either");
    assert.ok(!serialized.includes("01601"), "raw phone must not be stored");
    assert.ok(!serialized.includes("8801601701567"), "normalized phone digits must not be stored");

    // The CAPI outbox row for this event must exist (drain input).
    assert.ok(
      store.state.outbox_events.some(
        (e) => e.event_type === "tracking.meta_capi.dispatch" && e.aggregate_id === track.id,
      ),
      "meta_capi.purchase outbox row must exist for the Purchase event",
    );
  });

  it("email-only customer → em present, ph omitted (never invented)", async () => {
    const { order, methodId } = await seedSiteLinkedOrder({
      email: RAW_EMAIL,
      normalized_email: CANONICAL_EMAIL,
      phone: null,
      normalized_phone: null,
    });
    await claimAndApproveFull(order.public_reference, methodId, "email-only");

    const { hashes } = userDataHashes(order.id);
    assert.equal(hashes.em, sha256(CANONICAL_EMAIL));
    assert.equal("ph" in hashes, false, "ph must be omitted when the customer has no phone");
  });

  it("phone-only customer → ph present, em omitted (never invented)", async () => {
    const { order, methodId } = await seedSiteLinkedOrder({
      email: null,
      normalized_email: null,
      phone: RAW_PHONE,
      normalized_phone: "+8801601701567",
    });
    await claimAndApproveFull(order.public_reference, methodId, "phone-only");

    const { hashes } = userDataHashes(order.id);
    assert.equal(hashes.ph, sha256(CANONICAL_PHONE_DIGITS));
    assert.equal("em" in hashes, false, "em must be omitted when the customer has no email");
  });

  it("drain sends the recorded hashes as Meta user_data (no empty user_data)", async () => {
    const { order, methodId, siteId } = await seedSiteLinkedOrder({
      email: RAW_EMAIL,
      normalized_email: CANONICAL_EMAIL,
      phone: RAW_PHONE,
      normalized_phone: "+8801601701567",
    });
    await claimAndApproveFull(order.public_reference, methodId, "drain");

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
        `tracking_configurations:${groupId}`,
      ),
      encryption_key_version: "v1",
      test_event_code: "TEST93801",
      enabled_events: ["Purchase", "Lead"],
      status: "enabled",
      created_at: NOW,
      updated_at: NOW,
      rotated_at: null,
    });

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = (async (input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url: String(input), body });
      return new Response(JSON.stringify({ events_received: 1, fbtrace_id: "trace-hash" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-purchase-user-data",
      encryptionKey: TEST_KEY,
      capiDeliver: createCapiDeliver(
        { ENCRYPTION_KEY_V1: TEST_KEY, META_GRAPH_API_VERSION: "v21.0" },
        { fetchFn, sleepMs: async () => {} },
      ),
    });

    assert.equal(result.delivered, 1);
    assert.equal(calls.length, 1);
    const sent = (calls[0]!.body.data as Array<Record<string, unknown>>)[0]!;
    assert.equal(sent.event_name, "Purchase");
    const userData = sent.user_data as Record<string, unknown>;
    assert.equal(userData.em, sha256(CANONICAL_EMAIL));
    assert.equal(userData.ph, sha256(CANONICAL_PHONE_DIGITS));
    assert.equal(Object.keys(userData).sort().join(","), "em,ph");
    assert.ok(
      !JSON.stringify(sent).includes("test@example.com") &&
        !JSON.stringify(sent).includes("8801601701567"),
      "no raw PII may be sent to Meta",
    );
  });
});
