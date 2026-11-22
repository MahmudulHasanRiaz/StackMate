/**
 * API-domain audit fixes — integrations (H-6).
 *
 *  - Registration NEVER auto-verifies the primary domain: it starts
 *    "pending" with a challenge, verified_at null.
 *  - dns_txt verification is REAL: the domain's TXT records are
 *    looked up over DNS-over-HTTPS (Cloudflare dns-json) and the
 *    stored challenge must appear in one of them (quoted / split
 *    character-strings handled). No match → 422, stays pending.
 *    A DNS failure → 503, stays pending (never verifies on error).
 *  - manual_review still works (requires a reviewer_note).
 *  - http_file is still unimplemented → 409, never faked.
 *
 * In-memory (no Postgres). `globalThis.fetch` is stubbed ONLY for
 * the DoH lookups and restored afterwards.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { SUPER_ACTOR, seedProduct } from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  registerIntegratedSiteByAdmin,
  verifySiteDomainByAdmin,
} from "../src/modules/integrations/service.ts";
import type { AppError } from "../src/shared/errors.ts";

const ENCRYPTION_KEY = "test-encryption-key-for-audit-fixes";
const KEY_VERSION = "v1";

describe("integrations — audit fix (H-6)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function registerSite(domain = "shop.example.com") {
    let productId = "";
    await store.withTransaction((state) => {
      productId = seedProduct(state).id;
    });
    const res = await registerIntegratedSiteByAdmin(
      store,
      SUPER_ACTOR,
      {
        name: "Test Shop",
        environment: "staging",
        primary_domain: domain,
        product_ids: [productId],
        allowed_capabilities: ["checkout.create"],
      },
      { encryptionKey: ENCRYPTION_KEY, keyVersion: KEY_VERSION, requestId: "test:site-1" },
    );
    return res.site;
  }

  function stubDoh(answerData: string[] | null, status = 200): void {
    vi.stubGlobal(
      "fetch",
      async (url: string | URL): Promise<Response> => {
        const href = String(url);
        if (!href.startsWith("https://cloudflare-dns.com/dns-query")) {
          throw new Error(`unexpected fetch: ${href}`);
        }
        if (answerData === null) {
          return new Response("upstream error", { status });
        }
        return new Response(
          JSON.stringify({ Answer: answerData.map((data) => ({ data, type: 16 })) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
  }

  it("registration starts the primary domain pending, with a challenge and no verified_at", async () => {
    const site = await registerSite();
    const domain = site.domains[0]!;
    assert.equal(domain.is_primary, true);
    assert.equal(domain.verification_status, "pending");
    assert.equal(domain.verified_at, null);
    assert.ok(domain.verification_challenge?.startsWith("stackmate-site-verification="));
    assert.equal(domain.verification_method, "dns_txt");
  });

  it("dns_txt: a TXT record containing the challenge verifies the domain", async () => {
    const site = await registerSite();
    const domain = site.domains[0]!;
    // TXT answers arrive quoted (and possibly split) — the verifier
    // strips quotes and searches the joined value.
    stubDoh([`"${domain.verification_challenge}"`, '"v=spf1 -all"']);
    const verified = await verifySiteDomainByAdmin(
      store,
      SUPER_ACTOR,
      site.id,
      domain.id,
      { method: "dns_txt" },
      "test:verify-1",
    );
    const row = verified.domains[0]!;
    assert.equal(row.verification_status, "verified");
    assert.ok(row.verified_at);
    assert.ok(
      store.state.audit_logs.some((l) => l.action === "integrations.domain.verified_dns"),
    );
  });

  it("dns_txt: no matching TXT record 422s and the domain stays pending", async () => {
    const site = await registerSite();
    const domain = site.domains[0]!;
    stubDoh(['"v=spf1 -all"', '"google-site-verification=other"']);
    await assert.rejects(
      () =>
        verifySiteDomainByAdmin(
          store,
          SUPER_ACTOR,
          site.id,
          domain.id,
          { method: "dns_txt" },
          "test:verify-2",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, "VALIDATION_ERROR");
        return true;
      },
    );
    const row = store.state.integrated_sites
      .find((s) => s.id === site.id)!
      .domains[0]!;
    assert.equal(row.verification_status, "pending");
    assert.equal(row.verified_at, null);
  });

  it("dns_txt: a DNS failure 503s and never verifies", async () => {
    const site = await registerSite();
    const domain = site.domains[0]!;
    stubDoh(null, 500);
    await assert.rejects(
      () =>
        verifySiteDomainByAdmin(
          store,
          SUPER_ACTOR,
          site.id,
          domain.id,
          { method: "dns_txt" },
          "test:verify-3",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 503);
        assert.equal(err.code, "TEMPORARY_VALIDATION_UNAVAILABLE");
        return true;
      },
    );
    assert.equal(
      store.state.integrated_sites.find((s) => s.id === site.id)!.domains[0]!
        .verification_status,
      "pending",
    );
  });

  it("manual_review with a note verifies; http_file 409s; re-verifying 409s", async () => {
    const site = await registerSite();
    const domain = site.domains[0]!;
    const verified = await verifySiteDomainByAdmin(
      store,
      SUPER_ACTOR,
      site.id,
      domain.id,
      { method: "manual_review", reviewer_note: "Checked DNS by hand with the owner." },
      "test:verify-4",
    );
    assert.equal(verified.domains[0]!.verification_status, "verified");
    assert.ok(
      store.state.audit_logs.some(
        (l) => l.action === "integrations.domain.verified_manually",
      ),
    );

    await assert.rejects(
      () =>
        verifySiteDomainByAdmin(
          store,
          SUPER_ACTOR,
          site.id,
          domain.id,
          { method: "manual_review", reviewer_note: "Again." },
          "test:verify-5",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    const site2 = await registerSite("other.example.com");
    const domain2 = site2.domains[0]!;
    await assert.rejects(
      () =>
        verifySiteDomainByAdmin(
          store,
          SUPER_ACTOR,
          site2.id,
          domain2.id,
          { method: "http_file" },
          "test:verify-6",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
    assert.equal(
      store.state.integrated_sites.find((s) => s.id === site2.id)!.domains[0]!
        .verification_status,
      "pending",
    );
  });
});
