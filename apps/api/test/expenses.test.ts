/**
 * Expense module — API worker tests (in-memory, no Postgres).
 *
 * Covers: category + expense CRUD happy path, validation errors
 * (bad amount / bad date / missing category / unknown FKs), the
 * category delete-guard (409 while expenses reference it), server-side
 * search + filters, P&L math (sales − expenses, product scoping, date
 * ranges, empty range, refund netting), and RBAC 403s.
 *
 * Sales are seeded through the real claim → approve flow, so the P&L
 * "verified revenue" base is exercised against genuine completed
 * orders (completed_at = now), not hand-built rows.
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
} from "../src/modules/payments/service.ts";
import {
  createExpense,
  createExpenseCategory,
  deleteExpense,
  deleteExpenseCategory,
  getExpense,
  getExpenseCategory,
  listExpenseCategories,
  listExpenses,
  updateExpense,
  updateExpenseCategory,
} from "../src/modules/expenses/service.ts";
import { computeProfitLoss } from "../src/modules/analytics/pnl.ts";
import { parseOverviewRange } from "../src/modules/analytics/overview-range.ts";
import { assertStaffPermission } from "../src/modules/identity/service.ts";
import { SchemaValidationError } from "../../../packages/contracts/src/index.ts";
import type { AppError } from "../src/shared/errors.ts";

const APPROVE_CONFIG = {
  licenseVerifierSecret: "test-verifier-secret",
  requestId: "test:approve",
};
const TIME_ZONE = "Asia/Dhaka";

const NO_PERMISSION_ACTOR = {
  ...SUPER_ACTOR,
  roles: ["support"] as string[],
  permissions: [] as string[],
};

function isAppErrorWith(
  code: string,
  status: number,
): (err: unknown) => boolean {
  return (err: unknown) =>
    (err as AppError).code === code && (err as AppError).statusCode === status;
}

/** YYYY-MM-DD, `days` offset from today (UTC). */
function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Wide range covering "now" in both UTC and Dhaka (midnight spill). */
function currentRange(): { from: string; to: string } {
  return { from: dayOffset(-40), to: dayOffset(1) };
}

