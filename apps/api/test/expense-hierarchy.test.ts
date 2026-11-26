/**
 * Expense category hierarchy — API worker tests (in-memory, no Postgres).
 *
 * Migration 0026: parent_id (nullable self-reference, RESTRICT).
 * Covers: create/update parent validation (self-parent / unknown /
 * inactive parent → 400), cycle prevention on update (descendant as
 * parent → 400), delete guard extended to children (409 with the
 * "sub-categor(ies)" message; the expenses 409 is unchanged), the
 * nested tree shape (children / depth / path), childCount on the DTO,
 * detach (parent_id null), and the P&L byCategory roll-up (parent
 * total = own + all descendants; global total counted once).
 *
 * The GET /tree route itself returns exactly listExpenseCategoryTree
 * (routes/admin/expenses.ts); its presence on the Hono app + OpenAPI
 * is proven by the conformance test (182 paths / 232 operations).
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { SUPER_ACTOR } from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  buildCategoryTree,
  createExpense,
  createExpenseCategory,
  deleteExpense,
  deleteExpenseCategory,
  getExpenseCategory,
  listExpenseCategories,
  listExpenseCategoryTree,
  updateExpenseCategory,
} from "../src/modules/expenses/service.ts";
import { computeProfitLoss } from "../src/modules/analytics/pnl.ts";
import type { AppError } from "../src/shared/errors.ts";

const TIME_ZONE = "Asia/Dhaka";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000099";

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

describe("expense hierarchy — parent / tree", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  async function seedCategory(
    name: string,
    overrides: Record<string, unknown> = {},
  ) {
    return createExpenseCategory(store, SUPER_ACTOR, { name, ...overrides }, "test:hier");
  }

  /** Office → Stationery → Pens (3 levels) + a top-level sibling. */
  async function seedTree() {
    const office = await seedCategory("Office");
    const stationery = await seedCategory("Stationery", { parent_id: office.id });
    const pens = await seedCategory("Pens", { parent_id: stationery.id });
    const marketing = await seedCategory("Marketing");
    return { office, stationery, pens, marketing };
  }

  it("create with parent_id: stored, parent DTO shows childCount 1", async () => {
    const office = await seedCategory("Office");
    const child = await seedCategory("Stationery", { parent_id: office.id });
    assert.equal(child.parent_id, office.id);
    assert.equal(child.is_active, true);

    const parentDto = await getExpenseCategory(store, SUPER_ACTOR, office.id);
    assert.equal(parentDto.childCount, 1);
    assert.equal(parentDto.expenseCount, 0);
    const childDto = await getExpenseCategory(store, SUPER_ACTOR, child.id);
    assert.equal(childDto.childCount, 0);

    // Omitted parent_id → top-level.
    const top = await seedCategory("Marketing");
    assert.equal(top.parent_id, null);
    assert.equal((await getExpenseCategory(store, SUPER_ACTOR, top.id)).childCount, 0);
  });

  it("tree: nested shape, depth + path breadcrumbs, roots only top-level", async () => {
    const { office, stationery, pens, marketing } = await seedTree();
    const tree = await listExpenseCategoryTree(store, SUPER_ACTOR, {});

    assert.equal(tree.length, 2);
    const officeNode = tree.find((n) => n.id === office.id)!;
    const marketingNode = tree.find((n) => n.id === marketing.id)!;
    assert.equal(officeNode.depth, 0);
    assert.equal(officeNode.path, "Office");
    assert.equal(officeNode.childCount, 1);
    assert.equal(marketingNode.depth, 0);
    assert.deepEqual(marketingNode.children, []);

    assert.equal(officeNode.children.length, 1);
    const stationeryNode = officeNode.children[0]!;
    assert.equal(stationeryNode.id, stationery.id);
    assert.equal(stationeryNode.depth, 1);
    assert.equal(stationeryNode.path, "Office / Stationery");

    assert.equal(stationeryNode.children.length, 1);
    const pensNode = stationeryNode.children[0]!;
    assert.equal(pensNode.id, pens.id);
    assert.equal(pensNode.depth, 2);
    assert.equal(pensNode.path, "Office / Stationery / Pens");
    assert.deepEqual(pensNode.children, []);

    // buildCategoryTree is order-independent: reversed flat input
    // (grandchild first) still yields the same depths + paths.
    const flat = await listExpenseCategories(store, SUPER_ACTOR, {});
    const reversed = buildCategoryTree([...flat].reverse());
    const revOffice = reversed.find((n) => n.id === office.id)!;
    assert.equal(revOffice.children[0]!.children[0]!.depth, 2);
    assert.equal(revOffice.children[0]!.children[0]!.path, "Office / Stationery / Pens");
  });

  it("self-parent → 400 (create is impossible pre-id; update rejects)", async () => {
    const office = await seedCategory("Office");
    await assert.rejects(
      updateExpenseCategory(
        store,
        SUPER_ACTOR,
        office.id,
        { parent_id: office.id },
        "test:self-parent",
      ),
      isAppErrorWith("VALIDATION_ERROR", 400),
    );
    assert.equal((await getExpenseCategory(store, SUPER_ACTOR, office.id)).parent_id, null);
  });

  it("non-existent parent → 400 (create + update)", async () => {
    await assert.rejects(
      seedCategory("Orphan", { parent_id: UNKNOWN_ID }),
      isAppErrorWith("VALIDATION_ERROR", 400),
    );
    const office = await seedCategory("Office");
    await assert.rejects(
      updateExpenseCategory(
        store,
        SUPER_ACTOR,
        office.id,
        { parent_id: UNKNOWN_ID },
        "test:unknown-parent",
      ),
      isAppErrorWith("VALIDATION_ERROR", 400),
    );
  });

  it("inactive parent → 400", async () => {
    const office = await seedCategory("Office", { is_active: false });
    await assert.rejects(
      seedCategory("Stationery", { parent_id: office.id }),
      isAppErrorWith("VALIDATION_ERROR", 400),
    );
  });

  it("cycle prevention: a category cannot take its own descendant as parent", async () => {
    const { office, stationery, pens } = await seedTree();
    // Office's descendant Pens as Office's parent → cycle.
    await assert.rejects(
      updateExpenseCategory(
        store,
        SUPER_ACTOR,
        office.id,
        { parent_id: pens.id },
        "test:cycle-office",
      ),
      isAppErrorWith("VALIDATION_ERROR", 400),
    );
    // Stationery's descendant Pens as Stationery's parent → cycle.
    await assert.rejects(
      updateExpenseCategory(
        store,
        SUPER_ACTOR,
        stationery.id,
        { parent_id: pens.id },
        "test:cycle-stationery",
      ),
      isAppErrorWith("VALIDATION_ERROR", 400),
    );
    // Nothing moved: the tree is unchanged.
    const tree = await listExpenseCategoryTree(store, SUPER_ACTOR, {});
    assert.equal(tree.find((n) => n.id === office.id)!.children[0]!.id, stationery.id);
  });

  it("valid re-parent + detach (parent_id null) work", async () => {
    const { office, pens, marketing } = await seedTree();
    // Pens moves from Stationery to Marketing (not a descendant).
    const moved = await updateExpenseCategory(
      store,
      SUPER_ACTOR,
      pens.id,
      { parent_id: marketing.id },
      "test:reparent",
    );
    assert.equal(moved.parent_id, marketing.id);
    const tree = await listExpenseCategoryTree(store, SUPER_ACTOR, {});
    assert.equal(
      tree.find((n) => n.id === marketing.id)!.children[0]!.id,
      pens.id,
    );
    // Detach → top-level again.
    const detached = await updateExpenseCategory(
      store,
      SUPER_ACTOR,
      pens.id,
      { parent_id: null },
      "test:detach",
    );
    assert.equal(detached.parent_id, null);
    assert.equal(
      (await listExpenseCategoryTree(store, SUPER_ACTOR, {})).length,
      3,
    );
    assert.equal(office.id !== undefined, true);
  });

  it("delete blocked when children exist: 409 with sub-categor(ies) message", async () => {
    const { office, stationery, pens } = await seedTree();
    await assert.rejects(
      deleteExpenseCategory(store, SUPER_ACTOR, office.id, "test:del-children"),
      (err: unknown) =>
        isAppErrorWith("CONFLICT", 409)(err) &&
        (err as AppError).message.includes("1 sub-categor(ies) still reference it"),
    );
    await assert.rejects(
      deleteExpenseCategory(store, SUPER_ACTOR, stationery.id, "test:del-children"),
      (err: unknown) =>
        isAppErrorWith("CONFLICT", 409)(err) &&
        (err as AppError).message.includes("sub-categor(ies) still reference it"),
    );
    // Leaf deletes fine; then its parent becomes a leaf and deletes too.
    assert.equal(
      (await deleteExpenseCategory(store, SUPER_ACTOR, pens.id, "test:del-leaf")).deleted,
      true,
    );
    assert.equal(
      (await deleteExpenseCategory(store, SUPER_ACTOR, stationery.id, "test:del-mid")).deleted,
      true,
    );
    assert.equal(
      (await deleteExpenseCategory(store, SUPER_ACTOR, office.id, "test:del-root")).deleted,
      true,
    );
  });

  it("delete blocked when expenses exist: 409 (existing guard, message unchanged)", async () => {
    const office = await seedCategory("Office");
    const expense = await createExpense(
      store,
      SUPER_ACTOR,
      { amountMinor: 5_000, expenseDate: dayOffset(0), categoryId: office.id },
      "test:del-expenses",
    );
    await assert.rejects(
      deleteExpenseCategory(store, SUPER_ACTOR, office.id, "test:del-guard"),
      (err: unknown) =>
        isAppErrorWith("CONFLICT", 409)(err) &&
        (err as AppError).message.includes("1 expense(s) still reference it"),
    );
    await deleteExpense(store, SUPER_ACTOR, expense.id, "test:del-exp");
    assert.equal(
      (await deleteExpenseCategory(store, SUPER_ACTOR, office.id, "test:del-cat")).deleted,
      true,
    );
  });

  it("P&L roll-up: parent total = own + all descendants; global total counted once", async () => {
    const { office, stationery, pens } = await seedTree();
    const seedExpense = (categoryId: string, amountMinor: number) =>
      createExpense(
        store,
        SUPER_ACTOR,
        { amountMinor, expenseDate: dayOffset(0), categoryId },
        "test:pnl-rollup",
      );
    await seedExpense(office.id, 10_000); // own
    await seedExpense(stationery.id, 7_000); // child
    await seedExpense(pens.id, 3_000); // grandchild

    const result = computeProfitLoss(store.state, {
      range: null,
      productId: null,
      timeZone: TIME_ZONE,
    });
    // Global total: each expense once — no double-counting.
    assert.equal(result.expenses.totalMinor, 20_000);
    assert.equal(result.expenses.count, 3);
    assert.equal(result.netMinor, 0 - 20_000);

    const byId = new Map(result.byCategory.map((r) => [r.categoryId, r]));
    const officeRow = byId.get(office.id)!;
    assert.equal(officeRow.totalMinor, 20_000); // 10k own + 7k + 3k
    assert.equal(officeRow.ownTotalMinor, 10_000);
    assert.equal(officeRow.count, 1);
    const stationeryRow = byId.get(stationery.id)!;
    assert.equal(stationeryRow.totalMinor, 10_000); // 7k own + 3k child
    assert.equal(stationeryRow.ownTotalMinor, 7_000);
    assert.equal(stationeryRow.count, 1);
    const pensRow = byId.get(pens.id)!;
    assert.equal(pensRow.totalMinor, 3_000);
    assert.equal(pensRow.ownTotalMinor, 3_000);
    assert.equal(pensRow.count, 1);
    // Parent sorts first (largest roll-up total); child rows stay as detail.
    assert.deepEqual(
      result.byCategory.map((r) => r.categoryName),
      ["Office", "Stationery", "Pens"],
    );
  });

  it("P&L without hierarchy: roll-up equals own total (no regression)", async () => {
    const office = await seedCategory("Office");
    await createExpense(
      store,
      SUPER_ACTOR,
      { amountMinor: 4_000, expenseDate: dayOffset(0), categoryId: office.id },
      "test:pnl-flat",
    );
    const result = computeProfitLoss(store.state, {
      range: null,
      productId: null,
      timeZone: TIME_ZONE,
    });
    assert.equal(result.byCategory.length, 1);
    assert.equal(result.byCategory[0]!.totalMinor, 4_000);
    assert.equal(result.byCategory[0]!.ownTotalMinor, 4_000);
    assert.equal(result.expenses.totalMinor, 4_000);
  });
});
