/**
 * Support tickets (ADR-0009 addendum — owner scope 2026-11-17).
 *
 * Rules under test:
 *  - Create: server-generated TKT- number, status starts open.
 *  - Linkages: picking an order auto-assigns its customer; picking a
 *    subscription/license auto-assigns customer + product; a manual
 *    customer that disagrees with the order's customer → 422
 *    TICKET_LINK_MISMATCH; a subscription of another customer → 422.
 *  - Transitions are enforced (open → closed is 409); reopen from
 *    resolved/closed returns to open and clears resolved/closed_at.
 *  - Assignment requires an existing staff user (unknown id → 404).
 *  - Comments thread with internal flag; transition notes land as
 *    internal comments.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_tickets`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  setupTestDb,
  seedCustomer,
  seedProduct,
  seedOrder,
  seedSubscription,
  seedLicense,
} from "./customer-order-helpers.ts";
import type { AppError } from "../src/shared/errors.ts";

const DB_NAME = "stackmate_test_tickets";

describe.skipIf(!DATABASE_URL)("support tickets", () => {
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];
  let cleanup: () => Promise<void>;
  let staffUserId = "";

  beforeAll(async () => {
    const setup = await setupTestDb(DB_NAME);
    store = setup.store;
    cleanup = setup.cleanup;
    await store.withTransaction((state) => {
      staffUserId = randomUUID();
      state.users.push({
        id: staffUserId,
        name: "Support Staff",
        email: "support@stackmate.local",
        email_verified: true,
        password_hash: "test-only-hash",
        two_factor_enabled: false,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    });
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("create: server-generated number, starts open, unlinked allowed", async () => {
    const { createTicketByAdmin } = await import("../src/modules/tickets/service.ts");
    const ticket = await createTicketByAdmin(
      store,
      SUPER_ACTOR,
      { title: "Checkout fails on mobile", description: "Customer reports a 500 on checkout.", priority: "high", category: "technical" },
      "test:ticket-1",
    );
    assert.match(ticket.ticket_number, /^TKT-/);
    assert.equal(ticket.status, "open");
    assert.equal(ticket.customer_id, null);
    assert.equal(ticket.reporter_user_id, SUPER_ACTOR.user.id);
  });

  it("linkages: order auto-assigns customer; subscription/license auto-assign customer + product", async () => {
    const { createTicketByAdmin } = await import("../src/modules/tickets/service.ts");
    let orderId = "";
    let subId = "";
    let licenseId = "";
    let customerId = "";
    let productId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      productId = product.id;
      const customer = seedCustomer(state, { name: "Ticket Customer", email: "ticket@example.com", normalized_email: "ticket@example.com" });
      customerId = customer.id;
      const order = seedOrder(state, customer.id, product);
      orderId = order.id;
      const sub = seedSubscription(state, { customer_id: customer.id, product_id: product.id, source_order_item_id: order.items[0]!.id });
      subId = sub.id;
      const license = seedLicense(state, { product_id: product.id, customer_id: customer.id, subscription_id: sub.id, source_order_item_id: order.items[0]!.id });
      licenseId = license.id;
    });

    const byOrder = await createTicketByAdmin(
      store,
      SUPER_ACTOR,
      { title: "Order issue", order_id: orderId, priority: "medium" },
      "test:ticket-order",
    );
    assert.equal(byOrder.customer_id, customerId);
    assert.equal(byOrder.order_id, orderId);

    const byLicense = await createTicketByAdmin(
      store,
      SUPER_ACTOR,
      { title: "License issue", license_id: licenseId, priority: "urgent" },
      "test:ticket-license",
    );
    assert.equal(byLicense.customer_id, customerId);
    assert.equal(byLicense.product_id, productId);
    assert.equal(byLicense.license_id, licenseId);

    const bySub = await createTicketByAdmin(
      store,
      SUPER_ACTOR,
      { title: "Subscription issue", subscription_id: subId, priority: "low" },
      "test:ticket-sub",
    );
    assert.equal(bySub.customer_id, customerId);
    assert.equal(bySub.product_id, productId);
  });

  it("linkages: mismatched manual customer or foreign subscription → 422", async () => {
    const { createTicketByAdmin } = await import("../src/modules/tickets/service.ts");
    let orderId = "";
    let otherCustomerId = "";
    let subId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Owner" });
      const other = seedCustomer(state, { name: "Other" });
      otherCustomerId = other.id;
      const order = seedOrder(state, customer.id, product);
      orderId = order.id;
      const sub = seedSubscription(state, { customer_id: customer.id, product_id: product.id, source_order_item_id: order.items[0]!.id });
      subId = sub.id;
    });
    await assert.rejects(
      () =>
        createTicketByAdmin(
          store,
          SUPER_ACTOR,
          { title: "Mismatch", order_id: orderId, customer_id: otherCustomerId, priority: "medium" },
          "test:ticket-mismatch-1",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "TICKET_LINK_MISMATCH");
        return true;
      },
    );
    await assert.rejects(
      () =>
        createTicketByAdmin(
          store,
          SUPER_ACTOR,
          { title: "Foreign sub", subscription_id: subId, customer_id: otherCustomerId, priority: "medium" },
          "test:ticket-mismatch-2",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "TICKET_LINK_MISMATCH");
        return true;
      },
    );
  });

  it("transitions are enforced; reopen clears resolved/closed stamps", async () => {
    const { createTicketByAdmin, transitionTicketByAdmin } = await import(
      "../src/modules/tickets/service.ts"
    );
    const ticket = await createTicketByAdmin(
      store,
      SUPER_ACTOR,
      { title: "Flow ticket", priority: "low" },
      "test:ticket-flow-1",
    );
    // resolved → in_progress is not an allowed transition.
    const inProgress = await transitionTicketByAdmin(store, SUPER_ACTOR, ticket.id, { status: "in_progress", note: "Looking into it." }, "test:ticket-flow-2");
    assert.equal(inProgress.status, "in_progress");
    // The transition note landed as an internal comment.
    assert.equal(
      store.state.ticket_comments.filter((c) => c.ticket_id === ticket.id && c.is_internal).length,
      1,
    );
    const waiting = await transitionTicketByAdmin(store, SUPER_ACTOR, ticket.id, { status: "waiting_on_customer" }, "test:ticket-flow-4");
    assert.equal(waiting.status, "waiting_on_customer");
    const resolved = await transitionTicketByAdmin(store, SUPER_ACTOR, ticket.id, { status: "resolved" }, "test:ticket-flow-5");
    assert.equal(resolved.status, "resolved");
    assert.ok(resolved.resolved_at);
    await assert.rejects(
      () => transitionTicketByAdmin(store, SUPER_ACTOR, ticket.id, { status: "in_progress" }, "test:ticket-flow-5b"),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "INVALID_TICKET_TRANSITION");
        return true;
      },
    );
    const reopened = await transitionTicketByAdmin(store, SUPER_ACTOR, ticket.id, { status: "open" }, "test:ticket-flow-6");
    assert.equal(reopened.status, "open");
    assert.equal(reopened.resolved_at, null);
    assert.equal(reopened.closed_at, null);
    const back = await transitionTicketByAdmin(store, SUPER_ACTOR, ticket.id, { status: "in_progress" }, "test:ticket-flow-7");
    assert.equal(back.status, "in_progress");
    await transitionTicketByAdmin(store, SUPER_ACTOR, ticket.id, { status: "resolved" }, "test:ticket-flow-8");
    const closedAgain = await transitionTicketByAdmin(store, SUPER_ACTOR, ticket.id, { status: "closed" }, "test:ticket-flow-9");
    assert.equal(closedAgain.status, "closed");
    assert.ok(closedAgain.closed_at);
    // closed → resolved is not allowed (only reopen to open).
    await assert.rejects(
      () => transitionTicketByAdmin(store, SUPER_ACTOR, ticket.id, { status: "resolved" }, "test:ticket-flow-10"),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "INVALID_TICKET_TRANSITION");
        return true;
      },
    );
    assert.ok(
      store.state.audit_logs.some(
        (a) => a.action === "tickets.ticket.status_changed" && a.resource_id === ticket.id,
      ),
    );
  });

  it("assignment requires an existing staff user; comments thread works", async () => {
    const { createTicketByAdmin, assignTicketByAdmin, addTicketCommentByAdmin } = await import(
      "../src/modules/tickets/service.ts"
    );
    const ticket = await createTicketByAdmin(
      store,
      SUPER_ACTOR,
      { title: "Assign ticket", priority: "medium" },
      "test:ticket-assign-1",
    );
    await assert.rejects(
      () => assignTicketByAdmin(store, SUPER_ACTOR, ticket.id, { assignee_user_id: randomUUID() }, "test:ticket-assign-2"),
      (err: AppError) => {
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
    const assigned = await assignTicketByAdmin(
      store,
      SUPER_ACTOR,
      ticket.id,
      { assignee_user_id: staffUserId },
      "test:ticket-assign-3",
    );
    assert.equal(assigned.assignee_user_id, staffUserId);
    const comment = await addTicketCommentByAdmin(
      store,
      SUPER_ACTOR,
      ticket.id,
      { body: "Customer called back — issue confirmed.", is_internal: false },
      "test:ticket-assign-4",
    );
    assert.equal(comment.author_user_id, SUPER_ACTOR.user.id);
    assert.equal(comment.is_internal, false);
    assert.equal(store.state.ticket_comments.filter((c) => c.ticket_id === ticket.id).length, 1);
  });
});