describe("expenses — categories + expenses CRUD", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  async function seedCategory(name = "Software", overrides: Record<string, unknown> = {}) {
    return createExpenseCategory(store, SUPER_ACTOR, { name, ...overrides }, "test:cat");
  }

  async function seedExpense(
    categoryId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return createExpense(
      store,
      SUPER_ACTOR,
      {
        amountMinor: 10_000,
        expenseDate: dayOffset(0),
        categoryId,
        ...overrides,
      },
      "test:exp",
    );
  }

  it("creates, reads, updates and lists categories (with expenseCount)", async () => {
    const cat = await seedCategory("Software", {
      description: "SaaS + tools",
      color: "#00E599",
      icon: "code",
    });
    assert.equal(cat.name, "Software");
    assert.equal(cat.color, "#00E599");
    assert.equal(cat.is_active, true);

    const fetched = await getExpenseCategory(store, SUPER_ACTOR, cat.id);
    assert.equal(fetched.expenseCount, 0);

    await seedExpense(cat.id, { amountMinor: 5_000 });
    await seedExpense(cat.id, { amountMinor: 7_000 });
    assert.equal((await getExpenseCategory(store, SUPER_ACTOR, cat.id)).expenseCount, 2);

    const updated = await updateExpenseCategory(store, SUPER_ACTOR, cat.id, {
      name: "Software & Tools",
      is_active: false,
    }, "test:cat-upd");
    assert.equal(updated.name, "Software & Tools");
    assert.equal(updated.is_active, false);

    const inactive = await listExpenseCategories(store, SUPER_ACTOR, { isActive: false });
    assert.equal(inactive.length, 1);
    const searched = await listExpenseCategories(store, SUPER_ACTOR, { q: "softWARE" });
    assert.equal(searched.length, 1);
    assert.equal(searched[0]!.expenseCount, 2);
  });

  it("rejects a duplicate category name (case-insensitive) with 409", async () => {
    await seedCategory("Software");
    await assert.rejects(
      seedCategory("  software  "),
      isAppErrorWith("CONFLICT", 409),
    );
    const other = await seedCategory("Marketing");
    await assert.rejects(
      updateExpenseCategory(store, SUPER_ACTOR, other.id, { name: "SOFTWARE" }, "test:dup"),
      isAppErrorWith("CONFLICT", 409),
    );
  });

  it("creates, reads, updates and deletes an expense (happy path)", async () => {
    const cat = await seedCategory("Software");
    const product = await store.withTransaction((state) => seedProduct(state));
    const method = await store.withTransaction((state) => seedPaymentMethod(state));
    const expense = await seedExpense(cat.id, {
      amountMinor: 25_000,
      expenseDate: dayOffset(-3),
      productId: product.id,
      paymentMethodId: method.id,
      vendor: "Daraz",
      notes: "Office chair",
    });
    assert.equal(expense.amount_minor, 25_000);
    assert.equal(expense.currency, "BDT");
    assert.equal(expense.expense_date, dayOffset(-3));
    assert.equal(expense.product_id, product.id);
    assert.equal(expense.payment_method_id, method.id);
    assert.equal(expense.vendor, "Daraz");
    assert.equal(expense.recorded_by, SUPER_ACTOR.user.id);

    const updated = await updateExpense(store, SUPER_ACTOR, expense.id, {
      amountMinor: 30_000,
      notes: "Office chair + delivery",
    }, "test:exp-upd");
    assert.equal(updated.amount_minor, 30_000);
    assert.equal(updated.notes, "Office chair + delivery");

    assert.equal((await getExpense(store, SUPER_ACTOR, expense.id)).id, expense.id);
    const deleted = await deleteExpense(store, SUPER_ACTOR, expense.id, "test:exp-del");
    assert.equal(deleted.deleted, true);
    await assert.rejects(
      getExpense(store, SUPER_ACTOR, expense.id),
      isAppErrorWith("NOT_FOUND", 404),
    );
  });

  it("validation errors: bad amount / bad date / missing category / unknown FKs", async () => {
    const cat = await seedCategory("Software");
    const base = {
      amountMinor: 10_000,
      expenseDate: dayOffset(0),
      categoryId: cat.id,
    };
    // Bad amounts — 422 via the contract schema (SchemaValidationError).
    for (const bad of [0, -5, 1.5, "10000"]) {
      await assert.rejects(
        createExpense(store, SUPER_ACTOR, { ...base, amountMinor: bad }, "test:bad-amt"),
        (err: unknown) => err instanceof SchemaValidationError,
      );
    }
    // Bad dates — wrong shape and impossible calendar date.
    for (const bad of ["17/11/2026", "2026-13-40", "2026-02-30", "2026-1-5"]) {
      await assert.rejects(
        createExpense(store, SUPER_ACTOR, { ...base, expenseDate: bad }, "test:bad-date"),
        (err: unknown) => err instanceof SchemaValidationError,
      );
    }
    // Missing categoryId entirely → 422.
    await assert.rejects(
      createExpense(
        store,
        SUPER_ACTOR,
        { amountMinor: 1_000, expenseDate: dayOffset(0) },
        "test:no-cat",
      ),
      (err: unknown) => err instanceof SchemaValidationError,
    );
    // Unknown FKs → 404 (payments-service NOT_FOUND pattern).
    const unknownId = "00000000-0000-4000-8000-000000000099";
    await assert.rejects(
      createExpense(store, SUPER_ACTOR, { ...base, categoryId: unknownId }, "test:unk-cat"),
      isAppErrorWith("NOT_FOUND", 404),
    );
    await assert.rejects(
      createExpense(store, SUPER_ACTOR, { ...base, productId: unknownId }, "test:unk-prod"),
      isAppErrorWith("NOT_FOUND", 404),
    );
    await assert.rejects(
      createExpense(store, SUPER_ACTOR, { ...base, paymentMethodId: unknownId }, "test:unk-pm"),
      isAppErrorWith("NOT_FOUND", 404),
    );
    await assert.rejects(
      createExpense(store, SUPER_ACTOR, { ...base, receiptMediaId: unknownId }, "test:unk-media"),
      isAppErrorWith("NOT_FOUND", 404),
    );
    // Same guards on update.
    const expense = await seedExpense(cat.id);
    await assert.rejects(
      updateExpense(store, SUPER_ACTOR, expense.id, { categoryId: unknownId }, "test:upd-cat"),
      isAppErrorWith("NOT_FOUND", 404),
    );
    await assert.rejects(
      updateExpense(store, SUPER_ACTOR, expense.id, { amountMinor: 0 }, "test:upd-amt"),
      (err: unknown) => err instanceof SchemaValidationError,
    );
  });

  it("category delete-guard: 409 while expenses reference it, then deletes", async () => {
    const cat = await seedCategory("Software");
    const expense = await seedExpense(cat.id);
    await assert.rejects(
      deleteExpenseCategory(store, SUPER_ACTOR, cat.id, "test:del-guard"),
      isAppErrorWith("CONFLICT", 409),
    );
    await deleteExpense(store, SUPER_ACTOR, expense.id, "test:del-exp");
    const deleted = await deleteExpenseCategory(store, SUPER_ACTOR, cat.id, "test:del-cat");
    assert.equal(deleted.deleted, true);
    await assert.rejects(
      getExpenseCategory(store, SUPER_ACTOR, cat.id),
      isAppErrorWith("NOT_FOUND", 404),
    );
  });

  it("listExpenses: server-side q search (vendor + notes), filters, date range", async () => {
    const catA = await seedCategory("Software");
    const catB = await seedCategory("Marketing");
    const product = await store.withTransaction((state) => seedProduct(state));
    await seedExpense(catA.id, {
      amountMinor: 1_000,
      expenseDate: dayOffset(-10),
      vendor: "Daraz",
      notes: "keyboard",
      productId: product.id,
    });
    await seedExpense(catA.id, {
      amountMinor: 2_000,
      expenseDate: dayOffset(-5),
      vendor: "Brain Station 23",
      notes: "hosting renewal",
    });
    await seedExpense(catB.id, {
      amountMinor: 3_000,
      expenseDate: dayOffset(0),
      vendor: "Meta",
      notes: "ad spend",
      productId: product.id,
    });

    const byVendor = await listExpenses(store, SUPER_ACTOR, { q: "daraz" });
    assert.equal(byVendor.length, 1);
    const byNote = await listExpenses(store, SUPER_ACTOR, { q: "HOSTING" });
    assert.equal(byNote.length, 1);
    assert.equal(byNote[0]!.vendor, "Brain Station 23");
    const byCategory = await listExpenses(store, SUPER_ACTOR, { categoryId: catB.id });
    assert.equal(byCategory.length, 1);
    const byProduct = await listExpenses(store, SUPER_ACTOR, { productId: product.id });
    assert.equal(byProduct.length, 2);
    const inWindow = await listExpenses(store, SUPER_ACTOR, {
      from: dayOffset(-6),
      to: dayOffset(-1),
    });
    assert.equal(inWindow.length, 1);
    assert.equal(inWindow[0]!.amount_minor, 2_000);
    // Newest expense_date first.
    const all = await listExpenses(store, SUPER_ACTOR, {});
    assert.deepEqual(
      all.map((e) => e.amount_minor),
      [3_000, 2_000, 1_000],
    );
  });

  it("RBAC: no permission → 403 FORBIDDEN on reads and writes", async () => {
    const cat = await seedCategory("Software");
    await assert.rejects(
      listExpenseCategories(store, NO_PERMISSION_ACTOR, {}),
      isAppErrorWith("FORBIDDEN", 403),
    );
    await assert.rejects(
      getExpenseCategory(store, NO_PERMISSION_ACTOR, cat.id),
      isAppErrorWith("FORBIDDEN", 403),
    );
    await assert.rejects(
      createExpenseCategory(store, NO_PERMISSION_ACTOR, { name: "X" }, "test:rbac"),
      isAppErrorWith("FORBIDDEN", 403),
    );
    await assert.rejects(
      updateExpenseCategory(store, NO_PERMISSION_ACTOR, cat.id, { name: "Y" }, "test:rbac"),
      isAppErrorWith("FORBIDDEN", 403),
    );
    await assert.rejects(
      deleteExpenseCategory(store, NO_PERMISSION_ACTOR, cat.id, "test:rbac"),
      isAppErrorWith("FORBIDDEN", 403),
    );
    await assert.rejects(
      listExpenses(store, NO_PERMISSION_ACTOR, {}),
      isAppErrorWith("FORBIDDEN", 403),
    );
    await assert.rejects(
      createExpense(
        store,
        NO_PERMISSION_ACTOR,
        { amountMinor: 1_000, expenseDate: dayOffset(0), categoryId: cat.id },
        "test:rbac",
      ),
      isAppErrorWith("FORBIDDEN", 403),
    );
    // P&L takes no actor (the route gates it with the same
    // assertStaffPermission used above) — assert the gate directly.
    assert.throws(
      () => assertStaffPermission(NO_PERMISSION_ACTOR, "expenses.read"),
      isAppErrorWith("FORBIDDEN", 403),
    );
  });
});

