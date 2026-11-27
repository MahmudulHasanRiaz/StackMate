/**
 * Notifications v1 (OD-08): two templates only, email only.
 *
 * - Staff approve → the customer gets the payment-approved email.
 * - Staff reject (with reason) → the customer gets the rejected email
 *   carrying that reason.
 * - Delivery is the existing outbox + cron drain
 *   (`processTransactionalOutboxBatch`): the email event is a drain
 *   intent (`email.notification.dispatch`), rendered from its payload
 *   and sent through an injected `emailDeliver` (tests) or the
 *   default SMTP deliverer (production cron).
 * - No email is sent for any other payment state (claim/submitted,
 *   webhook-only events), to the wrong customer, or to a `*`
 *   webhook endpoint; a customer with no email gets no event; a
 *   failed send retries and can recover; a malformed payload
 *   dead-letters instead of ever recording "delivered".
 *
 * In-memory store only; no DATABASE_URL needed. No real SMTP call —
 * every send goes through a capture stub.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SUPER_ACTOR,
  seedCustomer,
  seedInvoice,
  seedOrder,
  seedPaymentMethod,
  seedProduct,
} from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  approvePaymentSubmissionByStaff,
  createInstallmentsForOrderInTx,
  rejectPaymentSubmissionByStaff,
  submitManualPaymentClaim,
} from "../src/modules/payments/service.ts";
import { processTransactionalOutboxBatch } from "../src/modules/webhooks/service.ts";
import { encryptSecretAtRest } from "../src/platform/crypto/index.ts";
import {
  buildPaymentApprovedEmail,
  buildPaymentRejectedEmail,
  EMAIL_NOTIFICATION_EVENT_TYPE,
  type NotificationEmail,
} from "../src/modules/notifications/service.ts";

const TEST_KEY = "test-notifications-key";
const APPROVE_CONFIG = { licenseVerifierSecret: "test-verifier-secret", requestId: "test:approve" };
const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function emailOutboxEvents(store: StackMateDataStore) {
  return store.state.outbox_events.filter(
    (e) => e.event_type === EMAIL_NOTIFICATION_EVENT_TYPE
  );
}

describe("notifications v1 — payment approved / rejected emails", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
    (store.state as unknown as { payment_refunds: unknown[] }).payment_refunds = [];
  });

  async function seedOrderWithCustomer(
    customerOverrides: Record<string, unknown> = {},
    totalMinor = 100_000
  ) {
    let orderId = "";
    let methodId = "";
    let customerId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, {
        name: "Notify Customer",
        email: "customer@example.com",
        normalized_email: "customer@example.com",
        ...customerOverrides,
      });
      const order = seedOrder(state, customer.id, product, {
        total_minor: totalMinor,
        subtotal_minor: totalMinor,
      });
      const method = seedPaymentMethod(state);
      seedInvoice(state, order, customer.id);
      createInstallmentsForOrderInTx(
        state,
        order,
        { kind: "full", due_date: "2026-12-01" },
        new Date("2026-11-17T00:00:00.000Z")
      );
      orderId = order.id;
      methodId = method.id;
      customerId = customer.id;
    });
    const order = store.state.orders.find((o) => o.id === orderId)!;
    return { order, methodId, customerId };
  }

  async function claim(orderPublicReference: string, methodId: string, keySuffix: string) {
    return submitManualPaymentClaim(store, {
      orderPublicReference,
      idempotencyKey: `test:notify-${keySuffix}`,
      rawBody: {
        payment_method_id: methodId,
        amount_minor: 100_000,
        currency_code: "BDT",
        transfer_rail: "npsb",
      },
      requestId: "test:claim",
    });
  }

  /** Capture-stub deliverer: records every message, reports sent. */
  function captureDeliver(sent: NotificationEmail[]) {
    return async (message: NotificationEmail) => {
      sent.push(message);
      return { sent: true };
    };
  }

  async function drainWith(
    sent: NotificationEmail[],
    extra: Record<string, unknown> = {}
  ) {
    return processTransactionalOutboxBatch(store, {
      workerId: "test-notifications",
      encryptionKey: TEST_KEY,
      emailDeliver: captureDeliver(sent),
      ...extra,
    });
  }

  it("approve → one approved email event for the right customer; webhook event untouched", async () => {
    // A second, uninvolved customer must never receive anything.
    await store.withTransaction((state) => {
      seedCustomer(state, { name: "Other Customer", email: "other@example.com" });
    });
    const { order, methodId } = await seedOrderWithCustomer();
    const { payment_submission } = await claim(order.public_reference, methodId, "approve-1");
    await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      payment_submission.id,
      {
        verified_amount_minor: 100_000,
        currency_code: "BDT",
        verification_reference: "TXN-NOTIFY-1",
      },
      APPROVE_CONFIG
    );

    const emailEvents = emailOutboxEvents(store);
    assert.equal(emailEvents.length, 1);
    const event = emailEvents[0]!;
    assert.equal(event.aggregate_id, payment_submission.id);
    assert.equal(event.status, "pending");
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.template, "payment_approved");
    assert.equal(payload.to, "customer@example.com");
    assert.equal(payload.customer_name, "Notify Customer");
    assert.equal(payload.order_reference, order.public_reference);
    assert.equal(payload.amount_minor, 100_000);
    assert.equal(payload.currency_code, "BDT");
    assert.equal(payload.payment_status, "paid");
    // The pre-existing webhook event is still enqueued exactly as before.
    assert.ok(
      store.state.outbox_events.some(
        (e) => e.event_type === "payment.approved" && e.aggregate_id === payment_submission.id
      )
    );

    const sent: NotificationEmail[] = [];
    const result = await drainWith(sent);
    assert.equal(result.delivered, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "customer@example.com");
    assert.match(sent[0]!.subject, /Payment approved/);
    assert.match(sent[0]!.subject, new RegExp(order.public_reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(sent[0]!.text, /Notify Customer/);
    assert.match(sent[0]!.text, /৳1,000\.00/);
    assert.match(sent[0]!.text, new RegExp(order.public_reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(event.status, "delivered");
    assert.ok(event.processed_at);
    assert.ok(
      store.state.audit_logs.some((l) => l.action === "notifications.email.delivered")
    );
  });

  it("partial approval → approved email says the balance is still due", async () => {
    const { order, methodId } = await seedOrderWithCustomer();
    const { payment_submission } = await claim(order.public_reference, methodId, "approve-2");
    await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      payment_submission.id,
      {
        verified_amount_minor: 40_000,
        currency_code: "BDT",
        verification_reference: "TXN-NOTIFY-2",
      },
      APPROVE_CONFIG
    );
    const payload = emailOutboxEvents(store)[0]!.payload as Record<string, unknown>;
    assert.equal(payload.payment_status, "partially_paid");
    assert.equal(payload.amount_minor, 40_000);

    const sent: NotificationEmail[] = [];
    await drainWith(sent);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /partial payment/);
    assert.match(sent[0]!.text, /remaining balance.*still due/);
    assert.match(sent[0]!.text, /৳400\.00/);
  });

  it("reject → one rejected email carrying the staff-written reason", async () => {
    const { order, methodId } = await seedOrderWithCustomer();
    const { payment_submission } = await claim(order.public_reference, methodId, "reject-1");
    await rejectPaymentSubmissionByStaff(store, SUPER_ACTOR, payment_submission.id, {
      reason_code: "INSUFFICIENT_PROOF",
      customer_message: "The receipt image was unreadable — please resend a clear photo.",
      internal_note: "Blurry screenshot.",
    }, "test:reject");

    const emailEvents = emailOutboxEvents(store);
    assert.equal(emailEvents.length, 1);
    const payload = emailEvents[0]!.payload as Record<string, unknown>;
    assert.equal(payload.template, "payment_rejected");
    assert.equal(payload.to, "customer@example.com");
    assert.equal(payload.reason_code, "INSUFFICIENT_PROOF");
    assert.equal(
      payload.customer_message,
      "The receipt image was unreadable — please resend a clear photo."
    );
    // The pre-existing webhook event is still enqueued exactly as before.
    assert.ok(
      store.state.outbox_events.some(
        (e) => e.event_type === "payment.rejected" && e.aggregate_id === payment_submission.id
      )
    );

    const sent: NotificationEmail[] = [];
    const result = await drainWith(sent);
    assert.equal(result.delivered, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "customer@example.com");
    assert.match(sent[0]!.subject, /not approved/);
    assert.match(sent[0]!.text, /INSUFFICIENT_PROOF/);
    assert.match(sent[0]!.text, /receipt image was unreadable/);
    assert.equal(emailEvents[0]!.status, "delivered");
  });

  it("no email for other payment states: a mere claim enqueues nothing", async () => {
    const { order, methodId } = await seedOrderWithCustomer();
    await claim(order.public_reference, methodId, "claim-only");
    assert.equal(emailOutboxEvents(store).length, 0);
    // And the drain sends nothing for the claim's webhook event.
    const sent: NotificationEmail[] = [];
    const result = await drainWith(sent);
    assert.equal(sent.length, 0);
    assert.equal(result.delivered, 0);
  });

  it("customer with no email → approve/reject enqueue no email event", async () => {
    const noEmail = { email: null, normalized_email: null };
    const first = await seedOrderWithCustomer(noEmail);
    const firstClaim = await claim(first.order.public_reference, first.methodId, "no-email-1");
    await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      firstClaim.payment_submission.id,
      {
        verified_amount_minor: 100_000,
        currency_code: "BDT",
        verification_reference: "TXN-NOTIFY-3",
      },
      APPROVE_CONFIG
    );
    assert.equal(emailOutboxEvents(store).length, 0);

    // A second order for the same no-email customer: rejection also enqueues nothing.
    const second = await seedOrderWithCustomer(noEmail);
    const secondClaim = await claim(second.order.public_reference, second.methodId, "no-email-2");
    await rejectPaymentSubmissionByStaff(store, SUPER_ACTOR, secondClaim.payment_submission.id, {
      reason_code: "WRONG_AMOUNT",
      customer_message: "The amount does not match the order total.",
    }, "test:reject-no-email");
    assert.equal(emailOutboxEvents(store).length, 0);
  });

  it("email event is NOT fanned out to *-subscribed webhook endpoints", async () => {
    const transportCalls: unknown[] = [];
    const { order, methodId } = await seedOrderWithCustomer();
    const { payment_submission } = await claim(order.public_reference, methodId, "star-1");
    await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      payment_submission.id,
      {
        verified_amount_minor: 100_000,
        currency_code: "BDT",
        verification_reference: "TXN-NOTIFY-4",
      },
      APPROVE_CONFIG
    );
    // A *-subscribed endpoint would receive every webhook event —
    // the email event must never reach it (and the drain must not
    // even call the transport for it). Seeded directly: the
    // registration schema requires subscribed event names of length
    // >= 3, so "*" cannot go through registerWebhookEndpointByAdmin
    // (pre-existing quirk), but the drain itself honours "*".
    const endpointId = randomUUID();
    store.state.webhook_endpoints.push({
      id: endpointId,
      integrated_site_id: null,
      url: "https://example.com/hook",
      description: "catch-all",
      subscribed_events: ["*"],
      status: "active",
      secret_key_id: "whsec_key_test",
      secret_ciphertext: encryptSecretAtRest(
        "test-webhook-secret",
        TEST_KEY,
        "v1",
        `webhook_endpoints:${endpointId}`
      ),
      key_version: "v1",
      created_at: NOW,
    });
    const sent: NotificationEmail[] = [];
    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-notifications-star",
      encryptionKey: TEST_KEY,
      emailDeliver: captureDeliver(sent),
      transport: async (req) => {
        transportCalls.push(req);
        return { status: 200 };
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "customer@example.com");
    // Three webhook events go to the transport (payment.submitted,
    // service.fulfillment_requested, payment.approved) — the email
    // event does not: no transport body carries its type.
    assert.equal(transportCalls.length, 3);
    for (const call of transportCalls) {
      assert.doesNotMatch(
        String((call as { body: string }).body),
        /email\.notification\.dispatch/
      );
    }
    assert.match(
      JSON.stringify(transportCalls.map((c) => (c as { body: string }).body)),
      /payment\.approved/
    );
    assert.equal(result.delivered, 4);
  });

  it("no deliverer on an in-memory store → simulated, never delivered", async () => {
    const { order, methodId } = await seedOrderWithCustomer();
    const { payment_submission } = await claim(order.public_reference, methodId, "sim-1");
    await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      payment_submission.id,
      {
        verified_amount_minor: 100_000,
        currency_code: "BDT",
        verification_reference: "TXN-NOTIFY-5",
      },
      APPROVE_CONFIG
    );
    // No emailDeliver injected and no drizzle DB → honest simulated.
    // (The three webhook events — payment.submitted,
    // service.fulfillment_requested, payment.approved — have no
    // subscribers, so they are "skipped", not simulated.)
    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-notifications-sim",
      encryptionKey: TEST_KEY,
    });
    assert.equal(result.simulated, 1);
    assert.equal(result.skipped, 3);
    assert.equal(result.delivered, 0);
    const event = emailOutboxEvents(store)[0]!;
    assert.equal(event.status, "simulated");
    assert.ok(
      store.state.audit_logs.some((l) => l.action === "notifications.email.simulated")
    );
  });

  it("failed send → retrying, then delivered on the next drain", async () => {
    const { order, methodId } = await seedOrderWithCustomer();
    const { payment_submission } = await claim(order.public_reference, methodId, "retry-1");
    await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      payment_submission.id,
      {
        verified_amount_minor: 100_000,
        currency_code: "BDT",
        verification_reference: "TXN-NOTIFY-6",
      },
      APPROVE_CONFIG
    );
    let attempts = 0;
    const flaky = async (message: NotificationEmail) => {
      attempts += 1;
      if (attempts === 1) return { sent: false, error: "SMTP connection refused" };
      return { sent: true };
    };
    const first = await processTransactionalOutboxBatch(store, {
      workerId: "test-notifications-retry",
      encryptionKey: TEST_KEY,
      emailDeliver: flaky,
    });
    assert.equal(first.retrying, 1);
    assert.equal(first.delivered, 0);
    const event = emailOutboxEvents(store)[0]!;
    assert.equal(event.status, "pending");
    assert.match(event.last_error_code ?? "", /SMTP connection refused/);
    assert.equal(attempts, 1);

    // Back off into the past so the next drain can claim it again.
    event.available_at = PAST;
    const sent: NotificationEmail[] = [];
    const second = await processTransactionalOutboxBatch(store, {
      workerId: "test-notifications-retry",
      encryptionKey: TEST_KEY,
      emailDeliver: async (message: NotificationEmail) => {
        sent.push(message);
        return { sent: true };
      },
    });
    assert.equal(second.delivered, 1);
    assert.equal(sent.length, 1);
    assert.equal(event.status, "delivered");
    assert.equal(attempts, 1);
  });

  it("malformed payload → dead-letter after maxAttempts, never delivered", async () => {
    store.state.outbox_events.push({
      id: randomUUID(),
      event_key: `email.notification.payment_approved:${randomUUID()}`,
      aggregate_type: "payment_submission",
      aggregate_id: randomUUID(),
      event_type: EMAIL_NOTIFICATION_EVENT_TYPE,
      payload: { template: "payment_approved", to: "not-an-email" },
      status: "pending",
      attempt_count: 0,
      available_at: PAST,
      locked_until: null,
      locked_by: null,
      last_error_code: null,
      created_at: NOW,
      processed_at: null,
    });
    const sent: NotificationEmail[] = [];
    const result = await processTransactionalOutboxBatch(store, {
      workerId: "test-notifications-poison",
      encryptionKey: TEST_KEY,
      emailDeliver: captureDeliver(sent),
      maxAttempts: 1,
    });
    assert.equal(result.dead_lettered, 1);
    assert.equal(sent.length, 0);
    const event = emailOutboxEvents(store)[0]!;
    assert.equal(event.status, "dead_letter");
    assert.match(event.last_error_code ?? "", /INVALID_NOTIFICATION_PAYLOAD/);
  });

  it("templates: approved html escapes customer input; rejected keeps the reason", () => {
    const approved = buildPaymentApprovedEmail({
      template: "payment_approved",
      to: "a@example.com",
      customer_name: "<script>alert(1)</script>",
      order_reference: "ORD-T-1",
      amount_minor: 50000,
      currency_code: "BDT",
      payment_status: "paid",
    });
    assert.match(approved.text, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(approved.html, /<script>alert\(1\)<\/script>/);
    assert.match(approved.html, /&lt;script&gt;/);

    const rejected = buildPaymentRejectedEmail({
      template: "payment_rejected",
      to: "a@example.com",
      customer_name: "A",
      order_reference: "ORD-T-1",
      reason_code: "WRONG_AMOUNT",
      customer_message: "Amount mismatch.",
    });
    assert.match(rejected.text, /WRONG_AMOUNT/);
    assert.match(rejected.text, /Amount mismatch\./);
  });
});
