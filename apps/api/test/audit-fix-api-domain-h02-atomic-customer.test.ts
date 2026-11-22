/**
 * SPA H-02 (API half) — one-request customer create.
 *
 * POST /api/v1/admin/customers accepts an optional `address` object
 * (the CreateCustomerAddressSchema shape, same as POST .../addresses)
 * in the same body. It is validated BEFORE the transaction opens and
 * created in the SAME transaction as the customer, so an address
 * validation failure never leaves a created customer behind.
 *
 * In-memory (no Postgres): drives createCustomerByAdmin /
 * createCustomerAddressByAdmin directly against StackMateDataStore.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { SUPER_ACTOR } from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  createCustomerAddressByAdmin,
  createCustomerByAdmin,
} from "../src/modules/customers/service.ts";
import { SchemaValidationError } from "../../../packages/contracts/src/common/validator.ts";
import type { AppError } from "../src/shared/errors.ts";

const ADDRESS = {
  address_line_1: "House 12, Road 5",
  address_line_2: null,
  city: "Dhaka",
  state_or_region: null,
  postal_code: "1212",
  country_code: "BD",
  is_default: true,
};

describe("customers — atomic create with address (SPA H-02)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  it("creates customer + address in one call and returns the address", async () => {
    const created = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      {
        name: "Atomic Amina",
        email: "atomic-amina@example.com",
        phone: "01711111111",
        address: ADDRESS,
      },
      "test:h02-atomic-1",
    );
    assert.equal(created.customer_number, "CUST-1001");
    assert.ok(created.address);
    assert.equal(created.address.line1, "House 12, Road 5");
    assert.equal(created.address.city, "Dhaka");
    assert.equal(created.address.postal_code, "1212");
    assert.equal(created.address.is_default, true);
    assert.equal(created.address.customer_id, created.id);
    assert.equal(store.state.customers.length, 1);
    assert.equal(store.state.customer_addresses.length, 1);
    const actions = store.state.audit_logs.map((l) => l.action);
    assert.ok(actions.includes("customers.customer.created"));
    assert.ok(actions.includes("customers.address.created"));
  });

  it("an invalid address 422s (SchemaValidationError) and leaves NO customer behind", async () => {
    await assert.rejects(
      () =>
        createCustomerByAdmin(
          store,
          SUPER_ACTOR,
          {
            name: "Atomic Bad",
            email: "atomic-bad@example.com",
            address: { ...ADDRESS, country_code: "BDD" },
          },
          "test:h02-atomic-2",
        ),
      (err: unknown) => {
        // The route maps this to 422 VALIDATION_ERROR; the service
        // must throw before any write happens.
        assert.ok(err instanceof SchemaValidationError);
        return true;
      },
    );
    assert.equal(store.state.customers.length, 0);
    assert.equal(store.state.customer_addresses.length, 0);
    assert.equal(store.state.audit_logs.length, 0);
  });

  it("no address → exactly today's behavior, address null", async () => {
    const created = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "No Address", email: "no-address@example.com" },
      "test:h02-atomic-3",
    );
    assert.equal(created.address, null);
    assert.equal(store.state.customers.length, 1);
    assert.equal(store.state.customer_addresses.length, 0);
    const actions = store.state.audit_logs.map((l) => l.action);
    assert.deepEqual(actions, ["customers.customer.created"]);
  });

  it("dedupe match attaches the address to the EXISTING customer", async () => {
    const first = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Match Me", email: "match-me@example.com", phone: "01722222222" },
      "test:h02-atomic-4",
    );
    const again = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      {
        name: "Match Me Again",
        email: "match-me@example.com",
        phone: "01733333333",
        address: ADDRESS,
      },
      "test:h02-atomic-5",
    );
    assert.equal(again.id, first.id);
    assert.equal(store.state.customers.length, 1);
    assert.equal(store.state.customer_addresses.length, 1);
    assert.equal(store.state.customer_addresses[0]?.customer_id, first.id);
    assert.ok(again.address);
    const actions = store.state.audit_logs.map((l) => l.action);
    assert.ok(actions.includes("customers.customer.matched"));
    assert.ok(actions.includes("customers.address.created"));
  });

  it("dedupe conflict 409s and creates neither customer nor address", async () => {
    await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Conflict A", email: "conflict-a@example.com", phone: "01744444444" },
      "test:h02-atomic-6",
    );
    await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Conflict B", email: "conflict-b@example.com", phone: "01755555555" },
      "test:h02-atomic-7",
    );
    await assert.rejects(
      () =>
        createCustomerByAdmin(
          store,
          SUPER_ACTOR,
          {
            name: "Conflict Both",
            email: "conflict-a@example.com",
            phone: "01755555555",
            address: ADDRESS,
          },
          "test:h02-atomic-8",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "CUSTOMER_CONTACT_CONFLICT");
        return true;
      },
    );
    assert.equal(store.state.customers.length, 2);
    assert.equal(store.state.customer_addresses.length, 0);
  });

  it("standalone address endpoint still works, incl. default demotion (extraction regression)", async () => {
    const customer = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Standalone", email: "standalone@example.com" },
      "test:h02-atomic-9",
    );
    const first = await createCustomerAddressByAdmin(
      store,
      SUPER_ACTOR,
      customer.id,
      { ...ADDRESS, is_default: true },
      "test:h02-atomic-10",
    );
    const second = await createCustomerAddressByAdmin(
      store,
      SUPER_ACTOR,
      customer.id,
      { ...ADDRESS, city: "Chattogram", is_default: true },
      "test:h02-atomic-11",
    );
    assert.equal(first.is_default, true);
    assert.equal(second.is_default, true);
    // The second default demoted the first.
    const rows = store.state.customer_addresses.filter((a) => a.customer_id === customer.id);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((a) => a.id === first.id)?.is_default, false);
    assert.equal(rows.find((a) => a.id === second.id)?.is_default, true);
  });
});
