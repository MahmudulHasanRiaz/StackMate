/**
 * Renewal + expiry sweep (ADR-0009 §5) + reminder idempotency (§6).
 *
 * Rules under test:
 *  - Subscription inside its grace window → past_due (license keeps
 *    working); grace exhausted → expired + its licenses suspended.
 *  - License past grace_until → expired + license.expired outbox event.
 *  - Renewal detection: an active recurring subscription whose period
 *    end is within the first reminder offset gets exactly ONE renewal
 *    invoice/order, however many times the sweep runs.
 *  - Reminders are sent once per (kind, reference, offset): a second
 *    sweep at the same instant produces no duplicate.
 *  - Installments past due are marked overdue before reminders run.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_sweep`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  DATABASE_URL,
  setupTestDb,
  seedCustomer,
  seedProduct,
  seedOrder,
  seedSubscription,
  seedLicense,
} from "./customer-order-helpers.ts";
import { runRenewalExpirySweep, markSweepRemindersSent } from "../src/modules/renewal/sweep.ts";
import { createInstallmentsForOrderInTx } from "../src/modules/payments/service.ts";

const DB_NAME = "stackmate_test_sweep";
const SWEEP_OPTS = { licenseVerifierSecret: "test-verifier-secret", requestId: "test:sweep" };

describe.skipIf(!DATABASE_URL)("renewal + expiry sweep", () => {
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

  it("inside grace → past_due; grace exhausted → expired + licenses suspended", async () => {
    let subId = "";
    let licenseId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Grace Customer", email: "grace@example.com", normalized_email: "grace@example.com" });
      const order = seedOrder(state, customer.id, product, { total_minor: 100000, subtotal_minor: 100000 });
      const sub = seedSubscription(state, {
        customer_id: customer.id,
        product_id: product.id,
        source_order_item_id: order.items[0]!.id,
        grace_days: 3,
        current_period_start: "2026-10-17T00:00:00.000Z",
        current_period_end: "2026-11-15T00:00:00.000Z",
      });
      subId = sub.id;
      const license = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        subscription_id: sub.id,
        status: "active",
        expires_at: "2026-11-15T00:00:00.000Z",
        grace_until: "2026-12-01T00:00:00.000Z",
      });
      licenseId = license.id;
    });

    // Inside the grace window (ends 18/11): past_due, license untouched.
    let report = await runRenewalExpirySweep(store, { ...SWEEP_OPTS, now: new Date("2026-11-17T00:00:00.000Z") });
    assert.equal(report.subscriptions_past_due, 1);
    assert.equal(report.subscriptions_expired, 0);
    assert.deepEqual(report.errors, []);
    assert.equal(store.state.subscriptions.find((s) => s.id === subId)?.status, "past_due");
    assert.equal(store.state.licenses.find((l) => l.id === licenseId)?.status, "active");

    // Grace exhausted (after 18/11): expired + license suspended until renewal.
    report = await runRenewalExpirySweep(store, { ...SWEEP_OPTS, now: new Date("2026-11-20T00:00:00.000Z") });
    assert.equal(report.subscriptions_expired, 1);
    assert.equal(store.state.subscriptions.find((s) => s.id === subId)?.status, "expired");
    assert.equal(store.state.licenses.find((l) => l.id === licenseId)?.status, "suspended");
    assert.ok(store.state.outbox_events.some((e) => e.event_type === "license.suspended"));
    assert.ok(
      store.state.audit_logs.some(
        (a) => a.action === "subscriptions.subscription.expired" && a.resource_id === subId,
      ),
    );
  });

  it("license past grace_until expires (outbox license.expired)", async () => {
    let licenseId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Expired License" });
      const license = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        status: "active",
        expires_at: "2026-11-05T00:00:00.000Z",
        grace_until: "2026-11-10T00:00:00.000Z",
      });
      licenseId = license.id;
    });
    const report = await runRenewalExpirySweep(store, { ...SWEEP_OPTS, now: new Date("2026-11-17T00:00:00.000Z") });
    assert.equal(report.licenses_expired, 1);
    assert.equal(store.state.licenses.find((l) => l.id === licenseId)?.status, "expired");
    assert.ok(
      store.state.outbox_events.some(
        (e) => e.event_type === "license.expired" && (e.payload as { license_number?: string }).license_number !== undefined,
      ),
    );
  });

  it("renewal invoice is generated exactly once", async () => {
    let subId = "";
    let orderItemId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Renewal Customer", email: "renew@example.com", normalized_email: "renew@example.com" });
      const order = seedOrder(state, customer.id, product, { total_minor: 100000, subtotal_minor: 100000 });
      orderItemId = order.items[0]!.id;
      const sub = seedSubscription(state, {
        customer_id: customer.id,
        product_id: product.id,
        source_order_item_id: orderItemId,
        grace_days: 3,
        current_period_start: "2026-10-20T00:00:00.000Z",
        current_period_end: "2026-11-20T00:00:00.000Z",
      });
      subId = sub.id;
    });
    const now = new Date("2026-11-17T00:00:00.000Z"); // 3 days before period end, within offset 7
    const first = await runRenewalExpirySweep(store, { ...SWEEP_OPTS, now });
    assert.equal(first.renewals, 1);
    const second = await runRenewalExpirySweep(store, { ...SWEEP_OPTS, now });
    assert.equal(second.renewals, 0);
    const sub = store.state.subscriptions.find((s) => s.id === subId)!;
    assert.equal(sub.periods.filter((p) => p.status === "pending").length, 1);
    const renewalOrderId = sub.periods.find((p) => p.status === "pending")?.renewal_order_id;
    assert.ok(renewalOrderId);
    assert.equal(store.state.orders.filter((o) => o.id === renewalOrderId).length, 1);
    assert.ok(store.state.invoices.some((i) => i.order_id === renewalOrderId && i.invoice_type === "renewal"));
    assert.deepEqual(second.errors, []);
  });

  it("reminders fire once per (kind, reference, offset); overdue installments marked first", async () => {
    let dueInstallmentId = "";
    let overdueInstallmentId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Reminder Customer", email: "remind@example.com", normalized_email: "remind@example.com" });
      const order = seedOrder(state, customer.id, product, { total_minor: 100000, subtotal_minor: 100000 });
      const parts = createInstallmentsForOrderInTx(
        state,
        order,
        { kind: "equal_installments", installment_count: 2, interval_days: 7, start_date: "2026-11-17" },
        new Date("2026-11-17T00:00:00.000Z"),
      );
      // #1 due 17/11 (already past at sweep time), #2 due 24/11 (7 days out).
      dueInstallmentId = parts[1]!.id;
      overdueInstallmentId = parts[0]!.id;
    });
    const now = new Date("2026-11-17T00:00:00.000Z");
    const first = await runRenewalExpirySweep(store, { ...SWEEP_OPTS, now });
    // Due reminder for #2 (offset 7) + overdue reminder for #1 (offset 0? no —
    // overdue offsets are [1,3]; #1 is due today, not overdue yet).
    const dueReminders = first.reminders_due.filter((r) => r.kind === "installment_due");
    assert.equal(dueReminders.length, 1);
    assert.equal(dueReminders[0]?.reference_id, dueInstallmentId);
    assert.equal(dueReminders[0]?.offset_days, 7);
    assert.equal(dueReminders[0]?.to_email, "remind@example.com");
    assert.equal(first.reminders_due.filter((r) => r.kind === "installment_overdue").length, 0);

    await markSweepRemindersSent(store, first.reminders_due, now);
    assert.equal(store.state.sent_reminders.length, 1);
    const second = await runRenewalExpirySweep(store, { ...SWEEP_OPTS, now });
    assert.equal(second.reminders_due.filter((r) => r.kind === "installment_due").length, 0);

    // Next day: #1 is 1 day overdue → overdue reminder (offset 1) fires once.
    const third = await runRenewalExpirySweep(store, { ...SWEEP_OPTS, now: new Date("2026-11-18T00:00:00.000Z") });
    const overdue = third.reminders_due.filter((r) => r.kind === "installment_overdue");
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0]?.reference_id, overdueInstallmentId);
    assert.equal(overdue[0]?.offset_days, 1);
    assert.equal(store.state.order_installments.find((i) => i.id === overdueInstallmentId)?.status, "overdue");
  });
});
