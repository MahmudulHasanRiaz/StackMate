/**
 * Expense module — DrizzleStore Postgres round-trip (Gap 2 proof).
 *
 * The expense service writes through store.withTransaction; without a
 * load query + SyncSpec in drizzle-store.ts the rows would live only
 * in the per-request in-memory state and vanish on the next request
 * (the service's old lazy-init path). This suite proves, against a
 * real Postgres with ALL journal migrations applied (0000–0019):
 *   1. create category + expense → fresh store reload → rows present
 *      (load query + insert SyncSpec);
 *   2. update expense → reload → new amount (update SyncSpec);
 *   3. delete expense + category → reload → rows gone, and the P&L
 *      computed from the RELOADED state sees the expense (load feeds
 *      analytics, not just the CRUD service);
 *   4. migration 0019 landed: the three permission keys exist and the
 *      role grants match the seed (finance_manager: all three,
 *      support_staff + read_only: expenses.read only) — read back
 *      through the store's loaded roles, i.e. the same path the API's
 *      permission check uses.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_expenses`, dropped afterwards. Skips cleanly without
 * DATABASE_URL (same pattern as the other Drizzle suites).
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  setupTestDb,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import {
  createExpense,
  createExpenseCategory,
  deleteExpense,
  deleteExpenseCategory,
  updateExpense,
} from "../src/modules/expenses/service.ts";
import { computeProfitLoss } from "../src/modules/analytics/pnl.ts";

const DB_NAME = "stackmate_test_expenses";

describe.skipIf(!DATABASE_URL)("Expense module — DrizzleStore round-trip", () => {
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];
  let cleanup: () => Promise<void>;
  let dbUrl: string;

  beforeAll(async () => {
    const setup = await setupTestDb(DB_NAME);
    store = setup.store;
    cleanup = setup.cleanup;
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${DB_NAME}`;
    dbUrl = url.toString();
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("create → reload → update → reload → delete → reload persists every step", async () => {
    const category = await createExpenseCategory(store, SUPER_ACTOR, {
      name: "Hosting",
      description: "Servers and domains",
    }, "test:expenses");
    const expense = await createExpense(store, SUPER_ACTOR, {
      amountMinor: 250000,
      expenseDate: "2026-11-20",
      categoryId: category.id,
      vendor: "Test Host Ltd",
    }, "test:expenses");

    // (1) Fresh store = fresh load from Postgres: both rows must be there.
    let reloaded = await DrizzleStore.create({ connectionString: dbUrl });
    try {
      const state = await reloaded.loadState();
      assert.equal(
        state.expense_categories.find((c) => c.id === category.id)?.name,
        "Hosting",
      );
      const seen = state.expenses.find((e) => e.id === expense.id);
      assert.equal(seen?.amount_minor, 250000);
      assert.equal(seen?.expense_date, "2026-11-20");
      assert.equal(seen?.currency, "BDT");
      // (3a) P&L from the RELOADED state sees the expense.
      const pnl = computeProfitLoss(state, {
        range: { from: "2026-11-01", to: "2026-11-30" },
        productId: null,
        timeZone: "Asia/Dhaka",
      });
      assert.equal(pnl.expenses.totalMinor, 250000);
      assert.equal(pnl.expenses.count, 1);
    } finally {
      await reloaded.close();
    }

    // (2) Update → reload shows the new amount.
    await updateExpense(store, SUPER_ACTOR, expense.id, {
      amountMinor: 300000,
    }, "test:expenses");
    reloaded = await DrizzleStore.create({ connectionString: dbUrl });
    try {
      const state = await reloaded.loadState();
      assert.equal(
        state.expenses.find((e) => e.id === expense.id)?.amount_minor,
        300000,
      );
    } finally {
      await reloaded.close();
    }

    // (3) Delete expense + category → reload shows them gone.
    await deleteExpense(store, SUPER_ACTOR, expense.id, "test:expenses");
    await deleteExpenseCategory(store, SUPER_ACTOR, category.id, "test:expenses");
    reloaded = await DrizzleStore.create({ connectionString: dbUrl });
    try {
      const state = await reloaded.loadState();
      assert.equal(state.expenses.find((e) => e.id === expense.id), undefined);
      assert.equal(
        state.expense_categories.find((c) => c.id === category.id),
        undefined,
      );
      assert.equal(
        computeProfitLoss(state, {
          range: { from: "2026-11-01", to: "2026-11-30" },
          productId: null,
          timeZone: "Asia/Dhaka",
        }).expenses.totalMinor,
        0,
      );
    } finally {
      await reloaded.close();
    }
  });

  it("migration 0019: expense permission keys + role grants load through the store", async () => {
    const state = await store.loadState();
    const byKey = new Map(state.roles.map((r) => [r.key, r.permission_keys]));
    const finance = byKey.get("finance_manager") ?? [];
    assert.ok(finance.includes("expenses.read"), "finance_manager needs expenses.read");
    assert.ok(finance.includes("expenses.manage"), "finance_manager needs expenses.manage");
    assert.ok(
      finance.includes("expense_categories.manage"),
      "finance_manager needs expense_categories.manage",
    );
    for (const roleKey of ["support_staff", "read_only"]) {
      const keys = byKey.get(roleKey) ?? [];
      assert.ok(keys.includes("expenses.read"), `${roleKey} needs expenses.read`);
      assert.ok(!keys.includes("expenses.manage"), `${roleKey} must NOT have expenses.manage`);
      assert.ok(
        !keys.includes("expense_categories.manage"),
        `${roleKey} must NOT have expense_categories.manage`,
      );
    }
    // super_admin + admin hold everything the seed lists.
    for (const roleKey of ["super_admin", "admin"]) {
      const keys = byKey.get(roleKey) ?? [];
      assert.ok(keys.includes("expenses.read"));
      assert.ok(keys.includes("expenses.manage"));
      assert.ok(keys.includes("expense_categories.manage"));
    }
  });
});
