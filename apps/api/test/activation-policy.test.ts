/**
 * License activation policy (ADR-0009 §4).
 *
 * Rules under test:
 *  - activationDueNow (pure policy): on_full_payment / on_percent /
 *    on_date, including boundaries and the missing-date case.
 *  - evaluateActivationForOrderInTx: date-based activation fires the
 *    fulfillment outbox event exactly once (event-key idempotency);
 *    before the date nothing fires.
 *  - Missed-schedule suspension: with suspend_on_missed_schedule on,
 *    a past-due unpaid installment suspends the order's active license
 *    (license_event + outbox license.suspended); catching up
 *    reactivates it. With the toggle off, nothing suspends.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_activation`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  DATABASE_URL,
  setupTestDb,
  seedCustomer,
  seedProduct,
  seedOrder,
  seedLicense,
} from "./customer-order-helpers.ts";
import type { OrderRecord } from "../src/platform/db/store.ts";

const DB_NAME = "stackmate_test_activation";
const ACT_CONFIG = {
  licenseVerifierSecret: "test-verifier-secret",
  paymentTransactionId: null,
  actorUserId: null,
  requestId: "test:activation",
};

function orderLike(overrides: Partial<OrderRecord>): OrderRecord {
  return {
    id: "order-test",
    order_number: "ORD-T-X",
    public_reference: "ord_test_x",
    customer_id: "cust-test",
    source: "admin",
    integrated_site_id: null,
    status: "awaiting_payment",
    payment_status: "unpaid",
    currency_code: "BDT",
    subtotal_minor: 100000,
    discount_minor: 0,
    tax_minor: 0,
    total_minor: 100000,
    customer_note: null,
    internal_note: null,
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    cancelled_at: null,
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)("activation policy", () => {
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const setup = await setupTestDb(DB_NAME);
    store = setup.store;
    cleanup = setup.cleanup;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("activationDueNow: on_full_payment", async () => {
    const { activationDueNow } = await import("../src/modules/activation/service.ts");
    const now = new Date("2026-11-17T00:00:00.000Z");
    assert.equal(activationDueNow(orderLike({}), 0, now).due, false);
    assert.equal(activationDueNow(orderLike({}), 99999, now).due, false);
    assert.equal(activationDueNow(orderLike({}), 100000, now).due, true);
    assert.equal(activationDueNow(orderLike({}), 120000, now).due, true); // overpaid counts
  });

  it("activationDueNow: on_percent (threshold is ceil)", async () => {
    const { activationDueNow } = await import("../src/modules/activation/service.ts");
    const now = new Date("2026-11-17T00:00:00.000Z");
    const order = orderLike({ activation_mode: "on_percent", activation_percent: 50 });
    assert.equal(activationDueNow(order, 49999, now).due, false);
    assert.equal(activationDueNow(order, 50000, now).due, true);
    // 33% of 100001 → ceil(33000.33) = 33001.
    const odd = orderLike({ activation_mode: "on_percent", activation_percent: 33, total_minor: 100001 });
    assert.equal(activationDueNow(odd, 33000, now).due, false);
    assert.equal(activationDueNow(odd, 33001, now).due, true);
  });

  it("activationDueNow: on_date ignores payment; missing date never fires", async () => {
    const { activationDueNow } = await import("../src/modules/activation/service.ts");
    const order = orderLike({ activation_mode: "on_date", activation_date: "2026-12-01" });
    assert.equal(activationDueNow(order, 0, new Date("2026-11-30T00:00:00.000Z")).due, false);
    assert.equal(activationDueNow(order, 0, new Date("2026-12-01T00:00:00.000Z")).due, true);
    assert.equal(activationDueNow(order, 0, new Date("2026-12-02T00:00:00.000Z")).due, true);
    assert.equal(
      activationDueNow(orderLike({ activation_mode: "on_date", activation_date: null }), 100000, new Date("2026-12-02T00:00:00.000Z")).due,
      false,
    );
  });

  it("date-based activation queues fulfillment exactly once", async () => {
    const { evaluateActivationForOrderInTx } = await import("../src/modules/activation/service.ts");
    let orderId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Date Activation" });
      const order = seedOrder(state, customer.id, product, {
        activation_mode: "on_date",
        activation_date: "2026-12-01",
      });
      orderId = order.id;
    });
    const order = store.state.orders.find((o) => o.id === orderId)!;
    // Before the date: nothing.
    let outcome: ReturnType<typeof evaluateActivationForOrderInTx>;
    await store.withTransaction((state) => {
      outcome = evaluateActivationForOrderInTx(state, order, "2026-11-30T00:00:00.000Z", ACT_CONFIG);
    });
    assert.equal(outcome!.activated, false);
    assert.equal(store.state.outbox_events.filter((e) => e.event_type === "service.fulfillment_requested").length, 0);
    // On the date: fulfillment queued once…
    await store.withTransaction((state) => {
      outcome = evaluateActivationForOrderInTx(state, order, "2026-12-01T00:00:00.000Z", ACT_CONFIG);
    });
    assert.equal(outcome!.activated, true);
    assert.equal(store.state.outbox_events.filter((e) => e.event_type === "service.fulfillment_requested").length, 1);
    // …and a second evaluation does not queue it again.
    await store.withTransaction((state) => {
      outcome = evaluateActivationForOrderInTx(state, order, "2026-12-01T00:00:00.000Z", ACT_CONFIG);
    });
    assert.equal(store.state.outbox_events.filter((e) => e.event_type === "service.fulfillment_requested").length, 1);
  });

  it("missed-schedule suspends, catching up reactivates; toggle off suspends nothing", async () => {
    const { evaluateSuspensionForOrderInTx } = await import("../src/modules/activation/service.ts");
    const { createInstallmentsForOrderInTx } = await import("../src/modules/payments/service.ts");
    let orderId = "";
    let licenseId = "";
    let offOrderId = "";
    let offLicenseId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Suspend Me" });
      const order = seedOrder(state, customer.id, product, { suspend_on_missed_schedule: true });
      orderId = order.id;
      createInstallmentsForOrderInTx(state, order, { kind: "full", due_date: "2026-11-10" }, new Date("2026-11-17T00:00:00.000Z"));
      const license = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        source_order_item_id: order.items[0]!.id,
        status: "active",
      });
      licenseId = license.id;
      // Second order with the toggle OFF, same missed shape.
      const offOrder = seedOrder(state, customer.id, product, { suspend_on_missed_schedule: false });
      offOrderId = offOrder.id;
      createInstallmentsForOrderInTx(state, offOrder, { kind: "full", due_date: "2026-11-10" }, new Date("2026-11-17T00:00:00.000Z"));
      const offLicense = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        source_order_item_id: offOrder.items[0]!.id,
        status: "active",
      });
      offLicenseId = offLicense.id;
    });

    const now = new Date("2026-11-17T00:00:00.000Z");
    let result: ReturnType<typeof evaluateSuspensionForOrderInTx>;
    const order = store.state.orders.find((o) => o.id === orderId)!;
    await store.withTransaction((state) => {
      result = evaluateSuspensionForOrderInTx(state, order, now, { requestId: "test:suspend-1" });
    });
    assert.equal(result!.suspended.length, 1);
    assert.equal(store.state.licenses.find((l) => l.id === licenseId)?.status, "suspended");
    assert.ok(store.state.license_events.some((e) => e.license_id === licenseId && e.event_type === "suspended"));
    assert.ok(store.state.outbox_events.some((e) => e.event_type === "license.suspended"));

    // Toggle off: the other license stays active.
    const offOrder = store.state.orders.find((o) => o.id === offOrderId)!;
    await store.withTransaction((state) => {
      result = evaluateSuspensionForOrderInTx(state, offOrder, now, { requestId: "test:suspend-2" });
    });
    assert.equal(result!.suspended.length, 0);
    assert.equal(store.state.licenses.find((l) => l.id === offLicenseId)?.status, "active");

    // Catch up: pay the missed installment, re-evaluate → reactivated.
    await store.withTransaction((state) => {
      const inst = state.order_installments.find((i) => i.order_id === orderId)!;
      inst.paid_amount_minor = inst.amount_minor;
      inst.status = "paid";
      inst.paid_at = now.toISOString();
    });
    await store.withTransaction((state) => {
      result = evaluateSuspensionForOrderInTx(state, order, now, { requestId: "test:suspend-3" });
    });
    assert.equal(result!.reactivated.length, 1);
    assert.equal(store.state.licenses.find((l) => l.id === licenseId)?.status, "active");
    assert.ok(store.state.license_events.some((e) => e.license_id === licenseId && e.event_type === "reactivated"));
    assert.ok(store.state.outbox_events.some((e) => e.event_type === "license.reactivated"));
  });
});
