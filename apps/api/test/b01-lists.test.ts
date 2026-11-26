/**
 * B-01 admin list wiring tests.
 *
 * Each wired list must return the CORRECT rows + total when run
 * against a `createTargeted()` store (whose `state` is empty — only
 * the targeted Drizzle queries may supply the data). Seeds go through
 * the full store's `withTransaction` (the existing test-setup
 * pattern); the assertions then run the list services against a fresh
 * targeted store, plus a live HTTP pass through the Hono app with a
 * per-request targeted store factory.
 *
 * Pre-wiring behaviour is pinned by re-running the OLD in-memory
 * filter/sort/paginate over a fresh full load and deep-equaling the
 * targeted result (products, customers, orders).
 *
 * Own database (`b01_lists`); rows are never deleted from the shared
 * test DB — the suite drops only its own database afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  setupTestDb,
  seedProduct,
  seedCustomer,
  seedOrder,
  seedInvoice,
  seedSubscription,
  seedLicense,
  seedPaymentMethod,
  SUPER_ACTOR,
} from "./customer-order-helpers.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import { listProducts } from "../src/modules/products/list.ts";
import { listCustomers } from "../src/modules/customers/list.ts";
import { listOrders } from "../src/modules/orders/list.ts";
import {
  listSubscriptions,
  listRenewals,
} from "../src/modules/subscriptions/list.ts";
import {
  listPaymentMethods,
  listPaymentProviders,
  listPaymentRefunds,
} from "../src/modules/payments/list.ts";
import { listInvoices, listOrderInstallments } from "../src/modules/invoices/list.ts";
import {
  customerExists,
  listCustomerActivity,
  listCustomerAddressesTargeted,
  listCustomerReportsTargeted,
  listCustomerTickets,
} from "../src/modules/customers/list.ts";
import { listCustomerPayments } from "../src/modules/payments/list.ts";
import {
  listCustomerInstallations,
  listLicenseActivations,
  listLicenses,
} from "../src/routes/admin/licenses.ts";
import { computeOrderPaid, computeOrderRemaining } from "../src/modules/customers/service.ts";
import { createHonoApp } from "../src/hono-app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import type { DatabaseState } from "../src/platform/db/store.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DB_NAME = "b01_lists";

describe.skipIf(!DATABASE_URL)("B-01 admin lists — targeted queries", () => {
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];
  let adminClient: Awaited<ReturnType<typeof setupTestDb>>["adminClient"];
  let cleanup: () => Promise<void>;
  let dbUrl: string;
  let targeted: DrizzleStore;

  // Seeded ids (deterministic numbers, random uuids).
  let pAlphaId = "";
  let pBetaId = "";
  let cAliceId = "";
  let cBobId = "";
  let o1Id = "";
  let o2Id = "";
  let o3Id = "";
  let o4Id = "";
  let txn1Id = "";
  let sub1Id = "";
  let lic1Id = "";
  let lic2Id = "";

  const NOW = new Date().toISOString();
  const dayIso = (offsetDays: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString();
  };

  beforeAll(async () => {
    const setup = await setupTestDb(DB_NAME);
    store = setup.store;
    adminClient = setup.adminClient;
    cleanup = setup.cleanup;
    const url = new URL(DATABASE_URL);
    url.pathname = `/${DB_NAME}`;
    dbUrl = url.toString();

    await store.withTransaction((state) => {
      // Super-admin role for the HTTP smoke test.
      const role = state.roles.find((r) => r.key === "super_admin")!;
      state.user_roles.push({
        user_id: SUPER_ACTOR.user.id,
        role_id: role.id,
        assigned_at: NOW,
      });

      const method = seedPaymentMethod(state);
      const providerId = method.provider_id;

      const pAlpha = seedProduct(state, {
        code: "B01-ALPHA",
        name: "B01 Alpha Widget",
        status: "active",
        created_at: "2026-11-26T10:00:00.000Z",
        updated_at: "2026-11-26T10:00:00.000Z",
      });
      const pBeta = seedProduct(state, {
        code: "B01-BETA",
        name: "B01 Beta Gadget",
        status: "draft",
        created_at: "2026-11-26T10:01:00.000Z",
        updated_at: "2026-11-26T10:01:00.000Z",
      });
      const pGamma = seedProduct(state, {
        code: "B01-GAMMA",
        name: "B01 Gamma Tool",
        status: "archived",
        created_at: "2026-11-26T10:02:00.000Z",
        updated_at: "2026-11-26T10:02:00.000Z",
      });
      pAlphaId = pAlpha.id;
      pBetaId = pBeta.id;
      state.product_features.push(
        {
          id: randomUUID(),
          product_id: pAlpha.id,
          feature_key: "b01-seats",
          name: "Seats",
          description: null,
          value_type: "limit",
          unit: "seats",
          default_value: 5,
          status: "active",
          created_at: NOW,
          updated_at: NOW,
        },
        {
          id: randomUUID(),
          product_id: pAlpha.id,
          feature_key: "b01-support",
          name: "Support",
          description: null,
          value_type: "boolean",
          unit: null,
          default_value: true,
          status: "active",
          created_at: NOW,
          updated_at: NOW,
        },
        {
          id: randomUUID(),
          product_id: pBeta.id,
          feature_key: "b01-beta-flag",
          name: "Beta flag",
          description: null,
          value_type: "boolean",
          unit: null,
          default_value: false,
          status: "active",
          created_at: NOW,
          updated_at: NOW,
        },
      );
      state.product_packages.push({
        id: randomUUID(),
        product_id: pAlpha.id,
        package_key: "b01-starter",
        name: "Starter",
        description: null,
        status: "active",
        current_version_id: null,
        created_at: NOW,
        updated_at: NOW,
      });

      const cAlice = seedCustomer(state, {
        name: "B01 Alice Anderson",
        email: "alice@b01.local",
        normalized_email: "alice@b01.local",
        phone: "01711111111",
        normalized_phone: "+8801711111111",
        created_at: "2026-11-26T10:00:00.000Z",
        updated_at: "2026-11-26T10:00:00.000Z",
      });
      const cBob = seedCustomer(state, {
        name: "B01 Bob Traders",
        email: "bob@b01.local",
        normalized_email: "bob@b01.local",
        company_name: "B01 Traders",
        created_at: "2026-11-26T10:01:00.000Z",
        updated_at: "2026-11-26T10:01:00.000Z",
      });
      const cCarol = seedCustomer(state, {
        name: "B01 Carol",
        created_at: "2026-11-26T10:02:00.000Z",
        updated_at: "2026-11-26T10:02:00.000Z",
      });
      cAliceId = cAlice.id;
      cBobId = cBob.id;
      state.customer_reports.push(
        {
          id: randomUUID(),
          customer_id: cAlice.id,
          author_user_id: SUPER_ACTOR.user.id,
          type: "concern",
          detail: "B01 concern report",
          created_at: NOW,
        },
        {
          id: randomUUID(),
          customer_id: cAlice.id,
          author_user_id: SUPER_ACTOR.user.id,
          type: "note",
          detail: "B01 note report",
          created_at: NOW,
        },
        {
          id: randomUUID(),
          customer_id: cBob.id,
          author_user_id: SUPER_ACTOR.user.id,
          type: "note",
          detail: "B01 bob note",
          created_at: NOW,
        },
      );
      state.customer_addresses.push(
        {
          id: randomUUID(),
          customer_id: cAlice.id,
          address_type: "billing",
          contact_name: "Alice",
          phone: "01711111111",
          address_line_1: "1 B01 Street",
          address_line_2: null,
          city: "Dhaka",
          state_or_region: "Dhaka",
          postal_code: "1212",
          country_code: "BD",
          is_default: true,
          created_at: NOW,
          updated_at: NOW,
        },
        {
          id: randomUUID(),
          customer_id: cAlice.id,
          address_type: "shipping",
          contact_name: "Alice",
          phone: null,
          address_line_1: "2 B01 Street",
          address_line_2: null,
          city: "Dhaka",
          state_or_region: "Dhaka",
          postal_code: "1212",
          country_code: "BD",
          is_default: false,
          created_at: NOW,
          updated_at: NOW,
        },
      );

      const o1 = seedOrder(state, cAlice.id, pAlpha, {
        order_number: "ORD-B01-001",
        public_reference: "ord_b01_001",
        total_minor: 100000,
        subtotal_minor: 100000,
        payment_status: "unpaid",
        created_at: "2026-11-26T10:00:00.000Z",
        updated_at: "2026-11-26T10:00:00.000Z",
      });
      const o2 = seedOrder(state, cAlice.id, pAlpha, {
        order_number: "ORD-B01-002",
        public_reference: "ord_b01_002",
        total_minor: 50000,
        subtotal_minor: 50000,
        payment_status: "partially_paid",
        created_at: "2026-11-26T10:01:00.000Z",
        updated_at: "2026-11-26T10:01:00.000Z",
      });
      const o3 = seedOrder(state, cBob.id, pBeta, {
        order_number: "ORD-B01-003",
        public_reference: "ord_b01_003",
        total_minor: 40000,
        subtotal_minor: 40000,
        payment_status: "paid",
        created_at: "2026-11-26T10:02:00.000Z",
        updated_at: "2026-11-26T10:02:00.000Z",
      });
      const o4 = seedOrder(state, cBob.id, pBeta, {
        order_number: "ORD-B01-004",
        public_reference: "ord_b01_004",
        total_minor: 70000,
        subtotal_minor: 70000,
        payment_status: "paid",
        created_at: "2026-11-26T10:03:00.000Z",
        updated_at: "2026-11-26T10:03:00.000Z",
      });
      o1Id = o1.id;
      o2Id = o2.id;
      o3Id = o3.id;
      o4Id = o4.id;
      // o2: installments pay 20000 of 50000 → paid 20000, remaining 30000.
      state.order_installments.push(
        {
          id: randomUUID(),
          order_id: o2.id,
          installment_number: 1,
          amount_minor: 25000,
          due_date: "2026-11-20",
          status: "partially_paid",
          paid_amount_minor: 20000,
          paid_at: NOW,
          notes: null,
          created_at: NOW,
          updated_at: NOW,
        },
        {
          id: randomUUID(),
          order_id: o2.id,
          installment_number: 2,
          amount_minor: 25000,
          due_date: "2026-12-20",
          status: "pending",
          paid_amount_minor: 0,
          paid_at: null,
          notes: null,
          created_at: NOW,
          updated_at: NOW,
        },
        // o4: installments fully paid → remaining 0.
        {
          id: randomUUID(),
          order_id: o4.id,
          installment_number: 1,
          amount_minor: 70000,
          due_date: "2026-11-20",
          status: "paid",
          paid_amount_minor: 70000,
          paid_at: NOW,
          notes: null,
          created_at: NOW,
          updated_at: NOW,
        },
      );
      // o3: no installments — paid from a succeeded transaction (40000).
      const sub3 = {
        id: randomUUID(),
        order_id: o3.id,
        customer_id: cBob.id,
        payment_method_id: method.id,
        installment_id: null,
        amount_minor: 40000,
        currency_code: "BDT",
        sender_name: "Bob",
        sender_phone: null,
        sender_bank_name: null,
        sender_account_reference: null,
        transfer_rail_key: null,
        transaction_reference: "B01-TXN-1",
        normalized_transaction_reference: "b01-txn-1",
        payment_date: "2026-11-25",
        proof_asset_id: null,
        duplicate_risk_Warning: false,
        status: "approved",
        customer_note: null,
        submitted_at: NOW,
        reviewed_at: NOW,
        reviewed_by_user_id: SUPER_ACTOR.user.id,
      } as const;
      state.payment_submissions.push({ ...sub3 });
      txn1Id = randomUUID();
      state.payment_transactions.push({
        id: txn1Id,
        order_id: o3.id,
        payment_method_id: method.id,
        payment_submission_id: sub3.id,
        provider_id: providerId,
        provider_transaction_id: "B01-PROV-TXN-1",
        amount_minor: 40000,
        currency_code: "BDT",
        status: "succeeded",
        paid_at: NOW,
        verified_by_user_id: SUPER_ACTOR.user.id,
        verification_source: "manual_staff",
        created_at: NOW,
      });
      // One submission on Alice's o1 (no transaction yet).
      state.payment_submissions.push({
        id: randomUUID(),
        order_id: o1.id,
        customer_id: cAlice.id,
        payment_method_id: method.id,
        installment_id: null,
        amount_minor: 50000,
        currency_code: "BDT",
        sender_name: "Alice",
        sender_phone: null,
        sender_bank_name: null,
        sender_account_reference: null,
        transfer_rail_key: null,
        transaction_reference: "B01-TXN-2",
        normalized_transaction_reference: "b01-txn-2",
        payment_date: "2026-11-25",
        proof_asset_id: null,
        duplicate_risk_Warning: false,
        status: "submitted",
        customer_note: null,
        submitted_at: NOW,
        reviewed_at: null,
        reviewed_by_user_id: null,
      });
      state.payment_refunds.push({
        id: randomUUID(),
        payment_transaction_id: txn1Id,
        amount_minor: 5000,
        currency_code: "BDT",
        status: "succeeded",
        reason: "B01 duplicate charge",
        provider_refund_id: "B01-REF-1",
        requested_by_user_id: SUPER_ACTOR.user.id,
        processed_by_user_id: SUPER_ACTOR.user.id,
        created_at: NOW,
        updated_at: NOW,
      });

      const inv1 = seedInvoice(state, o1, cAlice.id);
      inv1.items.push({
        id: randomUUID(),
        description_snapshot: "B01 Alpha Widget",
        quantity: 1,
        unit_amount_minor: 100000,
        line_amount_minor: 100000,
        currency_code: "BDT",
      });
      seedInvoice(state, o3, cBob.id);

      const sub1 = seedSubscription(state, {
        customer_id: cAlice.id,
        product_id: pAlpha.id,
        subscription_number: "SUB-B01-LIST-1",
        status: "active",
        next_renewal_at: null,
        periods: [
          {
            id: randomUUID(),
            subscription_id: "",
            period_number: 1,
            period_start: NOW,
            period_end: NOW,
            status: "active",
            renewal_order_id: null,
            invoice_id: null,
            payment_transaction_id: null,
            activated_at: NOW,
            created_at: NOW,
          },
        ],
      });
      sub1.periods[0]!.subscription_id = sub1.id;
      sub1Id = sub1.id;
      seedSubscription(state, {
        customer_id: cBob.id,
        product_id: pBeta.id,
        subscription_number: "SUB-B01-LIST-2",
        status: "paused",
        next_renewal_at: null,
      });
      // Renewal buckets (relative to today, UTC days).
      seedSubscription(state, {
        customer_id: cAlice.id,
        product_id: pAlpha.id,
        subscription_number: "SUB-B01-OVERDUE",
        status: "active",
        next_renewal_at: dayIso(-1),
      });
      seedSubscription(state, {
        customer_id: cAlice.id,
        product_id: pAlpha.id,
        subscription_number: "SUB-B01-DUE",
        status: "active",
        next_renewal_at: dayIso(3),
      });
      seedSubscription(state, {
        customer_id: cBob.id,
        product_id: pBeta.id,
        subscription_number: "SUB-B01-UPCOMING",
        status: "active",
        next_renewal_at: dayIso(20),
      });
      seedSubscription(state, {
        customer_id: cBob.id,
        product_id: pBeta.id,
        subscription_number: "SUB-B01-FAR",
        status: "active",
        next_renewal_at: dayIso(60),
      });
      seedSubscription(state, {
        customer_id: cAlice.id,
        product_id: pAlpha.id,
        subscription_number: "SUB-B01-CANCELLED",
        status: "cancelled",
        next_renewal_at: null,
      });
      seedSubscription(state, {
        customer_id: cBob.id,
        product_id: pBeta.id,
        subscription_number: "SUB-B01-PASTDUE",
        status: "past_due",
        next_renewal_at: null,
      });
      seedSubscription(state, {
        customer_id: cBob.id,
        product_id: pBeta.id,
        subscription_number: "SUB-B01-NORENEWAL",
        status: "active",
        next_renewal_at: null,
      });

      const lic1 = seedLicense(state, {
        product_id: pAlpha.id,
        customer_id: cAlice.id,
        license_number: "LIC-B01-001",
        activations: [
          {
            id: randomUUID(),
            license_id: "",
            installation_id_hash: "b01-install-1",
            domain_normalized: "alice.example.com",
            environment: "production",
            status: "active",
            activated_at: NOW,
            last_seen_at: NOW,
            deactivated_at: null,
            metadata: {},
            created_at: NOW,
          },
          {
            id: randomUUID(),
            license_id: "",
            installation_id_hash: "b01-install-2",
            domain_normalized: null,
            environment: "staging",
            status: "deactivated",
            activated_at: NOW,
            last_seen_at: NOW,
            deactivated_at: NOW,
            metadata: {},
            created_at: NOW,
          },
        ],
      });
      for (const a of lic1.activations) a.license_id = lic1.id;
      lic1Id = lic1.id;
      const lic2 = seedLicense(state, {
        product_id: pBeta.id,
        customer_id: cBob.id,
        license_number: "LIC-B01-002",
      });
      lic2Id = lic2.id;

      state.support_tickets.push(
        {
          id: randomUUID(),
          ticket_number: "TKT-B01-001",
          customer_id: cAlice.id,
          order_id: o1.id,
          subscription_id: null,
          license_id: null,
          product_id: null,
          title: "B01 Alice ticket",
          description: "help",
          status: "open",
          priority: "high",
          category: "billing",
          reporter_user_id: SUPER_ACTOR.user.id,
          source_note: null,
          assignee_user_id: null,
          created_at: NOW,
          updated_at: NOW,
          resolved_at: null,
          closed_at: null,
        },
        {
          id: randomUUID(),
          ticket_number: "TKT-B01-002",
          customer_id: cBob.id,
          order_id: null,
          subscription_id: null,
          license_id: null,
          product_id: null,
          title: "B01 Bob ticket",
          description: "help",
          status: "open",
          priority: "low",
          category: "technical",
          reporter_user_id: SUPER_ACTOR.user.id,
          source_note: null,
          assignee_user_id: null,
          created_at: NOW,
          updated_at: NOW,
          resolved_at: null,
          closed_at: null,
        },
      );

      const audit = (
        action: string,
        resourceType: string,
        resourceId: string,
        createdAt: string,
      ) => ({
        id: randomUUID(),
        actor_type: "staff" as const,
        actor_user_id: SUPER_ACTOR.user.id,
        integrated_site_id: null,
        action,
        resource_type: resourceType,
        resource_id: resourceId,
        outcome: "success" as const,
        request_id: "b01-test",
        changes: {},
        created_at: createdAt,
      });
      state.audit_logs.push(
        audit("b01.customer", "customer", cAlice.id, "2026-11-20T10:00:00.000Z"),
        audit("b01.order", "order", o1.id, "2026-11-21T10:00:00.000Z"),
        audit("b01.subscription", "subscription", sub1.id, "2026-11-22T10:00:00.000Z"),
        audit("b01.license", "license", lic1.id, "2026-11-23T10:00:00.000Z"),
        audit("b01.other-customer", "customer", cBob.id, "2026-11-24T10:00:00.000Z"),
        audit("b01.other-order", "order", o3.id, "2026-11-24T11:00:00.000Z"),
      );
      void cCarol;
    });

    // The store under test: targeted (empty state) + its drizzleDb.
    targeted = await DrizzleStore.createTargeted({ connectionString: dbUrl });
    assert.equal(targeted.state.products.length, 0, "targeted state must be empty");
    assert.equal(targeted.state.customers.length, 0, "targeted state must be empty");
    assert.equal(targeted.state.orders.length, 0, "targeted state must be empty");
  }, 120_000);

  afterAll(async () => {
    await targeted?.close().catch(() => {});
    await cleanup?.();
  });

  function db() {
    return targeted.drizzleDb;
  }

  it("products list: rows + total + search + pagination match the old in-memory list", async () => {
    const res = await listProducts(db(), { q: "", limit: 25, page: 1 });
    assert.equal(res.total, 3);
    assert.deepEqual(
      res.items.map((p) => p.code),
      ["B01-ALPHA", "B01-BETA", "B01-GAMMA"],
    );
    const alpha = res.items.find((p) => p.id === pAlphaId)!;
    assert.equal(alpha.features_count, 2);
    assert.equal(alpha.packages_count, 1);
    assert.equal(res.items.find((p) => p.id === pBetaId)!.features_count, 1);
    assert.equal(res.items.find((p) => p.id === pBetaId)!.packages_count, 0);

    const searched = await listProducts(db(), { q: "beta", limit: 25, page: 1 });
    assert.equal(searched.total, 1);
    assert.equal(searched.items[0]?.code, "B01-BETA");

    const page2 = await listProducts(db(), { q: "", limit: 2, page: 2 });
    assert.equal(page2.total, 3);
    assert.deepEqual(
      page2.items.map((p) => p.code),
      ["B01-GAMMA"],
    );

    // Pre-wiring behaviour: the old in-memory filter/map/paginate over
    // a fresh full load must produce the same rows.
    const full: DatabaseState = await store.loadState();
    const old = full.products
      .filter((p) => p.name.toLowerCase().includes("") || p.code.toLowerCase().includes(""))
      .map((p) => ({
        ...p,
        features_count: full.product_features.filter((f) => f.product_id === p.id).length,
        packages_count: full.product_packages.filter((pkg) => pkg.product_id === p.id).length,
      }));
    assert.deepEqual(res.items, old);
    assert.equal(res.total, old.length);
  });

  it("customers list: rows + total + search (name/email/phone) + report flags match the old list", async () => {
    const res = await listCustomers(db(), { q: "", limit: 25, page: 1 });
    assert.equal(res.total, 3);
    const alice = res.items.find((c) => c.id === cAliceId)!;
    assert.equal(alice.report_count, 2);
    assert.equal(alice.has_concern_report, true);
    const bob = res.items.find((c) => c.id === cBobId)!;
    assert.equal(bob.report_count, 1);
    assert.equal(bob.has_concern_report, false);

    const byName = await listCustomers(db(), { q: "alice", limit: 25, page: 1 });
    assert.equal(byName.total, 1);
    assert.equal(byName.items[0]?.id, cAliceId);
    const byPhone = await listCustomers(db(), { q: "1711111111", limit: 25, page: 1 });
    assert.equal(byPhone.total, 1);
    assert.equal(byPhone.items[0]?.id, cAliceId);
    const byCompany = await listCustomers(db(), { q: "traders", limit: 25, page: 1 });
    assert.equal(byCompany.total, 1);
    assert.equal(byCompany.items[0]?.id, cBobId);

    const full: DatabaseState = await store.loadState();
    const includes = (h: string | null | undefined, q: string) =>
      !q ? true : (h ?? "").toLowerCase().includes(q);
    const old = full.customers
      .filter(
        (c) =>
          includes(c.name, "") ||
          includes(c.email, "") ||
          includes(c.customer_number, "") ||
          includes(c.company_name, "") ||
          includes(c.phone, ""),
      )
      .map((c) => ({
        ...c,
        report_count: full.customer_reports.filter((r) => r.customer_id === c.id).length,
        has_concern_report: full.customer_reports.some(
          (r) => r.customer_id === c.id && r.type === "concern",
        ),
      }));
    assert.deepEqual(res.items, old);
  });

  it("orders list: rows + totals + paid/remaining + filters + pagination match the old list", async () => {
    const res = await listOrders(db(), { q: "", limit: 25, page: 1 });
    assert.equal(res.total, 4);
    // Newest first.
    assert.deepEqual(
      res.items.map((r) => r.order.order_number),
      ["ORD-B01-004", "ORD-B01-003", "ORD-B01-002", "ORD-B01-001"],
    );
    const byId = new Map(res.items.map((r) => [r.order.id, r]));
    assert.equal(byId.get(o1Id)!.paid_amount_minor, 0);
    assert.equal(byId.get(o1Id)!.remaining_minor, 100000);
    assert.equal(byId.get(o2Id)!.paid_amount_minor, 20000);
    assert.equal(byId.get(o2Id)!.remaining_minor, 30000);
    assert.equal(byId.get(o3Id)!.paid_amount_minor, 40000);
    assert.equal(byId.get(o3Id)!.remaining_minor, 0);
    assert.equal(byId.get(o4Id)!.paid_amount_minor, 70000);
    assert.equal(byId.get(o4Id)!.remaining_minor, 0);
    // Embedded customer + nested items (with entitlement snapshot).
    assert.equal(byId.get(o1Id)!.customer?.name, "B01 Alice Anderson");
    assert.equal(byId.get(o1Id)!.order.items.length, 1);
    assert.equal(byId.get(o1Id)!.order.items[0]?.entitlement_snapshot.source_type, "custom_offer");

    const openOnly = await listOrders(db(), { q: "", limit: 25, page: 1, openOnly: true });
    assert.equal(openOnly.total, 2);
    assert.deepEqual(
      openOnly.items.map((r) => r.order.order_number).sort(),
      ["ORD-B01-001", "ORD-B01-002"],
    );
    const paid = await listOrders(db(), {
      q: "",
      limit: 25,
      page: 1,
      paymentStatus: "paid",
    });
    assert.equal(paid.total, 2);
    const byCustomerName = await listOrders(db(), { q: "alice", limit: 25, page: 1 });
    assert.equal(byCustomerName.total, 2);
    const page2 = await listOrders(db(), { q: "", limit: 3, page: 2 });
    assert.equal(page2.total, 4);
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0]?.order.order_number, "ORD-B01-001");

    // Pre-wiring behaviour over a fresh full load.
    const full: DatabaseState = await store.loadState();
    const sortNewest = [...full.orders].sort((a, b) => {
      const byTime =
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (byTime !== 0) return -byTime;
      return a.id.localeCompare(b.id);
    });
    const old = sortNewest.map((o) => ({
      order: o,
      customer: full.customers.find((c) => c.id === o.customer_id) ?? null,
      paid_amount_minor: computeOrderPaid(full, o.id),
      remaining_minor: computeOrderRemaining(full, o),
    }));
    assert.deepEqual(res.items, old);
    assert.equal(res.total, old.length);
  });

  it("subscriptions list: rows + total + search + embedded refs + periods", async () => {
    const res = await listSubscriptions(db(), { q: "", limit: 25, page: 1 });
    assert.equal(res.total, 9);
    const sub1 = res.items.find((r) => r.subscription.id === sub1Id)!;
    assert.equal(sub1.subscription.subscription_number, "SUB-B01-LIST-1");
    assert.equal(sub1.customer?.name, "B01 Alice Anderson");
    assert.equal(sub1.product?.code, "B01-ALPHA");
    assert.equal(sub1.subscription.periods.length, 1);
    assert.equal(sub1.subscription.periods[0]?.period_number, 1);
    const searched = await listSubscriptions(db(), { q: "SUB-B01-LIST", limit: 25, page: 1 });
    assert.equal(searched.total, 2);
  });

  it("renewals: buckets, bucket filter, totals, nearest-first order", async () => {
    const res = await listRenewals(db(), { q: "", limit: 25, page: 1 });
    assert.equal(res.total, 5);
    // Nearest renewal first; the two rows with no renewal date
    // (cancelled / past_due) sort last, by id — assert them as a set.
    assert.deepEqual(
      res.items.slice(0, 3).map((r) => r.subscription.subscription_number),
      ["SUB-B01-OVERDUE", "SUB-B01-DUE", "SUB-B01-UPCOMING"],
    );
    assert.deepEqual(
      new Set(
        res.items.slice(3).map((r) => r.subscription.subscription_number),
      ),
      new Set(["SUB-B01-CANCELLED", "SUB-B01-PASTDUE"]),
    );
    assert.deepEqual(
      res.items.slice(0, 3).map((r) => r.bucket),
      ["overdue", "due", "upcoming"],
    );
    assert.deepEqual(
      new Set(res.items.slice(3).map((r) => r.bucket)),
      new Set(["cancelled", "failed"]),
    );
    const due = await listRenewals(db(), { q: "", limit: 25, page: 1, bucket: "due" });
    assert.equal(due.total, 1);
    assert.equal(due.items[0]?.subscription.subscription_number, "SUB-B01-DUE");
    const failed = await listRenewals(db(), { q: "", limit: 25, page: 1, bucket: "failed" });
    assert.equal(failed.total, 1);
    assert.equal(failed.items[0]?.subscription.subscription_number, "SUB-B01-PASTDUE");
    const searched = await listRenewals(db(), { q: "alice", limit: 25, page: 1 });
    assert.deepEqual(
      searched.items.map((r) => r.subscription.subscription_number).sort(),
      ["SUB-B01-CANCELLED", "SUB-B01-DUE", "SUB-B01-OVERDUE"],
    );
  });

  it("licenses list: rows + total + search + safe fields + refs + snapshots/activations", async () => {
    const res = await listLicenses(db(), { q: "", limit: 25, page: 1 });
    assert.equal(res.total, 2);
    const lic1 = res.items.find((l) => l.id === lic1Id)!;
    assert.equal("license_key_hash" in lic1, false);
    assert.equal(lic1.license_number, "LIC-B01-001");
    assert.equal(lic1.snapshots.length, 1);
    assert.equal(lic1.activations.length, 2);
    const ref1 = res.refs.get(lic1Id)!;
    assert.equal(ref1.customer_name, "B01 Alice Anderson");
    assert.equal(ref1.product_code, "B01-ALPHA");
    assert.equal(ref1.active_activations_count, 1);
    const lic2 = res.items.find((l) => l.id === lic2Id)!;
    assert.equal(res.refs.get(lic2Id)!.active_activations_count, 0);
    const searched = await listLicenses(db(), { q: "LIC-B01-002", limit: 25, page: 1 });
    assert.equal(searched.total, 1);
    const byProduct = await listLicenses(db(), { q: "B01-BETA", limit: 25, page: 1 });
    assert.equal(byProduct.total, 1);
    assert.equal(byProduct.items[0]?.id, lic2Id);
    const page2 = await listLicenses(db(), { q: "", limit: 1, page: 2 });
    assert.equal(page2.total, 2);
    assert.equal(page2.items.length, 1);
  });

  it("license activations list: page + total, license-scoped", async () => {
    const res = await listLicenseActivations(db(), lic1Id, { limit: 25, page: 1 });
    assert.equal(res.total, 2);
    assert.deepEqual(
      res.items.map((a) => a.status).sort(),
      ["active", "deactivated"],
    );
    const empty = await listLicenseActivations(db(), lic2Id, { limit: 25, page: 1 });
    assert.equal(empty.total, 0);
  });

  it("payment providers/methods/refunds: rows + totals + filters", async () => {
    const providers = await listPaymentProviders(db(), { q: "", limit: 25, page: 1 });
    assert.equal(providers.total, 4);
    assert.equal(
      providers.items.some((p) => p.provider_key === "bkash_manual"),
      true,
    );
    const searched = await listPaymentProviders(db(), { q: "bkash", limit: 25, page: 1 });
    assert.equal(searched.total, 1);

    const methods = await listPaymentMethods(db(), { q: "", limit: 25, page: 1 });
    assert.equal(methods.total, 1);
    assert.equal(methods.items[0]?.display_name, "Test Manual Account");
    assert.equal(methods.items[0]?.is_enabled, true);
    assert.deepEqual(methods.items[0]?.transfer_rails, ["npsb"]);
    const disabled = await listPaymentMethods(db(), {
      q: "",
      limit: 25,
      page: 1,
      isEnabled: false,
    });
    assert.equal(disabled.total, 0);

    const refunds = await listPaymentRefunds(db(), { q: "", limit: 25, page: 1 });
    assert.equal(refunds.total, 1);
    assert.equal(refunds.items[0]?.reason, "B01 duplicate charge");
    assert.equal(refunds.items[0]?.provider_refund_id, "B01-REF-1");
    const byTxn = await listPaymentRefunds(db(), { q: txn1Id.slice(0, 8), limit: 25, page: 1 });
    assert.equal(byTxn.total, 1);
    const none = await listPaymentRefunds(db(), { q: "zzz-no-match", limit: 25, page: 1 });
    assert.equal(none.total, 0);
  });

  it("invoices + installments: rows + totals + items + order scope", async () => {
    const all = await listInvoices(db(), { q: "", limit: 25, page: 1 });
    assert.equal(all.total, 2);
    const inv1 = all.items.find((i) => i.order_id === o1Id)!;
    assert.equal(inv1.items.length, 1);
    assert.equal(inv1.items[0]?.description_snapshot, "B01 Alpha Widget");
    const scoped = await listInvoices(db(), { q: "", limit: 25, page: 1, orderId: o1Id });
    assert.equal(scoped.total, 1);
    assert.equal(scoped.items[0]?.id, inv1.id);

    const inst = await listOrderInstallments(db(), o2Id, { limit: 25, page: 1 });
    assert.equal(inst.total, 2);
    assert.deepEqual(
      inst.items.map((i) => i.installment_number),
      [1, 2],
    );
    assert.equal(inst.items[0]?.paid_amount_minor, 20000);
    assert.equal(inst.items[0]?.due_date, "2026-11-20");
    const none = await listOrderInstallments(db(), o1Id, { limit: 25, page: 1 });
    assert.equal(none.total, 0);
  });

  it("customer-detail lists: orders/subs/licenses/addresses/reports/payments/installations/activity/tickets", async () => {
    assert.equal(await customerExists(db(), cAliceId), true);
    assert.equal(await customerExists(db(), randomUUID()), false);

    const orders = await listOrders(db(), {
      q: "",
      limit: 25,
      page: 1,
      customerId: cAliceId,
      sort: "asc",
    });
    assert.equal(orders.total, 2);
    assert.deepEqual(
      orders.items.map((r) => r.order.order_number),
      ["ORD-B01-001", "ORD-B01-002"],
    );
    assert.equal(orders.items[0]?.customer?.name, "B01 Alice Anderson");

    const subs = await listSubscriptions(db(), {
      q: "",
      limit: 25,
      page: 1,
      customerId: cAliceId,
    });
    assert.equal(subs.total, 4); // LIST-1 + OVERDUE + DUE + CANCELLED

    const lics = await listLicenses(db(), {
      q: "",
      limit: 25,
      page: 1,
      sort: "asc",
      customerId: cAliceId,
    });
    assert.equal(lics.total, 1);
    assert.equal(lics.items[0]?.id, lic1Id);

    const addresses = await listCustomerAddressesTargeted(db(), cAliceId);
    assert.equal(addresses.length, 2);
    assert.equal(addresses[0]?.is_default, true);
    assert.equal(addresses[0]?.label, "billing");

    const reports = await listCustomerReportsTargeted(db(), cAliceId);
    assert.equal(reports.length, 2);

    const payments = await listCustomerPayments(db(), cAliceId);
    assert.equal(payments.submissions.length, 1);
    assert.equal(payments.submissions[0]?.order_id, o1Id);
    assert.equal(payments.transactions.length, 0);
    const bobPayments = await listCustomerPayments(db(), cBobId);
    assert.equal(bobPayments.submissions.length, 1);
    assert.equal(bobPayments.submissions[0]?.order_id, o3Id);
    assert.equal(bobPayments.transactions.length, 1);
    assert.equal(bobPayments.transactions[0]?.id, txn1Id);

    const installs = await listCustomerInstallations(db(), cAliceId, { limit: 25, page: 1 });
    assert.equal(installs.total, 2);
    assert.equal(installs.items[0]?.license_number, "LIC-B01-001");
    assert.equal(installs.items[0]?.product_id, pAlphaId);

    const activity = await listCustomerActivity(db(), cAliceId, { limit: 25, page: 1 });
    assert.equal(activity.total, 4);
    assert.deepEqual(
      activity.items.map((a) => a.action),
      ["b01.customer", "b01.order", "b01.subscription", "b01.license"],
    );

    const tickets = await listCustomerTickets(db(), cAliceId, { limit: 25, page: 1 });
    assert.equal(tickets.total, 1);
    assert.equal(tickets.items[0]?.ticket_number, "TKT-B01-001");
  });

  it("HTTP: wired lists serve from a per-request targeted store (Hono app)", async () => {
    // A real Better Auth session row for the super admin, so the
    // middleware can resolve the principal via targeted lookups.
    const sessionToken = `b01-session-${randomUUID()}`;
    await adminClient.query(
      `INSERT INTO sessions (id, token, user_id, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
      [`b01-sess-${randomUUID()}`, sessionToken, SUPER_ACTOR.user.id],
    );
    const env = resolveRuntimeConfig({
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: dbUrl },
    });
    const app = createHonoApp({
      env,
      storeFactory: async () =>
        DrizzleStore.createTargeted({ connectionString: dbUrl }),
    });
    const get = async (path: string) => {
      const res = await app.fetch(
        new Request(`http://localhost:8787${path}`, {
          headers: { Cookie: `stackmate_session=${sessionToken}` },
        }),
        env,
      );
      return { status: res.status, body: (await res.json()) as any };
    };

    const products = await get("/api/v1/admin/products");
    assert.equal(products.status, 200, JSON.stringify(products.body));
    assert.equal(products.body.data.total, 3);
    assert.equal(products.body.data.items.length, 3);
    assert.equal(products.body.data.items[0].features_count, 2);

    const customers = await get("/api/v1/admin/customers?q=alice");
    assert.equal(customers.status, 200, JSON.stringify(customers.body));
    assert.equal(customers.body.data.total, 1);
    assert.equal(customers.body.data.items[0].report_count, 2);

    const openOrders = await get("/api/v1/admin/orders?open_only=true");
    assert.equal(openOrders.status, 200, JSON.stringify(openOrders.body));
    assert.equal(openOrders.body.data.total, 2);

    const renewals = await get("/api/v1/admin/renewals?bucket=due");
    assert.equal(renewals.status, 200, JSON.stringify(renewals.body));
    assert.equal(renewals.body.data.total, 1);

    const detailOrders = await get(`/api/v1/admin/customers/${cAliceId}/orders`);
    assert.equal(detailOrders.status, 200, JSON.stringify(detailOrders.body));
    assert.equal(detailOrders.body.data.total, 2);

    const missing = await get(`/api/v1/admin/customers/${randomUUID()}/orders`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");
  });
});
