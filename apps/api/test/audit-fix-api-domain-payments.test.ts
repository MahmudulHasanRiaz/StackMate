/**
 * API-domain audit fixes — payments (F-01, F-03, H-1, L-10, M-14a).
 *
 *  - F-01: a transaction reference approved twice must 409
 *    (DUPLICATE_TRANSACTION_REFERENCE) — no second transaction, no
 *    phantom credit. The guard normalizes case/whitespace.
 *  - F-03: manual refunds — partial/full, credit draw, over-refund
 *    422, balances + invoices recomputed, audit + outbox rows.
 *  - H-1: evidence upload asserts `payments.approve` for staff and
 *    audits the upload; the public (actor null) path audits as the
 *    integration.
 *  - L-10: the upload response is a minimal DTO — no R2 object key
 *    or bucket name.
 *  - M-14a: a public manual-payment claim writes an audit row.
 *
 * In-memory (no Postgres): seeds run against StackMateDataStore
 * state via the shared seed helpers. NOTE: `payment_refunds` is not
 * wired in store.ts yet (F-03 remainder for the core agent) — the
 * refund tests inject the collection, exactly as the service's
 * fail-closed `refundState` accessor documents.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
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
  recordManualRefundByAdmin,
  submitManualPaymentClaim,
  uploadPrivatePaymentEvidence,
} from "../src/modules/payments/service.ts";
import { InMemoryR2Bucket } from "../src/platform/storage/r2.ts";
import { R2StorageDriver } from "../src/platform/storage/driver.ts";
import type { AppError } from "../src/shared/errors.ts";

const APPROVE_CONFIG = { licenseVerifierSecret: "test-verifier-secret", requestId: "test:approve" };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

const NO_PERMISSION_ACTOR = {
  ...SUPER_ACTOR,
  roles: ["support"] as string[],
  permissions: [] as string[],
};

describe("payments — audit fixes (F-01, F-03, H-1, L-10, M-14a)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
    // F-03 remainder: the collection is not wired in store.ts yet.
    (store.state as unknown as { payment_refunds: unknown[] }).payment_refunds = [];
  });

  async function seedOrderWithPlan(totalMinor = 100_000) {
    let orderId = "";
    let methodId = "";
    let customerId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Pay Test" });
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
        new Date("2026-11-17T00:00:00.000Z"),
      );
      orderId = order.id;
      methodId = method.id;
      customerId = customer.id;
    });
    const order = store.state.orders.find((o) => o.id === orderId)!;
    return { order, methodId, customerId };
  }

  async function claimAndApprove(
    orderPublicReference: string,
    methodId: string,
    amountMinor: number,
    verificationReference: string,
    keySuffix: string,
  ) {
    const claim = await submitManualPaymentClaim(store, {
      orderPublicReference,
      idempotencyKey: `test:pay-${keySuffix}`,
      rawBody: {
        payment_method_id: methodId,
        amount_minor: amountMinor,
        currency_code: "BDT",
        transfer_rail: "npsb",
      },
      requestId: "test:claim",
    });
    const approved = await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      claim.payment_submission.id,
      {
        verified_amount_minor: amountMinor,
        currency_code: "BDT",
        verification_reference: verificationReference,
      },
      APPROVE_CONFIG,
    );
    return { claim, approved };
  }

  it("F-01: approving the same reference twice 409s — no second transaction, no phantom credit", async () => {
    const { order, methodId, customerId } = await seedOrderWithPlan();
    const first = await claimAndApprove(order.public_reference, methodId, 50_000, "TXN-AAA", "f01-1");
    assert.equal(first.approved.transaction.provider_transaction_id, "TXN-AAA");
    assert.equal(first.approved.transaction.status, "succeeded");

    const secondClaim = await submitManualPaymentClaim(store, {
      orderPublicReference: order.public_reference,
      idempotencyKey: "test:pay-f01-2",
      rawBody: {
        payment_method_id: methodId,
        amount_minor: 50_000,
        currency_code: "BDT",
        transfer_rail: "npsb",
      },
      requestId: "test:claim",
    });
    await assert.rejects(
      () =>
        approvePaymentSubmissionByStaff(
          store,
          SUPER_ACTOR,
          secondClaim.payment_submission.id,
          {
            verified_amount_minor: 50_000,
            currency_code: "BDT",
            // Same reference, different case + surrounding whitespace.
            verification_reference: " txn-aaa ",
          },
          APPROVE_CONFIG,
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "DUPLICATE_TRANSACTION_REFERENCE");
        return true;
      },
    );
    assert.equal(store.state.payment_transactions.length, 1);
    assert.equal(store.state.customers.find((c) => c.id === customerId)?.credit_balance_minor, 0);
    assert.equal(
      store.state.payment_submissions.find((s) => s.id === secondClaim.payment_submission.id)
        ?.status,
      "submitted",
    );
  });

  it("F-03: partial then full refund — balances, invoice, audit, outbox", async () => {
    const { order, methodId } = await seedOrderWithPlan();
    const { approved } = await claimAndApprove(
      order.public_reference,
      methodId,
      100_000,
      "TXN-R1",
      "f03-1",
    );
    assert.equal(approved.order_status, "completed");
    assert.equal(approved.payment_status, "paid");

    const partial = await recordManualRefundByAdmin(
      store,
      SUPER_ACTOR,
      { order_id: order.id, amount_minor: 40_000, currency_code: "BDT", reason: "Customer asked" },
      "test:refund-1",
    );
    assert.equal(partial.refund.status, "succeeded");
    assert.equal(partial.transaction.status, "partially_refunded");
    assert.equal(partial.order.payment_status, "partially_paid");
    assert.equal(
      store.state.invoices.find((i) => i.order_id === order.id)?.status,
      "partially_paid",
    );
    assert.equal(
      store.state.audit_logs.filter((l) => l.action === "payments.refund.recorded").length,
      1,
    );
    assert.ok(
      store.state.outbox_events.some(
        (e) => e.event_type === "payment.refunded" && e.aggregate_id === approved.transaction.id,
      ),
    );

    const full = await recordManualRefundByAdmin(
      store,
      SUPER_ACTOR,
      {
        payment_transaction_id: approved.transaction.id,
        amount_minor: 60_000,
        currency_code: "BDT",
        reason: "Rest returned",
      },
      "test:refund-2",
    );
    assert.equal(full.transaction.status, "refunded");
    assert.equal(full.order.payment_status, "unpaid");
    assert.equal(
      (store.state as unknown as { payment_refunds: Array<{ id: string }> }).payment_refunds
        .length,
      2,
    );
  });

  it("F-03: refund above the remaining refundable amount 422s", async () => {
    const { order, methodId } = await seedOrderWithPlan();
    await claimAndApprove(order.public_reference, methodId, 100_000, "TXN-R2", "f03-3");
    await assert.rejects(
      () =>
        recordManualRefundByAdmin(
          store,
          SUPER_ACTOR,
          { order_id: order.id, amount_minor: 100_001, currency_code: "BDT", reason: "Too much" },
          "test:refund-3",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
    assert.equal(
      (store.state as unknown as { payment_refunds: unknown[] }).payment_refunds.length,
      0,
    );
  });

  it("F-03: refund draws order-paid first, then credit; spent credit 422s the remainder", async () => {
    const { order, methodId, customerId } = await seedOrderWithPlan();
    // Overpay by 50,000 → order paid, customer credit 50,000.
    await claimAndApprove(order.public_reference, methodId, 150_000, "TXN-R3", "f03-4");
    assert.equal(
      store.state.customers.find((c) => c.id === customerId)?.credit_balance_minor,
      50_000,
    );
    const refund = await recordManualRefundByAdmin(
      store,
      SUPER_ACTOR,
      { order_id: order.id, amount_minor: 120_000, currency_code: "BDT", reason: "Overpay back" },
      "test:refund-4",
    );
    assert.equal(refund.refund.status, "succeeded");
    assert.equal(
      store.state.customers.find((c) => c.id === customerId)?.credit_balance_minor,
      30_000,
    );
    // Remaining refundable is 30,000 (150,000 − 120,000) — 40,000 must 422.
    await assert.rejects(
      () =>
        recordManualRefundByAdmin(
          store,
          SUPER_ACTOR,
          { order_id: order.id, amount_minor: 40_000, currency_code: "BDT", reason: "Too much" },
          "test:refund-5",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
  });

  it("H-1 + L-10: staff without payments.approve cannot upload; staff upload returns a minimal DTO + audit row", async () => {
    const { order, customerId } = await seedOrderWithPlan();
    const driver = new R2StorageDriver(new InMemoryR2Bucket());
    const base = {
      orderId: order.id,
      customerId,
      filename: "receipt.png",
      contentType: "image/png",
      bytes: PNG_BYTES,
      bucketName: "test-bucket",
      driver,
      requestId: "test:evidence-1",
    };
    await assert.rejects(
      () => uploadPrivatePaymentEvidence(store, { ...base, actor: NO_PERMISSION_ACTOR }),
      (err: AppError) => {
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      },
    );
    assert.equal(store.state.uploaded_assets.length, 0);

    const dto = await uploadPrivatePaymentEvidence(store, { ...base, actor: SUPER_ACTOR });
    assert.equal("object_key" in dto, false);
    assert.equal("bucket_name" in dto, false);
    assert.equal(dto.visibility, "private");
    assert.equal(dto.original_filename, "receipt.png");
    assert.equal(dto.byte_size, PNG_BYTES.byteLength);
    const row = store.state.audit_logs.find((l) => l.action === "payments.evidence.uploaded");
    assert.ok(row);
    assert.equal(row?.actor_type, "staff");
    // The full record (with the object key) still exists server-side.
    assert.equal(store.state.uploaded_assets.length, 1);
    assert.ok(store.state.uploaded_assets[0]?.object_key.startsWith("payment-evidence/"));
  });

  it("H-1: public (actor null) upload audits as the integration", async () => {
    const { order, customerId } = await seedOrderWithPlan();
    const driver = new R2StorageDriver(new InMemoryR2Bucket());
    await uploadPrivatePaymentEvidence(store, {
      orderId: order.id,
      customerId,
      filename: "receipt.png",
      contentType: "image/png",
      bytes: PNG_BYTES,
      bucketName: "test-bucket",
      driver,
      actor: null,
      integratedSiteId: "site-1",
      requestId: "test:evidence-2",
    });
    const row = store.state.audit_logs.find((l) => l.action === "payments.evidence.uploaded");
    assert.ok(row);
    assert.equal(row?.actor_type, "integration");
    assert.equal(row?.integrated_site_id, "site-1");
  });

  it("M-14a: a public manual-payment claim writes an audit row", async () => {
    const { order, methodId } = await seedOrderWithPlan();
    await submitManualPaymentClaim(store, {
      orderPublicReference: order.public_reference,
      idempotencyKey: "test:pay-m14a",
      rawBody: {
        payment_method_id: methodId,
        amount_minor: 10_000,
        currency_code: "BDT",
        transfer_rail: "npsb",
      },
      requestId: "test:claim-m14a",
    });
    const row = store.state.audit_logs.find((l) => l.action === "payments.submission.claimed");
    assert.ok(row);
    assert.equal(row?.actor_type, "integration");
    assert.equal(row?.request_id, "test:claim-m14a");
  });
});