describe("expenses — profit & loss", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  async function seedPaidOrder(
    productId: string,
    totalMinor: number,
    keySuffix: string,
  ) {
    let orderId = "";
    let methodId = "";
    await store.withTransaction((state) => {
      const product = state.products.find((p) => p.id === productId)!;
      const customer = seedCustomer(state, { name: `P&L ${keySuffix}` });
      const order = seedOrder(state, customer.id, product, {
        total_minor: totalMinor,
        subtotal_minor: totalMinor,
      });
      const method = seedPaymentMethod(state);
      seedInvoice(state, order, customer.id);
      createInstallmentsForOrderInTx(
        state,
        order,
        { kind: "full", due_date: dayOffset(30) },
        new Date(),
      );
      orderId = order.id;
      methodId = method.id;
    });
    const order = store.state.orders.find((o) => o.id === orderId)!;
    const claim = await submitManualPaymentClaim(store, {
      orderPublicReference: order.public_reference,
      idempotencyKey: `test:pnl-${keySuffix}`,
      rawBody: {
        payment_method_id: methodId,
        amount_minor: totalMinor,
        currency_code: "BDT",
        transfer_rail: "npsb",
      },
      requestId: "test:pnl-claim",
    });
    await approvePaymentSubmissionByStaff(
      store,
      SUPER_ACTOR,
      claim.payment_submission.id,
      {
        verified_amount_minor: totalMinor,
        currency_code: "BDT",
        verification_reference: `PNL-${keySuffix}`,
      },
      APPROVE_CONFIG,
    );
    return store.state.orders.find((o) => o.id === orderId)!;
  }

  async function seedFixture() {
    const productA = await store.withTransaction((state) =>
      seedProduct(state, { name: "Product A" }),
    );
    const productB = await store.withTransaction((state) =>
      seedProduct(state, { name: "Product B" }),
    );
    const catSoftware = await createExpenseCategory(
      store,
      SUPER_ACTOR,
      { name: "Software" },
      "test:pnl-cat",
    );
    const catMarketing = await createExpenseCategory(
      store,
      SUPER_ACTOR,
      { name: "Marketing" },
      "test:pnl-cat",
    );
    const orderA = await seedPaidOrder(productA.id, 100_000, "a");
    const orderB = await seedPaidOrder(productB.id, 50_000, "b");
    // Unpaid order — must never count as sales (dashboard rule).
    await store.withTransaction((state) => {
      const customer = seedCustomer(state, { name: "Unpaid" });
      seedOrder(state, customer.id, productA, {
        total_minor: 999_000,
        subtotal_minor: 999_000,
      });
    });
    await createExpense(store, SUPER_ACTOR, {
      amountMinor: 10_000,
      expenseDate: dayOffset(0),
      categoryId: catSoftware.id,
      productId: productA.id,
      vendor: "JetBrains",
    }, "test:pnl-exp");
    await createExpense(store, SUPER_ACTOR, {
      amountMinor: 7_000,
      expenseDate: dayOffset(-2),
      categoryId: catSoftware.id,
      notes: "Domain renewal",
    }, "test:pnl-exp");
    await createExpense(store, SUPER_ACTOR, {
      amountMinor: 5_000,
      expenseDate: dayOffset(-1),
      categoryId: catMarketing.id,
      productId: productB.id,
      vendor: "Meta",
    }, "test:pnl-exp");
    return { productA, productB, catSoftware, catMarketing, orderA, orderB };
  }

  function pnl(range: { from: string; to: string } | null, productId?: string | null) {
    return computeProfitLoss(store.state, {
      range,
      productId: productId ?? null,
      timeZone: TIME_ZONE,
    });
  }

  it("math: sales − expenses, byCategory, byProduct, daily trend", async () => {
    await seedFixture();
    const range = currentRange();
    const result = pnl(range);

    assert.equal(result.sales.totalMinor, 150_000);
    assert.equal(result.sales.orderCount, 2);
    assert.equal(result.expenses.totalMinor, 22_000);
    assert.equal(result.expenses.count, 3);
    assert.equal(result.netMinor, 128_000);
    assert.equal(result.productId, null);

    assert.deepEqual(
      result.byCategory.map((c) => [c.categoryName, c.totalMinor, c.count]),
      [
        ["Software", 17_000, 2],
        ["Marketing", 5_000, 1],
      ],
    );
    assert.deepEqual(
      result.byProduct.map((p) => [p.productName, p.salesMinor, p.expensesMinor, p.netMinor]),
      [
        ["Product A", 100_000, 10_000, 90_000],
        ["Product B", 50_000, 5_000, 45_000],
      ],
    );
    // Trend covers every day of the range; buckets sum back to totals.
    const fromMs = Date.parse(`${range.from}T00:00:00.000Z`);
    const toMs = Date.parse(`${range.to}T00:00:00.000Z`);
    const days = Math.round((toMs - fromMs) / 86_400_000) + 1;
    assert.equal(result.trend.length, days);
    assert.equal(
      result.trend.reduce((s, d) => s + d.salesMinor, 0),
      150_000,
    );
    assert.equal(
      result.trend.reduce((s, d) => s + d.expensesMinor, 0),
      22_000,
    );
    assert.ok(result.trend.every((d) => d.netMinor === d.salesMinor - d.expensesMinor));
  });

  it("product scoping: only that product's sales + expenses; byProduct omitted", async () => {
    const { productA } = await seedFixture();
    const result = pnl(currentRange(), productA.id);
    assert.equal(result.productId, productA.id);
    assert.equal(result.sales.totalMinor, 100_000);
    assert.equal(result.sales.orderCount, 1);
    assert.equal(result.expenses.totalMinor, 10_000);
    assert.equal(result.expenses.count, 1);
    assert.equal(result.netMinor, 90_000);
    assert.deepEqual(result.byProduct, []);
    assert.deepEqual(
      result.byCategory.map((c) => [c.categoryName, c.totalMinor]),
      [["Software", 10_000]],
    );
  });

  it("refunds net off sales in the range they were recorded", async () => {
    const { orderA } = await seedFixture();
    const before = pnl(currentRange());
    assert.equal(before.sales.totalMinor, 150_000);
    await recordManualRefundByAdmin(
      store,
      SUPER_ACTOR,
      {
        order_id: orderA.id,
        amount_minor: 20_000,
        currency_code: "BDT",
        reason: "Customer asked for a partial refund",
      },
      "test:pnl-refund",
    );
    const after = pnl(currentRange());
    assert.equal(after.sales.totalMinor, 130_000);
    assert.equal(after.sales.orderCount, 2);
    assert.equal(after.expenses.totalMinor, 22_000);
    assert.equal(after.netMinor, 108_000);
    // The refunded order still counts (completed_at marker), only the
    // money is netted — byProduct sales for Product A drop by 20,000.
    const productA = after.byProduct.find((p) => p.productName === "Product A")!;
    assert.equal(productA.salesMinor, 80_000);
    assert.equal(productA.netMinor, 70_000);
  });

  it("empty range: zeros, empty breakdowns, zeroed daily trend", async () => {
    await seedFixture();
    const result = pnl({ from: "2020-01-01", to: "2020-01-31" });
    assert.equal(result.sales.totalMinor, 0);
    assert.equal(result.sales.orderCount, 0);
    assert.equal(result.expenses.totalMinor, 0);
    assert.equal(result.expenses.count, 0);
    assert.equal(result.netMinor, 0);
    assert.deepEqual(result.byCategory, []);
    assert.deepEqual(result.byProduct, []);
    assert.equal(result.trend.length, 31);
    assert.ok(result.trend.every((d) => d.salesMinor === 0 && d.expensesMinor === 0));
  });

  it("unknown productId → 404", async () => {
    await seedFixture();
    assert.throws(
      () => pnl(currentRange(), "00000000-0000-4000-8000-000000000099"),
      isAppErrorWith("NOT_FOUND", 404),
    );
  });

  it("parseOverviewRange reuse: one-sided, reversed, >366-day ranges → 400", () => {
    for (const params of [
      "from=2026-11-01",
      "to=2026-11-30",
      "from=2026-11-30&to=2026-11-01",
      "from=2025-01-01&to=2026-12-31",
      "from=2026-13-01&to=2026-11-30",
    ]) {
      assert.throws(
        () => parseOverviewRange(new URLSearchParams(params)),
        isAppErrorWith("VALIDATION_ERROR", 400),
      );
    }
    assert.equal(parseOverviewRange(new URLSearchParams("")), null);
    assert.deepEqual(
      parseOverviewRange(new URLSearchParams("from=2026-11-01&to=2026-11-30")),
      { from: "2026-11-01", to: "2026-11-30" },
    );
  });
});
