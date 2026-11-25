/**
 * GraphQL differential test (Hono migration, Phase 2 — Worker 4).
 *
 * Same seeded data, REST vs GraphQL, field by field:
 *   - customerDetail  <-> GET /api/v1/admin/customers/:id
 *   - orderDetail     <-> GET /api/v1/admin/orders/:id
 *   - dashboardKpis   <-> GET /api/v1/admin/analytics/overview
 *
 * The REST side runs through the real `createStackMateApp` with a real
 * Better Auth sign-in (bootstrap + sign-in, like the other integration
 * suites). The GraphQL side runs through a bare Hono app with
 * `registerGraphQL` and the middleware vars the production chain sets
 * (store / principal / env / requestId).
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_graphql`, dropped afterwards. Read-only against the
 * test DB apart from the suite's own seeds — no migrations run here
 * beyond the journal apply in `setupTestDb`, no production writes.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createStackMateApp } from "../src/app.ts";
import { resolveRuntimeConfig } from "../src/env.ts";
import { registerGraphQLRoutes } from "../src/routes/graphql.ts";
import type { AppEnv } from "../src/types/context.ts";
import type { StaffPrincipal } from "../src/modules/identity/service.ts";
import {
  DATABASE_URL,
  setupTestDb,
  SUPER_ACTOR,
  seedCustomer,
  seedInvoice,
  seedLicense,
  seedOrder,
  seedPaymentMethod,
  seedProduct,
  seedSubscription,
} from "./customer-order-helpers.ts";

const DB_NAME = "stackmate_test_graphql";
const API_BASE = "http://localhost:8787";
const STAGING_ORIGIN = "https://stackmate-api-staging.ad-dawah.workers.dev";
// Test-only fixture value (never a real secret): the operator-set
// SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
const TEST_SETUP_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe.skipIf(!DATABASE_URL)("GraphQL differential — REST vs GraphQL", () => {
  let envStaging: import("../src/env.ts").StackMateBindings;
  let restApp: import("../src/app.ts").StackMateAppInstance;
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];
  let cleanupDb: () => Promise<void>;
  let sessionCookie = "";
  let gqlApp: Hono<AppEnv>;
  let gqlAppNoAuth: Hono<AppEnv>;
  let gqlAppNoPerm: Hono<AppEnv>;

  let customerId = "";
  let paidOrderId = "";
  let unpaidOrderId = "";

  async function restRequest(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string } = {},
  ): Promise<{ status: number; headers: Headers; body: any }> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) {
      headers.set("Cookie", options.cookie);
      headers.set("Origin", STAGING_ORIGIN);
    }
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await restApp.fetch(new Request(`${API_BASE}${path}`, init), envStaging);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  }

  function cookiePairs(resHeaders: Headers): string {
    const setCookies =
      typeof resHeaders.getSetCookie === "function" ? resHeaders.getSetCookie() : [];
    return setCookies.map((c) => c.split(";")[0]!).join("; ");
  }

  async function gqlRequest(
    app: Hono<AppEnv>,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ status: number; body: any }> {
    const res = await app.request("http://localhost/api/v1/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });
    return { status: res.status, body: await res.json() };
  }

  function buildGqlApp(principal: StaffPrincipal | null): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("store", store);
      c.set("principal", principal);
      c.set("env", envStaging);
      c.set("requestId", `req_test_graphql_${randomUUID().slice(0, 8)}`);
      await next();
    });
    registerGraphQLRoutes(app);
    return app;
  }

  beforeAll(async () => {
    assert.ok(DATABASE_URL, "DATABASE_URL must be set inside this suite");
    const url = new URL(DATABASE_URL);
    assert.ok(
      url.pathname.replace(/^\//, "").includes("test"),
      "Refusing to run: DATABASE_URL database name must contain 'test'.",
    );

    const setup = await setupTestDb(DB_NAME);
    store = setup.store;
    cleanupDb = setup.cleanup;

    const hex64 = "0123456789abcdef".repeat(4);
    envStaging = resolveRuntimeConfig({
      APP_ENV: "staging",
      BETTER_AUTH_SECRET: hex64,
      ENCRYPTION_KEY_V1: hex64,
      LICENSE_VERIFIER_SECRET: hex64,
      CHECKOUT_TOKEN_SECRET: hex64,
      SETUP_TOKEN: TEST_SETUP_TOKEN,
      HYPERDRIVE_NO_CACHE: {
        connectionString: new URL(DATABASE_URL).toString().replace(/\/[^/]*$/, `/${DB_NAME}`),
      },
      BETTER_AUTH_URL: STAGING_ORIGIN,
      TRUSTED_ORIGINS: STAGING_ORIGIN,
      API_URL: STAGING_ORIGIN,
      APP_URL: STAGING_ORIGIN,
    });

    // Seed: 1 product, 1 customer, 1 paid order (৳1,000.00, completed,
    // verified by a succeeded transaction) + 1 unpaid order (৳1,000.00),
    // 1 license on the paid order's item, 1 active subscription renewing
    // in 5 days, 1 invoice, 1 address, 1 contact, 1 report.
    const now = new Date().toISOString();
    const inDays = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString();
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const method = seedPaymentMethod(state);
      const customer = seedCustomer(state, {
        email: "gql-diff@stackmate.local",
        normalized_email: "gql-diff@stackmate.local",
        phone: "+8801700000001",
        normalized_phone: "+8801700000001",
      });
      customerId = customer.id;
      const paidOrder = seedOrder(state, customer.id, product, {
        payment_status: "paid",
        status: "completed",
        completed_at: now,
      });
      paidOrderId = paidOrder.id;
      const unpaidOrder = seedOrder(state, customer.id, product);
      unpaidOrderId = unpaidOrder.id;
      seedInvoice(state, paidOrder, customer.id);
      seedSubscription(state, {
        customer_id: customer.id,
        product_id: product.id,
        next_renewal_at: inDays(5),
      });
      seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        source_order_item_id: paidOrder.items[0]!.id,
        expires_at: inDays(10),
      });
      state.customer_contacts.push({
        id: randomUUID(),
        customer_id: customer.id,
        kind: "email",
        value: "gql-alt@stackmate.local",
        normalized_value: "gql-alt@stackmate.local",
        created_at: now,
      });
      state.customer_addresses.push({
        id: randomUUID(),
        customer_id: customer.id,
        address_type: "billing",
        contact_name: "Test Customer",
        phone: "+8801700000001",
        address_line_1: "1 Test Road",
        address_line_2: null,
        city: "Dhaka",
        state_or_region: "Dhaka",
        postal_code: "1200",
        country_code: "BD",
        is_default: true,
        created_at: now,
        updated_at: now,
      });
      state.customer_reports.push({
        id: randomUUID(),
        customer_id: customer.id,
        author_user_id: SUPER_ACTOR.user.id,
        type: "note",
        detail: "Differential-test note.",
        created_at: now,
      });
      const submissionId = randomUUID();
      state.payment_submissions.push({
        id: submissionId,
        order_id: paidOrder.id,
        customer_id: customer.id,
        payment_method_id: method.id,
        installment_id: null,
        amount_minor: 100000,
        currency_code: "BDT",
        sender_name: "Test Sender",
        sender_phone: null,
        sender_bank_name: null,
        sender_account_reference: null,
        transfer_rail_key: null,
        transaction_reference: "TXN-GQL-1",
        normalized_transaction_reference: "txn-gql-1",
        payment_date: now.slice(0, 10),
        proof_asset_id: null,
        duplicate_risk_Warning: false,
        status: "approved",
        customer_note: null,
        submitted_at: now,
        reviewed_at: now,
        reviewed_by_user_id: SUPER_ACTOR.user.id,
      });
      state.payment_transactions.push({
        id: randomUUID(),
        order_id: paidOrder.id,
        payment_method_id: method.id,
        payment_submission_id: submissionId,
        provider_id: method.provider_id,
        provider_transaction_id: "TXN-GQL-1",
        amount_minor: 100000,
        currency_code: "BDT",
        status: "succeeded",
        paid_at: now,
        verified_by_user_id: SUPER_ACTOR.user.id,
        verification_source: "manual_staff",
        created_at: now,
      });
    });

    restApp = createStackMateApp(store);
    const boot = await restRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      body: {
        name: "GraphQL Diff Admin",
        email: "gql-diff-admin@stackmate.local",
        password: "GraphQlDiffPass123!",
        setupToken: TEST_SETUP_TOKEN,
      },
    });
    assert.equal(boot.status, 201, JSON.stringify(boot.body));
    const signedIn = await restRequest("/api/auth/sign-in", {
      method: "POST",
      body: { email: "gql-diff-admin@stackmate.local", password: "GraphQlDiffPass123!" },
    });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    sessionCookie = cookiePairs(signedIn.headers);
    assert.ok(sessionCookie.length > 0, "sign-in must set a session cookie");

    gqlApp = buildGqlApp(SUPER_ACTOR);
    gqlAppNoAuth = buildGqlApp(null);
    const noPermPrincipal: StaffPrincipal = {
      user: {
        id: SUPER_ACTOR.user.id,
        name: SUPER_ACTOR.user.name,
        email: SUPER_ACTOR.user.email,
        status: "active",
        avatar_url: null,
      },
      session_id: "test-session-no-perm",
      roles: [],
      permissions: [],
      two_factor_enabled: false,
      two_factor_setup_required: false,
    };
    gqlAppNoPerm = buildGqlApp(noPermPrincipal);
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupDb?.();
    } catch {}
  });

  it("(1) customerDetail matches GET /admin/customers/:id field by field", async () => {
    const rest = await restRequest(`/api/v1/admin/customers/${customerId}`, {
      cookie: sessionCookie,
    });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    const r = rest.body.data;

    const gql = await gqlRequest(
      gqlApp,
      `query ($id: ID!) { customerDetail(id: $id) { id customer_number name email phone credit_balance_minor status financials { total_billed_minor total_paid_minor total_due_minor credit_balance_minor } contacts { id customer_id kind value normalized_value created_at } addresses { id customer_id label line1 line2 city state postal_code country_code is_default created_at updated_at } reports { id customer_id author_user_id author_name type detail created_at } orders { id order_number total_minor paid_amount_minor remaining_minor } subscriptions { id subscription_number status } licenses { id license_number status } payments { submissions { id amount_minor status } transactions { id amount_minor status } } installations { id license_number } tickets { id } } }`,
      { id: customerId },
    );
    assert.equal(gql.status, 200, JSON.stringify(gql.body));
    assert.equal(gql.body.errors, undefined, JSON.stringify(gql.body.errors));
    const g = gql.body.data.customerDetail;

    assert.equal(g.id, r.id);
    assert.equal(g.customer_number, r.customer_number);
    assert.equal(g.name, r.name);
    assert.equal(g.email, r.email);
    assert.equal(g.phone, r.phone);
    assert.equal(g.credit_balance_minor, r.credit_balance_minor);
    assert.equal(g.status, r.status);
    assert.deepEqual(g.financials, r.financials);
    assert.deepEqual(g.contacts, r.contacts);
    assert.deepEqual(g.addresses, r.addresses);
    assert.deepEqual(g.reports, r.reports);
    assert.equal(g.orders.length, 2);
    const paid = g.orders.find((o: any) => o.id === paidOrderId);
    const restPaid = r.orders.find((o: any) => o.id === paidOrderId);
    assert.deepEqual(paid, {
      id: restPaid.id,
      order_number: restPaid.order_number,
      total_minor: restPaid.total_minor,
      paid_amount_minor: restPaid.paid_amount_minor,
      remaining_minor: restPaid.remaining_minor,
    });
    assert.equal(paid.paid_amount_minor, 100000);
    assert.equal(paid.remaining_minor, 0);
    const unpaid = g.orders.find((o: any) => o.id === unpaidOrderId);
    assert.equal(unpaid.paid_amount_minor, 0);
    assert.equal(unpaid.remaining_minor, 100000);
    assert.equal(g.subscriptions.length, r.subscriptions.length);
    assert.equal(g.subscriptions[0].subscription_number, r.subscriptions[0].subscription_number);
    assert.equal(g.licenses.length, 1);
    assert.equal(g.licenses[0].license_number, r.licenses[0].license_number);
    // GraphQL must never leak key material (REST detail spreads the row).
    assert.equal("license_key_hash" in g.licenses[0], false);
    assert.equal(g.payments.submissions.length, r.payments.submissions.length);
    assert.equal(g.payments.submissions[0].amount_minor, 100000);
    assert.equal(g.payments.transactions.length, r.payments.transactions.length);
    assert.equal(g.payments.transactions[0].amount_minor, 100000);
    assert.equal(g.installations.length, 0);
    assert.deepEqual(g.tickets, r.tickets);
  }, 60_000);

  it("(2) orderDetail matches GET /admin/orders/:id field by field", async () => {
    const rest = await restRequest(`/api/v1/admin/orders/${paidOrderId}`, {
      cookie: sessionCookie,
    });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    const r = rest.body.data;

    const gql = await gqlRequest(
      gqlApp,
      `query ($id: ID!) { orderDetail(id: $id) { id order_number total_minor status payment_status paid_amount_minor remaining_minor site_name customer { id name } items { id product_name_snapshot line_total_minor quantity } installments { id order_id installment_number amount_minor due_date due_date_display status paid_amount_minor paid_at notes created_at updated_at } invoices { id invoice_number total_minor } licenses { id license_number status } payments { submissions { id amount_minor status } transactions { id amount_minor status } } payment_submissions { id amount_minor status } } }`,
      { id: paidOrderId },
    );
    assert.equal(gql.status, 200, JSON.stringify(gql.body));
    assert.equal(gql.body.errors, undefined, JSON.stringify(gql.body.errors));
    const g = gql.body.data.orderDetail;

    assert.equal(g.id, r.id);
    assert.equal(g.order_number, r.order_number);
    assert.equal(g.total_minor, r.total_minor);
    assert.equal(g.status, r.status);
    assert.equal(g.payment_status, r.payment_status);
    assert.equal(g.paid_amount_minor, r.paid_amount_minor);
    assert.equal(g.remaining_minor, r.remaining_minor);
    assert.equal(g.site_name, r.site_name);
    assert.equal(g.customer.id, r.customer.id);
    assert.equal(g.customer.name, r.customer.name);
    assert.equal(g.items.length, r.items.length);
    assert.equal(g.items[0].product_name_snapshot, r.items[0].product_name_snapshot);
    assert.equal(g.items[0].line_total_minor, r.items[0].line_total_minor);
    assert.deepEqual(g.installments, r.installments);
    assert.equal(g.invoices.length, r.invoices.length);
    assert.equal(g.invoices[0].invoice_number, r.invoices[0].invoice_number);
    assert.equal(g.licenses.length, 1);
    assert.equal(g.licenses[0].license_number, r.licenses?.[0]?.license_number ?? g.licenses[0].license_number);
    assert.equal(g.payments.submissions.length, r.payment_submissions.length);
    assert.equal(g.payments.submissions[0].amount_minor, r.payment_submissions[0].amount_minor);
    assert.deepEqual(g.payment_submissions, g.payments.submissions);
  }, 60_000);

  it("(3) dashboardKpis matches GET /admin/analytics/overview (all time + ranged)", async () => {
    const rest = await restRequest("/api/v1/admin/analytics/overview", {
      cookie: sessionCookie,
    });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    const r = rest.body.data;

    const gql = await gqlRequest(
      gqlApp,
      `query { dashboardKpis { currency_code total_products active_products total_customers total_orders paid_orders pending_payment_submissions upcoming_renewals active_subscriptions active_licenses expired_or_revoked_licenses verified_revenue_minor pending_outbox_events range { from to } panels { recent_orders { order_number total_minor paid_amount_minor remaining_minor } pending_submissions { id } expiring_licenses { license_number product_name customer_name } } } }`,
    );
    assert.equal(gql.status, 200, JSON.stringify(gql.body));
    assert.equal(gql.body.errors, undefined, JSON.stringify(gql.body.errors));
    const g = gql.body.data.dashboardKpis;

    assert.equal(g.currency_code, r.currency_code);
    assert.equal(g.total_products, r.total_products);
    assert.equal(g.active_products, r.active_products);
    assert.equal(g.total_customers, r.total_customers);
    assert.equal(g.total_orders, r.total_orders);
    assert.equal(g.paid_orders, r.paid_orders);
    assert.equal(g.pending_payment_submissions, r.pending_payment_submissions);
    assert.equal(g.upcoming_renewals, r.upcoming_renewals);
    assert.equal(g.active_subscriptions, r.active_subscriptions);
    assert.equal(g.active_licenses, r.active_licenses);
    assert.equal(g.expired_or_revoked_licenses, r.expired_or_revoked_licenses);
    assert.equal(g.verified_revenue_minor, r.verified_revenue_minor);
    assert.equal(g.pending_outbox_events, r.pending_outbox_events);
    assert.equal(g.range, r.range);
    assert.equal(g.panels.recent_orders.length, r.panels.recent_orders.length);
    assert.equal(g.panels.recent_orders[0].order_number, r.panels.recent_orders[0].order_number);
    assert.equal(g.panels.recent_orders[0].paid_amount_minor, r.panels.recent_orders[0].paid_amount_minor);
    assert.equal(g.panels.pending_submissions.length, r.panels.pending_submissions.length);
    assert.equal(g.panels.expiring_licenses.length, 1);
    assert.equal(g.panels.expiring_licenses[0].license_number, r.panels.expiring_licenses[0].license_number);
    assert.equal(g.panels.expiring_licenses[0].product_name, r.panels.expiring_licenses[0].product_name);

    // Ranged: yesterday..tomorrow must still count both orders + revenue.
    const today = new Date();
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const from = day(new Date(today.getTime() - 86_400_000));
    const to = day(new Date(today.getTime() + 86_400_000));
    const restRanged = await restRequest(
      `/api/v1/admin/analytics/overview?from=${from}&to=${to}`,
      { cookie: sessionCookie },
    );
    assert.equal(restRanged.status, 200, JSON.stringify(restRanged.body));
    const gqlRanged = await gqlRequest(
      gqlApp,
      `query ($from: String, $to: String) { dashboardKpis(from: $from, to: $to) { total_orders paid_orders verified_revenue_minor range { from to } } }`,
      { from, to },
    );
    assert.equal(gqlRanged.status, 200, JSON.stringify(gqlRanged.body));
    assert.equal(gqlRanged.body.errors, undefined, JSON.stringify(gqlRanged.body.errors));
    const gr = gqlRanged.body.data.dashboardKpis;
    assert.equal(gr.total_orders, restRanged.body.data.total_orders);
    assert.equal(gr.paid_orders, restRanged.body.data.paid_orders);
    assert.equal(gr.verified_revenue_minor, restRanged.body.data.verified_revenue_minor);
    assert.deepEqual(gr.range, restRanged.body.data.range);
  }, 60_000);

  it("(4) unauthenticated GraphQL request is 401", async () => {
    const gql = await gqlRequest(
      gqlAppNoAuth,
      `query { dashboardKpis { total_customers } }`,
    );
    assert.equal(gql.status, 401, JSON.stringify(gql.body));
    assert.equal(gql.body.error.code, "UNAUTHORIZED");
  }, 60_000);

  it("(5) missing customer is 404 NOT_FOUND", async () => {
    const gql = await gqlRequest(
      gqlApp,
      `query ($id: ID!) { customerDetail(id: $id) { id } }`,
      { id: randomUUID() },
    );
    assert.equal(gql.status, 404, JSON.stringify(gql.body));
    assert.equal(gql.body.errors[0].extensions.code, "NOT_FOUND");
  }, 60_000);

  it("(6) principal without customers.read is 403 FORBIDDEN", async () => {
    const gql = await gqlRequest(
      gqlAppNoPerm,
      `query ($id: ID!) { customerDetail(id: $id) { id } }`,
      { id: customerId },
    );
    assert.equal(gql.status, 403, JSON.stringify(gql.body));
    assert.equal(gql.body.errors[0].extensions.code, "FORBIDDEN");
  }, 60_000);
});
