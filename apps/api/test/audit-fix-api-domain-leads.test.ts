/**
 * API-domain audit fixes — leads (F-08, F-09, M-14c).
 *
 *  - F-08: every site-attributed capture emits a Lead tracking event
 *    — INCLUDING 30-day dedupe-hits (each capture gets its own
 *    per-capture event id / outbox key). Manual (site-less) leads
 *    emit nothing — the tracking_events FK forbids it, and the module
 *    now says so honestly.
 *  - F-09: updateLeadByAdmin enforces at-least-one-contact and a
 *    dedupe conflict check (excluding the lead itself).
 *  - M-14c: lead ingestion writes an audit row.
 *
 * In-memory (no Postgres).
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { SUPER_ACTOR, seedSite } from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  createLeadByAdmin,
  ingestLead,
  updateLeadByAdmin,
} from "../src/modules/leads/service.ts";
import type { AppError } from "../src/shared/errors.ts";

describe("leads — audit fixes (F-08, F-09, M-14c)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  async function seedSiteRow() {
    let siteId = "";
    await store.withTransaction((state) => {
      siteId = seedSite(state).id;
    });
    return store.state.integrated_sites.find((s) => s.id === siteId)!;
  }

  it("F-08: a dedupe-hit capture emits its own Lead tracking event (distinct ids)", async () => {
    const site = await seedSiteRow();
    const body = { name: "Lead One", email: "lead-one@example.com", interest: "ERP" };
    const first = await ingestLead(store, site, body, "test:lead-1");
    assert.equal(first.created, true);
    const second = await ingestLead(store, site, { ...body, interest: "CRM" }, "test:lead-2");
    assert.equal(second.created, false);
    assert.equal(second.lead.id, first.lead.id);
    assert.equal(store.state.leads.length, 1);

    const tracks = store.state.tracking_events.filter((t) => t.event_name === "Lead");
    assert.equal(tracks.length, 2);
    assert.deepEqual(
      tracks.map((t) => t.event_id).sort(),
      [`lead_${first.lead.id}`, `lead_${first.lead.id}_c2`].sort(),
    );
    const outbox = store.state.outbox_events.filter(
      (e) => e.event_type === "tracking.meta_capi.dispatch",
    );
    assert.equal(outbox.length, 2);
    assert.deepEqual(
      outbox.map((e) => e.event_key).sort(),
      [`meta_capi.lead:${first.lead.id}`, `meta_capi.lead:${first.lead.id}:c2`].sort(),
    );
  });

  it("F-08: a manual (site-less) lead emits no tracking event", async () => {
    const lead = await createLeadByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Manual Lead", email: "manual-lead@example.com" },
      "test:lead-3",
    );
    assert.equal(lead.source_site_id, null);
    assert.equal(store.state.tracking_events.length, 0);
    assert.equal(store.state.outbox_events.length, 0);
  });

  it("F-09: clearing both contacts on update 422s and changes nothing", async () => {
    const site = await seedSiteRow();
    const lead = await createLeadByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Clear Me", email: "clear-me@example.com", source_site_id: site.id },
      "test:lead-4",
    );
    await assert.rejects(
      () =>
        updateLeadByAdmin(
          store,
          SUPER_ACTOR,
          lead.id,
          { email: null, phone: null },
          "test:lead-5",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "VALIDATION_ERROR");
        return true;
      },
    );
    const after = store.state.leads.find((l) => l.id === lead.id)!;
    assert.equal(after.email, "clear-me@example.com");
  });

  it("F-09: moving a contact onto another lead's contact 409s; touching the lead itself does not", async () => {
    const site = await seedSiteRow();
    const a = await createLeadByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Lead A", email: "lead-a@example.com", source_site_id: site.id },
      "test:lead-6",
    );
    const b = await createLeadByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Lead B", email: "lead-b@example.com", source_site_id: site.id },
      "test:lead-7",
    );
    await assert.rejects(
      () =>
        updateLeadByAdmin(store, SUPER_ACTOR, b.id, { email: "lead-a@example.com" }, "test:lead-8"),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "CONFLICT");
        return true;
      },
    );
    // Updating B's own email to its current value (self) is fine.
    const kept = await updateLeadByAdmin(
      store,
      SUPER_ACTOR,
      b.id,
      { email: "lead-b@example.com", notes: "still mine" },
      "test:lead-9",
    );
    assert.equal(kept.email, "lead-b@example.com");
    assert.equal(kept.notes, "still mine");
    assert.equal(a.email, "lead-a@example.com");
  });

  it("M-14c: ingestion writes an audit row attributed to the site", async () => {
    const site = await seedSiteRow();
    const res = await ingestLead(
      store,
      site,
      { name: "Audit Lead", email: "audit-lead@example.com" },
      "test:lead-10",
    );
    const row = store.state.audit_logs.find((l) => l.action === "leads.lead.ingested");
    assert.ok(row);
    assert.equal(row?.actor_type, "integration");
    assert.equal(row?.integrated_site_id, site.id);
    assert.equal(row?.resource_id, res.lead.id);
    assert.equal(row?.request_id, "test:lead-10");
  });
});
