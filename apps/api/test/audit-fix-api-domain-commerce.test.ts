/**
 * API-domain audit fixes — commerce (F-05, M-14b, F-12).
 *
 *  - F-05: on_date activation dates are strictly validated at the
 *    service (the contracts schema refine is the parent's remainder):
 *    a real ISO calendar date, today-or-future in the business
 *    timezone. DD/MM/YYYY, impossible dates and past dates 422 —
 *    no order is created.
 *  - M-14b: a public checkout order writes an audit row (actor
 *    "integration", attributed to the site).
 *  - F-12: the on_date boundary is business-today (Asia/Dhaka) —
 *    an order created at 01:00 Dhaka with today's date is accepted,
 *    not rejected as "past" (UTC would say yesterday).
 *
 * In-memory (no Postgres).
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SUPER_ACTOR, seedProduct, seedSite } from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { createOrderByAdmin, createPublicCheckoutOrder } from "../src/modules/commerce/service.ts";
import { businessTodayIso } from "../src/modules/activation/service.ts";
import type { AppError } from "../src/shared/errors.ts";

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("commerce — audit fixes (F-05, M-14b, F-12)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  async function seedCustomProduct() {
    let productId = "";
    let featureId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const featureIdInner = randomUUID();
      state.product_features.push({
        id: featureIdInner,
        product_id: product.id,
        feature_key: "priority_support",
        name: "Priority support",
        description: null,
        value_type: "boolean",
        unit: null,
        default_value: false,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      productId = product.id;
      featureId = featureIdInner;
    });
    return { productId, featureId };
  }

  function adminBody(productId: string, featureId: string, activationDate: string) {
    return {
      new_customer: { name: "Order Test", email: "order-test@example.com" },
      product_id: productId,
      item_kind: "custom",
      custom_offer: {
        label: "Custom build",
        price_kind: "one_time",
        unit_amount_minor: 100_000,
        activation_limit: 1,
        features: [
          {
            product_feature_id: featureId,
            entitlement_value: { value_type: "boolean", value: true },
          },
        ],
      },
      activation_mode: "on_date",
      activation_date: activationDate,
    };
  }

  it("F-05: DD/MM/YYYY, impossible and past activation dates 422 — no order created", async () => {
    const { productId, featureId } = await seedCustomProduct();
    const today = businessTodayIso(new Date(), "Asia/Dhaka");
    const badDates = [
      "15/11/2026", // DD/MM/YYYY silently never activated (lexicographic compare)
      "2026-02-30", // impossible calendar date
      addDaysIso(today, -1), // past
      "not-a-date",
      "2026-13-01", // impossible month
    ];
    for (const bad of badDates) {
      await assert.rejects(
        () =>
          createOrderByAdmin(
            store,
            SUPER_ACTOR,
            adminBody(productId, featureId, bad),
            `test:f05-${bad}`,
          ),
        (err: AppError) => {
          assert.equal(err.statusCode, 422);
          assert.equal(err.code, "VALIDATION_ERROR");
          return true;
        },
      );
    }
    assert.equal(store.state.orders.length, 0);
  });

  it("F-05/F-12: today and future activation dates create the order (business timezone)", async () => {
    const { productId, featureId } = await seedCustomProduct();
    const today = businessTodayIso(new Date(), "Asia/Dhaka");
    const future = addDaysIso(today, 30);
    const first = await createOrderByAdmin(
      store,
      SUPER_ACTOR,
      adminBody(productId, featureId, today),
      "test:f05-today",
    );
    assert.equal(first.order.activation_mode, "on_date");
    assert.equal(first.order.activation_date, today);
    const second = await createOrderByAdmin(
      store,
      SUPER_ACTOR,
      {
        ...adminBody(productId, featureId, future),
        new_customer: { name: "Order Test 2", email: "order-test-2@example.com" },
      },
      "test:f05-future",
    );
    assert.equal(second.order.activation_date, future);
    assert.equal(store.state.orders.length, 2);
  });

  it("M-14b: a public checkout order writes an audit row attributed to the site", async () => {
    let siteKey = "";
    let productSlug = "";
    let versionId = "";
    let priceId = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const site = seedSite(state);
      site.product_ids = [product.id];
      const pkgId = randomUUID();
      const versionIdInner = randomUUID();
      const priceIdInner = randomUUID();
      state.product_packages.push({
        id: pkgId,
        product_id: product.id,
        package_key: "starter",
        name: "Starter",
        description: null,
        status: "active",
        current_version_id: versionIdInner,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      state.package_versions.push({
        id: versionIdInner,
        package_id: pkgId,
        product_id: product.id,
        version_number: 1,
        status: "published",
        change_summary: null,
        features: [],
        published_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
      state.package_prices.push({
        id: priceIdInner,
        package_version_id: versionIdInner,
        price_key: "once",
        price_kind: "one_time",
        amount_minor: 100_000,
        currency_code: "BDT",
        interval_unit: null,
        interval_count: null,
        trial_days: 0,
        setup_fee_minor: 0,
        status: "active",
        used_in_orders: false,
        created_at: new Date().toISOString(),
      });
      siteKey = site.site_key;
      productSlug = product.slug;
      versionId = versionIdInner;
      priceId = priceIdInner;
    });

    const res = await createPublicCheckoutOrder(store, {
      siteKey,
      idempotencyKey: "test:checkout-m14b",
      checkoutTokenSecret: "test-checkout-secret",
      rawBody: {
        items: [
          { product_slug: productSlug, package_version_id: versionId, price_id: priceId, quantity: 1 },
        ],
        customer: { name: "Checkout Buyer", email: "buyer@example.com" },
        billing_address: { country_code: "BD" },
      },
      requestId: "test:checkout-m14b",
    });
    assert.equal(res.order.total_minor, 100_000);
    const row = store.state.audit_logs.find((l) => l.action === "commerce.order.created");
    assert.ok(row);
    assert.equal(row?.actor_type, "integration");
    assert.equal(row?.resource_id, res.order.id);
    assert.equal(row?.request_id, "test:checkout-m14b");
    assert.ok(
      store.state.outbox_events.some(
        (e) => e.event_type === "order.created" && e.aggregate_id === res.order.id,
      ),
    );
  });
});
