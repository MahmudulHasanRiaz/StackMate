/**
 * Payment plans + partial payments + credit (ADR-0009 §3 + scope addition).
 *
 * Rules under test:
 *  - Plan builders: full (1 installment), advance+rest (amount or %),
 *    equal installments (floor parts, remainder to the last).
 *  - A claim/approval of ANY positive amount is accepted; the old
 *    full-amount 422 (PAYMENT_AMOUNT_MISMATCH) is gone for amounts —
 *    it survives only for currency mismatch.
 *  - Allocation is oldest-unpaid-installment first unless an
 *    installment is named in the claim.
 *  - Partial approval → order partially_paid, installment
 *    partially_paid, invoice partially_paid with paid/due kept in sync.
 *  - Overpayment: the excess becomes the customer's credit balance.
 *  - Credit can be applied at approval (explicit apply_credit_minor,
 *    capped at credit and at remaining); over-applying 422s.
 *  - Financials: billed / paid (money) / due / credit.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_payplans`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  setupTestDb,
  seedCustomer,
  seedProduct,
  seedPaymentMethod,
  seedOrder,
  seedInvoice,
} from "./customer-order-helpers.ts";
import type { AppError } from "../src/shared/errors.ts";

const DB_NAME = "stackmate_test_payplans";
const APPROVE_CONFIG = { licenseVerifierSecret: "test-verifier-secret", requestId: "test:approve" };

describe.skipIf(!DATABASE_URL)("payments — plans, partials, credit", () => {
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

  it("plan builders: full / advance+rest / equal installments", async () => {
    const { createInstallmentsForOrderInTx } = await import("../src/modules/payments/service.ts");
    let fullId = "";
    let advId = "";
    let eqId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const c1 = seedCustomer(state, { name: "Plan Full" });
      const c2 = seedCustomer(state, { name: "Plan Adv" });
      const c3 = seedCustomer(state, { name: "Plan Eq" });
      const o1 = seedOrder(state, c1.id, product, { total_minor: 100000, subtotal_minor: 100000 });
      const o2 = seedOrder(state, c2.id, product, { total_minor: 100000, subtotal_minor: 100000 });
      const o3 = seedOrder(state, c3.id, product, { total_minor: 100000, subtotal_minor: 100000 });
      fullId = o1.id;
      advId = o2.id;
      eqId = o3.id;
      const full = createInstallmentsForOrderInTx(state, o1, { kind: "full", due_date: "2026-12-01" }, new Date("2026-11-17T00:00:00.000Z"));
      assert.equal(full.length, 1);
      assert.equal(full[0]?.amount_minor, 100000);
      assert.equal(full[0]?.due_date, "2026-12-01");
      const adv = createInstallmentsForOrderInTx(state, o2, { kind: "advance_rest", advance_percent: 30, start_date: "2026-11-20", rest_due_date: "2026-12-20" }, new Date("2026-11-17T00:00:00.000Z"));
      assert.deepEqual(adv.map((i) => i.amount_minor), [30000, 70000]);
      assert.deepEqual(adv.map((i) => i.due_date), ["2026-11-20", "2026-12-20"]);
      const eq = createInstallmentsForOrderInTx(state, o3, { kind: "equal_installments", installment_count: 3, interval_days: 30, start_date: "2026-11-17" }, new Date("2026-11-17T00:00:00.000Z"));
      assert.deepEqual(eq.map((i) => i.amount_minor), [33333, 33333, 33334]);
      assert.deepEqual(eq.map((i) => i.due_date), ["2026-11-17", "2026-12-17", "2027-01-16"]);
    });
    // Rows persisted through the store.
    assert.equal(store.state.order_installments.filter((i) => i.order_id === fullId).length, 1);
    assert.equal(store.state.order_installments.filter((i) => i.order_id === advId).length, 2);
    assert.equal(store.state.order_installments.filter((i) => i.order_id === eqId).length, 3);
  });

  it("partial claim + approve: oldest-first allocation, partially_paid everywhere", async () => {
    const {
      createInstallmentsForOrderInTx,
      recordManualPaymentClaimByAdmin,
      approvePaymentSubmissionByStaff,
    } = await import("../src/modules/payments/service.ts");
    const { computeOrderPaid, computeOrderRemaining, computeCustomerFinancials } = await import(
      "../src/modules/customers/service.ts"
    );
    let orderId = "";
    let customerId = "";
    let methodId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Partial Payer", email: "partial@example.com", normalized_email: "partial@example.com" });
      customerId = customer.id;
      const method = seedPaymentMethod(state);
      methodId = method.id;
      const order = seedOrder(state, customer.id, product, { total_minor: 100000, subtotal_minor: 100000 });
      orderId = order.id;
      seedInvoice(state, order, customer.id);
      createInstallmentsForOrderInTx(state, order, { kind: "equal_installments", installment_count: 2, interval_days: 30, start_date: "2026-11-17" }, new Date("2026-11-17T00:00:00.000Z"));
    });

    const claim = await recordManualPaymentClaimByAdmin(
      store,
      SUPER_ACTOR,
      orderId,
      { payment_method_id: methodId, amount_minor: 30000, currency_code: "BDT", sender_name: "Partial Payer", transfer_rail: "npsb" },
      "test:claim-partial-1",
    );
    assert.equal(claim.payment_submission.amount_minor, 30000);

    const approved = await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      claim.payment_submission.id,
      { verified_amount_minor: 30000, verification_reference: "TXN-1" },
      APPROVE_CONFIG,
    );
    assert.equal(approved.payment_status, "partially_paid");
    assert.equal(approved.order_status, "awaiting_payment"); // not completed until fully paid
    const installments = store.state.order_installments.filter((i) => i.order_id === orderId);
    assert.equal(installments[0]?.status, "partially_paid");
    assert.equal(installments[0]?.paid_amount_minor, 30000);
    assert.equal(installments[1]?.status, "pending");
    const invoice = store.state.invoices.find((i) => i.order_id === orderId);
    assert.equal(invoice?.status, "partially_paid");
    assert.equal(invoice?.amount_paid_minor, 30000);
    assert.equal(invoice?.amount_due_minor, 70000);
    assert.equal(computeOrderPaid(store.state, orderId), 30000);
    assert.equal(computeOrderRemaining(store.state, store.state.orders.find((o) => o.id === orderId)!), 70000);
    const fin = computeCustomerFinancials(store.state, customerId);
    assert.deepEqual(fin, {
      total_billed_minor: 100000,
      total_paid_minor: 30000,
      total_due_minor: 70000,
      credit_balance_minor: 0,
    });
  });

  it("named installment in the claim allocates to that installment first", async () => {
    const {
      createInstallmentsForOrderInTx,
      recordManualPaymentClaimByAdmin,
      approvePaymentSubmissionByStaff,
    } = await import("../src/modules/payments/service.ts");
    let orderId = "";
    let methodId = "";
    let secondInstallmentId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Named Payer" });
      const method = seedPaymentMethod(state);
      methodId = method.id;
      const order = seedOrder(state, customer.id, product, { total_minor: 90000, subtotal_minor: 90000 });
      orderId = order.id;
      const parts = createInstallmentsForOrderInTx(state, order, { kind: "equal_installments", installment_count: 3, interval_days: 30, start_date: "2026-11-17" }, new Date("2026-11-17T00:00:00.000Z"));
      secondInstallmentId = parts[1]!.id;
    });
    const claim = await recordManualPaymentClaimByAdmin(
      store,
      SUPER_ACTOR,
      orderId,
      { payment_method_id: methodId, amount_minor: 10000, currency_code: "BDT", installment_id: secondInstallmentId, transfer_rail: "npsb" },
      "test:claim-named-1",
    );
    await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      claim.payment_submission.id,
      { verified_amount_minor: 10000, verification_reference: "TXN-2" },
      APPROVE_CONFIG,
    );
    const parts = store.state.order_installments.filter((i) => i.order_id === orderId);
    assert.equal(parts[0]?.paid_amount_minor, 0);
    assert.equal(parts[1]?.paid_amount_minor, 10000);
    assert.equal(parts[1]?.status, "partially_paid");
  });

  it("overpayment routes the excess to the customer credit balance", async () => {
    const {
      createInstallmentsForOrderInTx,
      recordManualPaymentClaimByAdmin,
      approvePaymentSubmissionByStaff,
    } = await import("../src/modules/payments/service.ts");
    const { computeCustomerFinancials } = await import("../src/modules/customers/service.ts");
    let orderId = "";
    let customerId = "";
    let methodId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Over Payer", email: "over@example.com", normalized_email: "over@example.com" });
      customerId = customer.id;
      const method = seedPaymentMethod(state);
      methodId = method.id;
      const order = seedOrder(state, customer.id, product, { total_minor: 100000, subtotal_minor: 100000 });
      orderId = order.id;
      seedInvoice(state, order, customer.id);
      createInstallmentsForOrderInTx(state, order, { kind: "full" }, new Date("2026-11-17T00:00:00.000Z"));
    });
    const claim = await recordManualPaymentClaimByAdmin(
      store,
      SUPER_ACTOR,
      orderId,
      { payment_method_id: methodId, amount_minor: 120000, currency_code: "BDT", transfer_rail: "npsb" },
      "test:claim-over-1",
    );
    const approved = await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      claim.payment_submission.id,
      { verified_amount_minor: 120000, verification_reference: "TXN-3" },
      APPROVE_CONFIG,
    );
    assert.equal(approved.payment_status, "paid");
    assert.equal(approved.order_status, "completed");
    const customer = store.state.customers.find((c) => c.id === customerId)!;
    assert.equal(customer.credit_balance_minor, 20000);
    const fin = computeCustomerFinancials(store.state, customerId);
    assert.equal(fin.total_billed_minor, 100000);
    assert.equal(fin.total_paid_minor, 120000); // money actually received
    assert.equal(fin.total_due_minor, 0);
    assert.equal(fin.credit_balance_minor, 20000);
  });

  it("credit applies explicitly at approval; over-applying 422s", async () => {
    const {
      createInstallmentsForOrderInTx,
      recordManualPaymentClaimByAdmin,
      approvePaymentSubmissionByStaff,
    } = await import("../src/modules/payments/service.ts");
    let orderId = "";
    let customerId = "";
    let methodId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      // Customer already holds 20000 credit (as if from an earlier overpayment).
      const customer = seedCustomer(state, { name: "Credit User", credit_balance_minor: 20000 });
      customerId = customer.id;
      const method = seedPaymentMethod(state);
      methodId = method.id;
      const order = seedOrder(state, customer.id, product, { total_minor: 50000, subtotal_minor: 50000 });
      orderId = order.id;
      createInstallmentsForOrderInTx(state, order, { kind: "full" }, new Date("2026-11-17T00:00:00.000Z"));
    });
    // Over-apply first: 99999 > credit 20000 → 422.
    const claim = await recordManualPaymentClaimByAdmin(
      store,
      SUPER_ACTOR,
      orderId,
      { payment_method_id: methodId, amount_minor: 30000, currency_code: "BDT", transfer_rail: "npsb" },
      "test:claim-credit-1",
    );
    await assert.rejects(
      () =>
        approvePaymentSubmissionByStaff(
          store,
          SUPER_ACTOR,
          claim.payment_submission.id,
          { verified_amount_minor: 30000, verification_reference: "TXN-4", apply_credit_minor: 99999 },
          APPROVE_CONFIG,
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "CREDIT_EXCEEDS_BALANCE");
        return true;
      },
    );
    // Exact apply: 30000 money + 20000 credit = 50000 → paid, credit 0.
    const approved = await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      claim.payment_submission.id,
      { verified_amount_minor: 30000, verification_reference: "TXN-4", apply_credit_minor: 20000 },
      APPROVE_CONFIG,
    );
    assert.equal(approved.payment_status, "paid");
    assert.equal(store.state.customers.find((c) => c.id === customerId)?.credit_balance_minor, 0);
  });

  it("claim validation: zero amount and currency mismatch still 422", async () => {
    const { recordManualPaymentClaimByAdmin } = await import("../src/modules/payments/service.ts");
    let orderId = "";
    let methodId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Invalid Claimer" });
      const method = seedPaymentMethod(state);
      methodId = method.id;
      const order = seedOrder(state, customer.id, product, { total_minor: 100000, subtotal_minor: 100000 });
      orderId = order.id;
    });
    // Zero amount is a schema-level rejection (ValiError — the 422
    // mapping happens at the route layer).
    await assert.rejects(() =>
      recordManualPaymentClaimByAdmin(
        store,
        SUPER_ACTOR,
        orderId,
        { payment_method_id: methodId, amount_minor: 0, currency_code: "BDT" },
        "test:claim-zero",
      ),
    );
    await assert.rejects(
      () =>
        recordManualPaymentClaimByAdmin(
          store,
          SUPER_ACTOR,
          orderId,
          { payment_method_id: methodId, amount_minor: 1000, currency_code: "USD" },
          "test:claim-currency",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "PAYMENT_AMOUNT_MISMATCH");
        return true;
      },
    );
  });
});
