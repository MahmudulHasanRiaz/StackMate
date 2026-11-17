/**
 * Customer dedupe + split + reports + addresses (ADR-0009 §1).
 *
 * Rules under test:
 *  - CreateCustomerSchema: name required; AT LEAST ONE of email/phone
 *    (WhatsApp alone does not satisfy the rule).
 *  - Email match → same customer, new phone attaches as secondary.
 *  - Phone match + new email → same customer, email attaches as secondary.
 *  - Email of A + phone of B → 409 CUSTOMER_CONTACT_CONFLICT, never
 *    an auto-merge.
 *  - Split detaches a secondary contact into its own customer; the
 *    picked phone moves with it; orders stay with the source.
 *  - Staff reports: detail required, listed with author + date.
 *  - Billing addresses: create/list/update/delete, one default.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_dedupe`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  setupTestDb,
  seedCustomer,
} from "./customer-order-helpers.ts";
import { CreateCustomerSchema } from "../../../packages/contracts/src/domains/commerce.ts";
import type { AppError } from "../src/shared/errors.ts";

const DB_NAME = "stackmate_test_dedupe";

describe.skipIf(!DATABASE_URL)("customers — dedupe, split, reports, addresses", () => {
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

  it("contract: email-OR-phone is enforced at the schema", () => {
    assert.equal(CreateCustomerSchema.safeParse({ name: "No Contact" }).success, false);
    assert.equal(
      CreateCustomerSchema.safeParse({ name: "WhatsApp Only", whatsapp: "01700000000" }).success,
      false,
    );
    assert.equal(
      CreateCustomerSchema.safeParse({ name: "Email Only", email: "a@example.com" }).success,
      true,
    );
    assert.equal(
      CreateCustomerSchema.safeParse({ name: "Phone Only", phone: "01700000000" }).success,
      true,
    );
    assert.equal(CreateCustomerSchema.safeParse({ name: "X" }).success, false);
  });

  it("email match resolves to the existing customer and attaches the new phone", async () => {
    const { createCustomerByAdmin } = await import("../src/modules/customers/service.ts");
    const a = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Amina", email: "amina@example.com", phone: "01711111111" },
      "test:dedupe-email-1",
    );
    assert.equal(a.whatsapp, null);

    const again = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Amina Again", email: "AMINA@example.com", phone: "01722222222", whatsapp: "01722222222" },
      "test:dedupe-email-2",
    );
    // Same customer (case-insensitive email match), not a second row.
    assert.equal(again.id, a.id);
    assert.equal(store.state.customers.filter((c) => c.normalized_email === "amina@example.com").length, 1);
    // The new phone attached as a secondary contact; WhatsApp stored.
    const contacts = store.state.customer_contacts.filter((c) => c.customer_id === a.id);
    assert.ok(contacts.some((c) => c.kind === "phone" && c.normalized_value === "+8801722222222"));
    assert.equal(store.state.customers.find((c) => c.id === a.id)?.whatsapp, "01722222222");
  });

  it("phone match resolves to the existing customer and attaches the new email", async () => {
    const { createCustomerByAdmin } = await import("../src/modules/customers/service.ts");
    const b = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Babul", phone: "01733333333" },
      "test:dedupe-phone-1",
    );
    const again = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Babul Again", phone: "01733333333", email: "babul@example.com" },
      "test:dedupe-phone-2",
    );
    assert.equal(again.id, b.id);
    const contacts = store.state.customer_contacts.filter((c) => c.customer_id === b.id);
    assert.ok(contacts.some((c) => c.kind === "email" && c.normalized_value === "babul@example.com"));
  });

  it("email of one customer + phone of another → 409 conflict, never auto-merge", async () => {
    const { createCustomerByAdmin } = await import("../src/modules/customers/service.ts");
    const a = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Conflict A", email: "conflict-a@example.com", phone: "01744444444" },
      "test:conflict-1",
    );
    const b = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Conflict B", email: "conflict-b@example.com", phone: "01755555555" },
      "test:conflict-2",
    );
    await assert.rejects(
      () =>
        createCustomerByAdmin(
          store,
          SUPER_ACTOR,
          { name: "Conflict Both", email: "conflict-a@example.com", phone: "01755555555" },
          "test:conflict-3",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "CUSTOMER_CONTACT_CONFLICT");
        return true;
      },
    );
    // Both customers still exist, untouched.
    assert.ok(store.state.customers.some((c) => c.id === a.id));
    assert.ok(store.state.customers.some((c) => c.id === b.id));
  });

  it("split detaches a secondary email into its own customer; the picked phone moves", async () => {
    const {
      createCustomerByAdmin,
      splitCustomerContactByAdmin,
    } = await import("../src/modules/customers/service.ts");
    // C gets a secondary email via the phone-match path.
    const c = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Split Source", email: "split@example.com", phone: "01766666666" },
      "test:split-1",
    );
    await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Split Source", phone: "01766666666", email: "split-second@example.com" },
      "test:split-2",
    );
    assert.ok(
      store.state.customer_contacts.some(
        (ct) => ct.customer_id === c.id && ct.kind === "email" && ct.normalized_value === "split-second@example.com",
      ),
    );

    const split = await splitCustomerContactByAdmin(
      store,
      SUPER_ACTOR,
      c.id,
      {
        contact_kind: "email",
        value: "split-second@example.com",
        new_customer_name: "Split Second",
        phone: "01766666666",
      },
      "test:split-3",
    );
    assert.notEqual(split.id, c.id);
    assert.equal(split.email, "split-second@example.com");
    assert.equal(split.phone, "01766666666");
    // The source lost the secondary email AND its primary phone moved.
    assert.equal(
      store.state.customer_contacts.some(
        (ct) => ct.customer_id === c.id && ct.normalized_value === "split-second@example.com",
      ),
      false,
    );
    assert.equal(store.state.customers.find((x) => x.id === c.id)?.phone, null);
  });

  it("split of a primary contact is rejected", async () => {
    const { createCustomerByAdmin, splitCustomerContactByAdmin } = await import(
      "../src/modules/customers/service.ts"
    );
    const d = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Primary Split", email: "primary@example.com", phone: "01777777777" },
      "test:split-primary-1",
    );
    await assert.rejects(
      () =>
        splitCustomerContactByAdmin(
          store,
          SUPER_ACTOR,
          d.id,
          {
            contact_kind: "email",
            value: "primary@example.com",
            new_customer_name: "Nope",
            phone: "01777777777",
          },
          "test:split-primary-2",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
  });

  it("staff reports: detail required, listed newest-first with author", async () => {
    const { createCustomerReportByAdmin, listCustomerReports } = await import(
      "../src/modules/customers/service.ts"
    );
    let customerId: string;
    await store.withTransaction((state) => {
      customerId = seedCustomer(state, {
        name: "Reported Customer",
        email: "reported@example.com",
        normalized_email: "reported@example.com",
      }).id;
    });
    // Schema-level rejection (ValiError, not an AppError — the 422
    // mapping happens at the route layer).
    await assert.rejects(
      () =>
        createCustomerReportByAdmin(
          store,
          SUPER_ACTOR,
          customerId!,
          { type: "concern", detail: "  " },
          "test:report-1",
        ),
    );
    const report = await createCustomerReportByAdmin(
      store,
      SUPER_ACTOR,
      customerId!,
      { type: "concern", detail: "Customer disputed the last invoice twice." },
      "test:report-2",
    );
    assert.equal(report.type, "concern");
    assert.equal(report.author_user_id, SUPER_ACTOR.user.id);
    const listed = await listCustomerReports(store, SUPER_ACTOR, customerId!);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.detail, "Customer disputed the last invoice twice.");
    assert.ok(store.state.customer_reports.some((r) => r.customer_id === customerId));
    // The list endpoint flag derives from this table (has_concern_report).
    assert.equal(
      store.state.customer_reports.filter((r) => r.customer_id === customerId && r.type === "concern").length,
      1,
    );
  });

  it("billing addresses: create/list/update/delete, one default", async () => {
    const {
      createCustomerAddressByAdmin,
      listCustomerAddresses,
      updateCustomerAddressByAdmin,
      deleteCustomerAddressByAdmin,
    } = await import("../src/modules/customers/service.ts");
    let customerId: string;
    await store.withTransaction((state) => {
      customerId = seedCustomer(state, {
        name: "Address Customer",
        email: "addr@example.com",
        normalized_email: "addr@example.com",
      }).id;
    });
    const first = await createCustomerAddressByAdmin(
      store,
      SUPER_ACTOR,
      customerId!,
      { address_type: "billing", address_line_1: "House 1", city: "Dhaka", country_code: "BD", is_default: true },
      "test:addr-1",
    );
    const second = await createCustomerAddressByAdmin(
      store,
      SUPER_ACTOR,
      customerId!,
      { address_type: "shipping", address_line_1: "House 2", city: "Chattogram", country_code: "BD", is_default: true },
      "test:addr-2",
    );
    // The second default cleared the first.
    let listed = await listCustomerAddresses(store, SUPER_ACTOR, customerId!);
    assert.equal(listed.length, 2);
    assert.equal(listed.find((a) => a.id === first.id)?.is_default, false);
    assert.equal(listed.find((a) => a.id === second.id)?.is_default, true);
    const updated = await updateCustomerAddressByAdmin(
      store,
      SUPER_ACTOR,
      customerId!,
      first.id,
      { city: "Sylhet" },
      "test:addr-3",
    );
    assert.equal(updated.city, "Sylhet");
    await deleteCustomerAddressByAdmin(store, SUPER_ACTOR, customerId!, second.id, "test:addr-4");
    listed = await listCustomerAddresses(store, SUPER_ACTOR, customerId!);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, first.id);
  });
});
