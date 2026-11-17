/**
 * Lead management (ADR-0009 addendum — owner scope 2026-11-17).
 *
 * Rules under test:
 *  - Ingestion validation: at least one of email/phone; valid email.
 *  - Dedupe window (30 days, same site): a repeat capture from the
 *    same site updates the existing lead instead of duplicating it;
 *    a different site creates a separate lead.
 *  - Tracking: every API-ingested lead emits a Lead tracking event
 *    (status queued — Meta CAPI real delivery is a known stub, never
 *    claimed as delivered) + a tracking.meta_capi.dispatch outbox
 *    entry, on CREATE only; dedupe-updates emit nothing new; manual
 *    leads (no site) emit nothing.
 *  - Transitions are enforced (new → converted is 409); lost → new
 *    reopens.
 *  - Convert resolves/creates the customer via the §1 dedupe rules
 *    and does NOT mark the lead converted — that happens when the
 *    order is created with lead_id.
 *
 * Requires DATABASE_URL to a LOCAL test Postgres; own fresh database
 * `stackmate_test_leads`, dropped afterwards.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  setupTestDb,
  seedCustomer,
  seedSite,
} from "./customer-order-helpers.ts";
import type { AppError } from "../src/shared/errors.ts";

const DB_NAME = "stackmate_test_leads";

describe.skipIf(!DATABASE_URL)("leads", () => {
  let store: Awaited<ReturnType<typeof setupTestDb>>["store"];
  let cleanup: () => Promise<void>;
  let siteAId = "";
  let siteBId = "";

  beforeAll(async () => {
    const setup = await setupTestDb(DB_NAME);
    store = setup.store;
    cleanup = setup.cleanup;
    await store.withTransaction((state) => {
      siteAId = seedSite(state).id;
      siteBId = seedSite(state).id;
    });
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("ingestion validation: contact rule + email format", async () => {
    const { ingestLead } = await import("../src/modules/leads/service.ts");
    const site = store.state.integrated_sites.find((s) => s.id === siteAId)!;
    // Schema-level rejections (ValiError, not AppError — the 422
    // mapping happens at the route layer).
    await assert.rejects(() =>
      ingestLead(store, site, { name: "No Contact" }),
    );
    await assert.rejects(() =>
      ingestLead(store, site, { name: "Bad Email", email: "not-an-email" }),
    );
  });

  it("dedupe window: same site repeats update; other sites create separately; tracking once", async () => {
    const { ingestLead } = await import("../src/modules/leads/service.ts");
    const siteA = store.state.integrated_sites.find((s) => s.id === siteAId)!;
    const siteB = store.state.integrated_sites.find((s) => s.id === siteBId)!;

    const first = await ingestLead(store, siteA, {
      name: "Lead One",
      email: "lead-one@example.com",
      phone: "01788888888",
      interest: "WordPress plugin",
      utm_source: "facebook",
      utm_campaign: "launch",
      message: "First message.",
    });
    assert.equal(first.created, true);
    assert.match(first.lead.lead_number, /^LEAD-/);

    // Repeat from the SAME site within the window → update, not duplicate.
    const repeat = await ingestLead(store, siteA, {
      name: "Lead One",
      email: "lead-one@example.com",
      message: "Second message — updated.",
    });
    assert.equal(repeat.created, false);
    assert.equal(repeat.lead.id, first.lead.id);
    assert.equal(repeat.lead.message, "Second message — updated.");

    // Same contact from a DIFFERENT site → a separate lead.
    const otherSite = await ingestLead(store, siteB, {
      name: "Lead One",
      email: "lead-one@example.com",
      message: "From the other site.",
    });
    assert.equal(otherSite.created, true);
    assert.notEqual(otherSite.lead.id, first.lead.id);

    // Tracking: exactly one Lead event per created lead, queued (not
    // claimed delivered — CAPI delivery is a known stub).
    const leadEvents = store.state.tracking_events.filter((e) => e.event_name === "Lead");
    assert.equal(leadEvents.length, 2);
    assert.ok(leadEvents.every((e) => e.status === "queued"));
    assert.ok(
      leadEvents.some((e) => e.event_id === `lead_${first.lead.id}` && e.integrated_site_id === siteAId),
    );
    assert.equal(
      store.state.outbox_events.filter((e) => e.event_type === "tracking.meta_capi.dispatch").length,
      2,
    );
  });

  it("manual create emits no tracking event; transitions enforced", async () => {
    const { createLeadByAdmin, transitionLeadByAdmin } = await import(
      "../src/modules/leads/service.ts"
    );
    const lead = await createLeadByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Manual Lead", phone: "01799999999", interest: "ERP" },
      "test:lead-manual-1",
    );
    assert.equal(lead.status, "new");
    assert.equal(lead.source_site_id, null);
    assert.equal(
      store.state.tracking_events.filter((e) => e.event_name === "Lead" && e.event_id === `lead_${lead.id}`).length,
      0,
    );
    await assert.rejects(
      () => transitionLeadByAdmin(store, SUPER_ACTOR, lead.id, { status: "converted" }, "test:lead-manual-2"),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "INVALID_LEAD_TRANSITION");
        return true;
      },
    );
    const contacted = await transitionLeadByAdmin(store, SUPER_ACTOR, lead.id, { status: "contacted" }, "test:lead-manual-3");
    assert.equal(contacted.status, "contacted");
    const qualified = await transitionLeadByAdmin(store, SUPER_ACTOR, lead.id, { status: "qualified" }, "test:lead-manual-4");
    assert.equal(qualified.status, "qualified");
    const lost = await transitionLeadByAdmin(store, SUPER_ACTOR, lead.id, { status: "lost" }, "test:lead-manual-5");
    assert.equal(lost.status, "lost");
    const reopened = await transitionLeadByAdmin(store, SUPER_ACTOR, lead.id, { status: "new" }, "test:lead-manual-6");
    assert.equal(reopened.status, "new");
  });

  it("convert resolves the existing customer via dedupe and leaves the lead unconverted", async () => {
    const { createLeadByAdmin, convertLeadByAdmin } = await import(
      "../src/modules/leads/service.ts"
    );
    let existingId = "";
    await store.withTransaction((state) => {
      existingId = seedCustomer(state, {
        name: "Existing Customer",
        email: "convert@example.com",
        normalized_email: "convert@example.com",
        phone: "01700000001",
        normalized_phone: "01700000001",
      }).id;
    });
    const lead = await createLeadByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Convert Me", email: "convert@example.com", phone: "01700000002", interest: "Shopify app" },
      "test:lead-convert-1",
    );
    const converted = await convertLeadByAdmin(store, SUPER_ACTOR, lead.id, "test:lead-convert-2");
    // Dedupe: the email matched the existing customer — no duplicate.
    assert.equal(converted.customer.id, existingId);
    // The new phone attached as a secondary contact of that customer.
    assert.ok(
      store.state.customer_contacts.some(
        (c) => c.customer_id === existingId && c.kind === "phone" && c.normalized_value === "+8801700000002",
      ),
    );
    // The lead itself is NOT marked converted yet — the order creation
    // with lead_id does that (converting must not delete history).
    const after = store.state.leads.find((l) => l.id === lead.id)!;
    assert.equal(after.status, "new");
    assert.equal(after.converted_at, null);
    assert.equal(after.converted_customer_id, null);
    assert.equal(after.converted_order_id, null);
  });
});
