/**
 * Audit Batch E — PRD gaps, service layer (2026-11-25 fix plan).
 *
 * Covers the service functions this batch adds (routes are Worker A2's;
 * the drain-loop wiring for E-01 is Worker B's — here the adapter is
 * tested in isolation with an injected fetch, never a real Meta call):
 *
 *  - E-01: Meta CAPI adapter — honest delivery labelling (delivered only
 *    on 2xx + events_received >= 1), pinned Graph version, bounded
 *    retry (no retry on 4xx), PII hashing, token never in diagnostics.
 *  - E-03: license activation transfer (audited, seat-preserving).
 *  - E-04: webhook secret rotation (new secret shown once).
 *  - E-05: signing-key list / rotate / revoke wrappers (no private key
 *    ever returned).
 *  - E-06: S2S webhook test per site (reuses the admin test transport).
 *  - E-08: save-order-as-package + entitlement-snapshot view.
 *  - E-13: product logo_asset_id (create + update + clear).
 *  - E-16: payment provider / method delete guards (history preserved).
 *  - E-17: webhook endpoint edit (secret untouched).
 *  - E-18: tracking test event through the normal ingest pipeline.
 *
 * E-10 is verification-only (audit-log resource filter already works —
 * see the plan note; no new API) and is asserted by code inspection,
 * not by a test here. E-23 is covered by running
 * `node scripts/generate-openapi.mjs` + `node scripts/check-openapi.mjs`.
 *
 * In-memory store only — no Postgres, no network (fetch is stubbed or
 * injected wherever a test needs it).
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SUPER_ACTOR } from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  computeInstallationIdHash,
  computeLicenseKeyVerifier,
  encryptSecretAtRest,
  generateFormattedLicenseKey,
  sha256Hex,
} from "../src/platform/crypto/index.ts";
import { deliverMetaCapiEvent, META_CAPI_MAX_ATTEMPTS } from "../src/modules/tracking/capi.ts";
import { sendTrackingTestEvent } from "../src/modules/tracking/service.ts";
import {
  activateLicenseInstallation,
  createManualLicenseGrantByAdmin,
  deactivateLicenseInstallation,
  transferActivation,
  listSigningKeysByAdmin,
  rotateSigningKeyByAdmin,
  revokeSigningKeyByAdmin,
  validateLicenseInstallation,
} from "../src/modules/licensing/service.ts";
import {
  registerWebhookEndpointByAdmin,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  testWebhookForSite,
} from "../src/modules/webhooks/service.ts";
import {
  createProduct,
  updateProductMetadata,
  saveOrderAsPackage,
  getOrderEntitlementSnapshot,
} from "../src/modules/catalog/service.ts";
import {
  createPaymentProviderByAdmin,
  createPaymentMethodByAdmin,
  deletePaymentProviderByAdmin,
  deletePaymentMethodByAdmin,
} from "../src/modules/payments/service.ts";
import type { AppError } from "../src/shared/errors.ts";

const ENCRYPTION_KEY = "test-encryption-key-for-batch-e";
const KEY_VERSION = "v1";
const NOW = new Date().toISOString();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Assert an async call rejects with an AppError of the given code/status. */
async function assertAppError(
  promise: Promise<unknown>,
  code: string,
  status: number
): Promise<void> {
  await assert.rejects(promise, (err: AppError) => {
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
    return true;
  });
}

describe("Batch E — Meta CAPI adapter (E-01)", () => {
  const pixelId = "1234567890";
  let group: {
    id: string;
    integrated_site_id: string;
    provider: "meta";
    label: string | null;
    pixel_id: string;
    access_token_ciphertext: string;
    encryption_key_version: string;
    test_event_code: string | null;
    enabled_events: string[];
    status: "enabled";
    created_at: string;
    updated_at: string;
    rotated_at: string | null;
  };

  beforeEach(() => {
    const id = randomUUID();
    group = {
      id,
      integrated_site_id: randomUUID(),
      provider: "meta",
      label: "Test pixel",
      pixel_id: pixelId,
      access_token_ciphertext: encryptSecretAtRest(
        "meta-test-token-123",
        ENCRYPTION_KEY,
        KEY_VERSION,
        `tracking_configurations:${id}`
      ),
      encryption_key_version: KEY_VERSION,
      test_event_code: "TEST-CODE-1",
      enabled_events: ["Lead", "Purchase"],
      status: "enabled",
      created_at: NOW,
      updated_at: NOW,
      rotated_at: null,
    };
  });

  const baseEvent = {
    event_name: "Lead",
    event_id: "evt_test_1",
    event_time: NOW,
    event_source_url: "https://test.example.com/lead",
    action_source: "website",
    user_data: { email: "Test@Example.com", fbp: "fb.1.1.abc" },
  };

  it("delivers on 2xx + events_received >= 1, hashes PII, pins the Graph version, never leaks the token", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const result = await deliverMetaCapiEvent(
      { META_GRAPH_API_VERSION: "v21.0", ENCRYPTION_KEY_V1: ENCRYPTION_KEY },
      group,
      baseEvent,
      {
        fetchFn: (async (url: string | URL, init?: RequestInit) => {
          seenUrl = String(url);
          seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return jsonResponse({ events_received: 1, fbtrace_id: "trace-1" });
        }) as typeof fetch,
        sleepMs: async () => {},
      }
    );
    assert.equal(result.delivered, true);
    assert.equal(result.status, "delivered");
    assert.equal(result.attempts, 1);
    assert.equal(result.events_received, 1);
    assert.equal(result.fbtrace_id, "trace-1");
    assert.ok(seenUrl.startsWith(`https://graph.facebook.com/v21.0/${pixelId}/events`));
    // The token travels to Meta as the documented `access_token` query
    // parameter (server-to-server only) — it must NEVER appear in
    // diagnostics, audit rows, or logs instead.
    assert.ok(seenUrl.includes("access_token="));
    assert.ok(!JSON.stringify(result.diagnostics).includes("meta-test-token-123"));
    const data = (seenBody.data as Array<Record<string, unknown>>)[0]!;
    assert.equal(data.event_name, "Lead");
    assert.equal(
      (data.user_data as Record<string, string>).em,
      sha256Hex("test@example.com")
    );
    assert.equal((data.user_data as Record<string, string>).fbp, "fb.1.1.abc");
    assert.equal(seenBody.test_event_code, "TEST-CODE-1");
  });

  it("2xx with zero events received is 'rejected', never delivered", async () => {
    const result = await deliverMetaCapiEvent(
      { META_GRAPH_API_VERSION: "v21.0", ENCRYPTION_KEY_V1: ENCRYPTION_KEY },
      group,
      baseEvent,
      {
        fetchFn: (async () =>
          jsonResponse({ events_received: 0, messages: ["No events were received."] })) as typeof fetch,
        sleepMs: async () => {},
      }
    );
    assert.equal(result.delivered, false);
    assert.equal(result.status, "rejected");
    assert.equal(result.attempts, 1);
  });

  it("4xx is rejected without retry", async () => {
    let calls = 0;
    const result = await deliverMetaCapiEvent(
      { META_GRAPH_API_VERSION: "v21.0", ENCRYPTION_KEY_V1: ENCRYPTION_KEY },
      group,
      baseEvent,
      {
        fetchFn: (async () => {
          calls += 1;
          return jsonResponse(
            { error: { message: "Invalid OAuth access token.", code: 190 } },
            400
          );
        }) as typeof fetch,
        sleepMs: async () => {},
      }
    );
    assert.equal(result.delivered, false);
    assert.equal(result.status, "rejected");
    assert.equal(calls, 1);
    assert.equal(result.attempts, 1);
    assert.match(result.error ?? "", /Invalid OAuth access token/);
  });

  it("transient 500 retries with bounded backoff, then delivers", async () => {
    let calls = 0;
    const result = await deliverMetaCapiEvent(
      { META_GRAPH_API_VERSION: "v21.0", ENCRYPTION_KEY_V1: ENCRYPTION_KEY },
      group,
      baseEvent,
      {
        fetchFn: (async () => {
          calls += 1;
          return calls === 1
            ? jsonResponse({ error: { message: "Temporary failure.", code: 1 } }, 500)
            : jsonResponse({ events_received: 1 });
        }) as typeof fetch,
        sleepMs: async () => {},
      }
    );
    assert.equal(result.delivered, true);
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
  });

  it("network failure retries up to the bound, then 'failed'", async () => {
    let calls = 0;
    const result = await deliverMetaCapiEvent(
      { META_GRAPH_API_VERSION: "v21.0", ENCRYPTION_KEY_V1: ENCRYPTION_KEY },
      group,
      baseEvent,
      {
        fetchFn: (async () => {
          calls += 1;
          throw new Error("fetch failed");
        }) as typeof fetch,
        sleepMs: async () => {},
      }
    );
    assert.equal(result.delivered, false);
    assert.equal(result.status, "failed");
    assert.equal(calls, META_CAPI_MAX_ATTEMPTS);
  });

  it("disabled group is 'skipped' with no fetch at all", async () => {
    let calls = 0;
    const result = await deliverMetaCapiEvent(
      { META_GRAPH_API_VERSION: "v21.0", ENCRYPTION_KEY_V1: ENCRYPTION_KEY },
      { ...group, status: "disabled" as const },
      baseEvent,
      {
        fetchFn: (async () => {
          calls += 1;
          return jsonResponse({ events_received: 1 });
        }) as typeof fetch,
        sleepMs: async () => {},
      }
    );
    assert.equal(result.delivered, false);
    assert.equal(result.status, "skipped");
    assert.equal(calls, 0);
    assert.equal(result.attempts, 0);
  });

  it("converts value_minor to Meta value (major units) and drops value_minor", async () => {
    let seenBody: Record<string, unknown> = {};
    await deliverMetaCapiEvent(
      { META_GRAPH_API_VERSION: "v21.0", ENCRYPTION_KEY_V1: ENCRYPTION_KEY },
      group,
      {
        ...baseEvent,
        event_name: "Purchase",
        custom_data: { value_minor: 150000, currency: "BDT" },
      },
      {
        fetchFn: (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return jsonResponse({ events_received: 1 });
        }) as typeof fetch,
        sleepMs: async () => {},
      }
    );
    const data = (seenBody.data as Array<Record<string, unknown>>)[0]!;
    assert.equal((data.custom_data as Record<string, unknown>).value, 1500);
    assert.equal((data.custom_data as Record<string, unknown>).value_minor, undefined);
    assert.equal((data.custom_data as Record<string, unknown>).currency, "BDT");
  });
});

describe("Batch E — license transfer + signing keys (E-03, E-05)", () => {
  let store: StackMateDataStore;
  let licenseId: string;
  let activationId: string;

  beforeEach(() => {
    store = new StackMateDataStore();
    licenseId = randomUUID();
    activationId = randomUUID();
    const installHash = computeInstallationIdHash(licenseId, "install-old-1");
    store.state.licenses.push({
      id: licenseId,
      license_number: "LIC-40001",
      product_id: randomUUID(),
      customer_id: randomUUID(),
      source_order_item_id: null,
      subscription_id: null,
      license_key_hash: "hash",
      license_key_hint: "hint",
      issued_raw_key_once: "seed-only-not-a-real-key",
      status: "active",
      activation_limit: 2,
      valid_from: NOW,
      expires_at: null,
      grace_until: null,
      current_entitlement_snapshot_id: randomUUID(),
      snapshots: [],
      activations: [
        {
          id: activationId,
          license_id: licenseId,
          installation_id_hash: installHash,
          domain_normalized: "old.example.com",
          environment: "production",
          status: "active",
          activated_at: NOW,
          last_seen_at: NOW,
          deactivated_at: null,
          metadata: {},
          created_at: NOW,
        },
      ],
      issued_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it("E-03: transfer deactivates the source and activates the target in one transaction, audited", async () => {
    const result = await transferActivation(
      store,
      SUPER_ACTOR,
      licenseId,
      activationId,
      { installation_id: "install-new-1", site_url: "https://new.example.com", reason: "New laptop" },
      "test:transfer-1"
    );
    assert.equal(result.from_activation.status, "deactivated");
    assert.ok(result.from_activation.deactivated_at);
    assert.equal(result.to_activation.status, "active");
    assert.equal(result.to_activation.domain_normalized, "new.example.com");
    assert.notEqual(result.to_activation.id, activationId);
    const license = store.state.licenses.find((l) => l.id === licenseId)!;
    assert.equal(license.activations.filter((a) => a.status === "active").length, 1);
    assert.ok(
      store.state.audit_logs.some((l) => l.action === "licensing.activation.transferred")
    );
  });

  it("E-03 (integration): the SPA's new_* aliases (new_installation_id, new_domain_normalized) transfer the same way", async () => {
    // The transfer dialog sends { new_installation_id,
    // new_domain_normalized, reason } — the service must accept those
    // aliases, not only installation_id / site_url.
    const result = await transferActivation(
      store,
      SUPER_ACTOR,
      licenseId,
      activationId,
      { new_installation_id: "install-new-1", new_domain_normalized: "new.example.com", reason: "New laptop" },
      "test:transfer-alias"
    );
    assert.equal(result.from_activation.status, "deactivated");
    assert.equal(result.to_activation.status, "active");
    assert.equal(result.to_activation.domain_normalized, "new.example.com");
    assert.notEqual(result.to_activation.id, activationId);
  });

  it("E-03: same installation, inactive source, and active target are all 409", async () => {
    await assertAppError(
      transferActivation(store, SUPER_ACTOR, licenseId, activationId, { installation_id: "install-old-1" }, "t"),
      "CONFLICT",
      409
    );
    await transferActivation(store, SUPER_ACTOR, licenseId, activationId, { installation_id: "install-new-1" }, "t");
    await assertAppError(
      transferActivation(store, SUPER_ACTOR, licenseId, activationId, { installation_id: "install-new-2" }, "t"),
      "CONFLICT",
      409
    );
  });

  it("E-03: transfer to a previously-deactivated installation reactivates it (no second seat)", async () => {
    const first = await transferActivation(store, SUPER_ACTOR, licenseId, activationId, { installation_id: "install-new-1" }, "t");
    const back = await transferActivation(store, SUPER_ACTOR, licenseId, first.to_activation.id, { installation_id: "install-old-1" }, "t");
    assert.equal(back.to_activation.id, activationId);
    const license = store.state.licenses.find((l) => l.id === licenseId)!;
    assert.equal(license.activations.length, 2);
    assert.equal(license.activations.filter((a) => a.status === "active").length, 1);
  });

  it("E-05: list returns the active key id + public JWKs only", () => {
    const listed = listSigningKeysByAdmin(store, SUPER_ACTOR);
    assert.equal(listed.active_key_id, store.activeSigningKeyId);
    assert.equal(listed.keys.length, 1);
    assert.equal((listed.keys[0] as Record<string, unknown>).kid, store.activeSigningKeyId);
    assert.equal((listed.keys[0] as Record<string, unknown>).privateKeyPem, undefined);
  });

  it("E-05: rotate makes the new key active, revokes the old one, never returns private material", async () => {
    const previous = store.activeSigningKeyId;
    const rotated = await rotateSigningKeyByAdmin(store, SUPER_ACTOR, {}, "test:rotate-1");
    assert.notEqual(rotated.active_key_id, previous);
    assert.equal(rotated.previous_key_id, previous);
    assert.equal(rotated.public_key.kid, rotated.active_key_id);
    assert.equal((rotated as Record<string, unknown>).privateKeyPem, undefined);
    assert.equal(store.activeSigningKeyId, rotated.active_key_id);
    assert.ok(store.state.audit_logs.some((l) => l.action === "licensing.signing_key.rotated"));

    const revoked = await revokeSigningKeyByAdmin(store, SUPER_ACTOR, previous, "test:revoke-1");
    assert.equal(revoked.revoked_key_id, previous);
    assert.ok(store.state.audit_logs.some((l) => l.action === "licensing.signing_key.revoked"));

    await assertAppError(
      revokeSigningKeyByAdmin(store, SUPER_ACTOR, rotated.active_key_id, "t"),
      "CONFLICT",
      409
    );
    await assertAppError(
      revokeSigningKeyByAdmin(store, SUPER_ACTOR, "sm-ed25519-nope", "t"),
      "NOT_FOUND",
      404
    );
  });
});

describe("Batch E — webhooks: rotate / edit / S2S test (E-04, E-17, E-06)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedEndpoint(siteId?: string) {
    const { endpoint } = await registerWebhookEndpointByAdmin(
      store,
      SUPER_ACTOR,
      {
        url: "https://example.com/hook",
        description: "Batch E endpoint",
        subscribed_events: ["order.created"],
        ...(siteId ? { integrated_site_id: siteId } : {}),
      },
      { encryptionKey: ENCRYPTION_KEY, keyVersion: KEY_VERSION, requestId: "test:hook" }
    );
    return endpoint;
  }

  function stubFetch(targetStatus = 200): void {
    vi.stubGlobal(
      "fetch",
      async (url: string | URL): Promise<Response> => {
        const href = String(url);
        if (href.startsWith("https://cloudflare-dns.com/dns-query")) {
          return jsonResponse({ Answer: [{ data: "93.184.216.34", type: 1 }] });
        }
        return new Response("ok", { status: targetStatus });
      }
    );
  }

  it("E-04: rotate returns the new secret once, changes the key id, keeps the URL, audits", async () => {
    const endpoint = await seedEndpoint();
    const before = store.state.webhook_endpoints.find((e) => e.id === endpoint.id)!;
    const beforeCipher = before.secret_ciphertext;
    const rotated = await rotateWebhookSecret(store, SUPER_ACTOR, endpoint.id, {
      encryptionKey: ENCRYPTION_KEY,
      keyVersion: KEY_VERSION,
      requestId: "test:rotate",
    });
    assert.ok(rotated.raw_signing_secret_once.startsWith("whsec_"));
    assert.notEqual(rotated.endpoint.secret_key_id, endpoint.secret_key_id);
    assert.equal(rotated.previous_key_id, endpoint.secret_key_id);
    assert.equal(rotated.endpoint.url, "https://example.com/hook");
    assert.equal((rotated.endpoint as Record<string, unknown>).secret_ciphertext, undefined);
    assert.notEqual(before.secret_ciphertext, beforeCipher);
    assert.ok(
      store.state.audit_logs.some((l) => l.action === "webhooks.endpoint.secret_rotated")
    );
    // A second rotation works on the already-rotated endpoint.
    const rotated2 = await rotateWebhookSecret(store, SUPER_ACTOR, endpoint.id, {
      encryptionKey: ENCRYPTION_KEY,
      keyVersion: KEY_VERSION,
      requestId: "test:rotate-2",
    });
    assert.notEqual(rotated2.raw_signing_secret_once, rotated.raw_signing_secret_once);
  });

  it("E-17: edit changes URL + events, leaves the secret untouched; empty body is 422", async () => {
    const endpoint = await seedEndpoint();
    const beforeCipher = store.state.webhook_endpoints.find((e) => e.id === endpoint.id)!
      .secret_ciphertext;
    const updated = await updateWebhookEndpoint(store, SUPER_ACTOR, endpoint.id, {
      url: "https://example.com/hook-v2",
      subscribed_events: ["order.created", "order.completed"],
    }, { requestId: "test:edit" });
    assert.equal(updated.url, "https://example.com/hook-v2");
    assert.deepEqual(updated.subscribed_events, ["order.created", "order.completed"]);
    assert.equal(
      store.state.webhook_endpoints.find((e) => e.id === endpoint.id)!.secret_ciphertext,
      beforeCipher
    );
    assert.ok(store.state.audit_logs.some((l) => l.action === "webhooks.endpoint.updated"));
    await assertAppError(
      updateWebhookEndpoint(store, SUPER_ACTOR, endpoint.id, {}, { requestId: "t" }),
      "VALIDATION_ERROR",
      422
    );
    await assertAppError(
      updateWebhookEndpoint(store, SUPER_ACTOR, endpoint.id, { url: "not-a-url" }, { requestId: "t" }),
      "VALIDATION_ERROR",
      422
    );
  });

  it("E-06: S2S webhook test delivers to the site's active endpoints, audited as integration", async () => {
    const siteId = randomUUID();
    store.state.integrated_sites.push({
      id: siteId,
      site_key: "test-site",
      name: "Test Site",
      environment: "staging",
      status: "active",
      api_version: "v1",
      allowed_capabilities: ["webhooks.test"],
      product_ids: [],
      domains: [],
      created_at: NOW,
      updated_at: NOW,
    });
    await seedEndpoint(siteId);
    stubFetch(200);
    const result = await testWebhookForSite(store, "test-site", {
      encryptionKey: ENCRYPTION_KEY,
    });
    assert.equal(result.site_id, siteId);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.delivered, true);
    assert.equal(result.results[0]!.http_status, 200);
    const audit = store.state.audit_logs.find(
      (l) => l.action === "webhooks.endpoint.tested_by_site"
    );
    assert.ok(audit);
    assert.equal(audit!.actor_type, "integration");
    assert.equal(audit!.integrated_site_id, siteId);
  });

  it("E-06: site with no active endpoint is 404; unknown site is 404", async () => {
    await assertAppError(
      testWebhookForSite(store, "no-such-site", { encryptionKey: ENCRYPTION_KEY }),
      "NOT_FOUND",
      404
    );
    const siteId = randomUUID();
    store.state.integrated_sites.push({
      id: siteId,
      site_key: "empty-site",
      name: "Empty Site",
      environment: "staging",
      status: "active",
      api_version: "v1",
      allowed_capabilities: ["webhooks.test"],
      product_ids: [],
      domains: [],
      created_at: NOW,
      updated_at: NOW,
    });
    await assertAppError(
      testWebhookForSite(store, "empty-site", { encryptionKey: ENCRYPTION_KEY }),
      "NOT_FOUND",
      404
    );
  });
});

describe("Batch E — catalog: save-as-package, snapshot view, logo (E-08, E-13)", () => {
  let store: StackMateDataStore;
  let productId: string;
  let assetId: string;

  function seedProductAndFeatures() {
    productId = randomUUID();
    store.state.products.push({
      id: productId,
      code: "TESTPROD",
      slug: "testprod",
      name: "Test Product",
      description: null,
      product_type: "wordpress_plugin",
      fulfillment_type: "software_license",
      distribution_channels: ["wordpress"],
      default_activation_limit: 1,
      offline_grace_hours: 72,
      status: "active",
      website_url: null,
      documentation_url: null,
      created_by_user_id: SUPER_ACTOR.user.id,
      created_at: NOW,
      updated_at: NOW,
    });
    const featureIds: string[] = [];
    for (const [key, valueType] of [["seats", "limit"], ["support", "boolean"]] as const) {
      const id = randomUUID();
      featureIds.push(id);
      store.state.product_features.push({
        id,
        product_id: productId,
        feature_key: key,
        name: key,
        description: null,
        value_type: valueType,
        unit: null,
        default_value: null,
        status: "active",
        created_at: NOW,
        updated_at: NOW,
      });
    }
    return featureIds;
  }

  function seedOrder(itemProductIds: string[], withSnapshot = true): string {
    const orderId = randomUUID();
    const items = itemProductIds.map((pid, index) => ({
      id: randomUUID(),
      order_id: orderId,
      product_id: pid,
      package_id: null,
      package_version_id: null,
      package_price_id: null,
      item_kind: "custom" as const,
      fulfillment_type_snapshot: "software_license",
      product_name_snapshot: `Product ${index}`,
      package_name_snapshot: null,
      package_version_snapshot: null,
      price_kind_snapshot: "one_time" as const,
      interval_unit_snapshot: null,
      interval_count_snapshot: null,
      activation_limit_snapshot: 1,
      quantity: 1,
      unit_amount_minor: 100000,
      line_subtotal_minor: 100000,
      line_discount_minor: 0,
      line_tax_minor: 0,
      line_total_minor: 100000,
      currency_code: "BDT",
      entitlement_snapshot: {
        id: randomUUID(),
        order_item_id: "",
        source_type: "custom_offer" as const,
        source_package_version_id: null,
        schema_version: 1,
        snapshot_hash: "hash",
        items: withSnapshot
          ? [
              { feature_key_snapshot: "seats", value_type_snapshot: "limit" as const, entitlement_value: { value_type: "limit", value: 5 }, unit_snapshot: null },
              { feature_key_snapshot: "support", value_type_snapshot: "boolean" as const, entitlement_value: { value_type: "boolean", value: true }, unit_snapshot: null },
            ]
          : [],
        created_at: NOW,
      },
      created_at: NOW,
    }));
    for (const item of items) item.entitlement_snapshot.order_item_id = item.id;
    store.state.orders.push({
      id: orderId,
      order_number: "ORD-10001",
      public_reference: "ord_test_1",
      customer_id: randomUUID(),
      source: "admin",
      integrated_site_id: null,
      status: "completed",
      payment_status: "paid",
      currency_code: "BDT",
      subtotal_minor: 100000,
      discount_minor: 0,
      tax_minor: 0,
      total_minor: 100000,
      customer_note: null,
      internal_note: null,
      items,
      attribution: null,
      created_by_user_id: SUPER_ACTOR.user.id,
      activation_mode: "on_full_payment",
      activation_percent: null,
      activation_date: null,
      suspend_on_missed_schedule: false,
      grace_days: 7,
      payment_method_id: null,
      lead_id: null,
      created_at: NOW,
      updated_at: NOW,
      completed_at: NOW,
      cancelled_at: null,
    });
    return orderId;
  }

  beforeEach(() => {
    store = new StackMateDataStore();
    assetId = randomUUID();
    store.state.uploaded_assets.push({
      id: assetId,
      object_key: "logos/test.png",
      bucket_name: "stackmate-private-assets",
      original_filename: "test.png",
      content_type: "image/png",
      byte_size: 1234,
      checksum_sha256: "abc",
      visibility: "public",
      uploaded_by_user_id: SUPER_ACTOR.user.id,
      owner_customer_id: null,
      created_at: NOW,
    });
    seedProductAndFeatures();
  });

  it("E-08: save-as-package builds a draft package from the order snapshots, audited; snapshot view exposes them", async () => {
    const orderId = seedOrder([productId]);
    const saved = await saveOrderAsPackage(store, SUPER_ACTOR, orderId, { name: "Test Bundle" }, "test:save-1");
    assert.equal(saved.package.product_id, productId);
    assert.equal(saved.package.status, "draft");
    assert.equal(saved.package.package_key, "test-bundle");
    assert.equal(saved.version.version_number, 1);
    assert.equal(saved.version.status, "draft");
    assert.equal(saved.version.features.length, 2);
    const seats = saved.version.features.find((f) => f.feature_key_snapshot === "seats")!;
    assert.deepEqual(seats.entitlement_value, { value_type: "limit", value: 5 });
    assert.ok(store.state.audit_logs.some((l) => l.action === "catalog.package.saved_from_order"));

    const view = getOrderEntitlementSnapshot(store, SUPER_ACTOR, orderId);
    assert.equal(view.order_number, "ORD-10001");
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0]!.entitlement_snapshot.items.length, 2);

    // Same name again de-duplicates the key instead of 409.
    const saved2 = await saveOrderAsPackage(store, SUPER_ACTOR, orderId, { name: "Test Bundle" }, "test:save-2");
    assert.equal(saved2.package.package_key, "test-bundle-2");
  });

  it("E-08: multi-product order and snapshot-less order are 422", async () => {
    const otherProduct = randomUUID();
    store.state.products.push({
      id: otherProduct,
      code: "OTHER",
      slug: "other",
      name: "Other",
      description: null,
      product_type: "wordpress_plugin",
      fulfillment_type: "software_license",
      distribution_channels: ["wordpress"],
      default_activation_limit: 1,
      offline_grace_hours: 72,
      status: "active",
      website_url: null,
      documentation_url: null,
      created_by_user_id: null,
      created_at: NOW,
      updated_at: NOW,
    });
    const multiId = seedOrder([productId, otherProduct]);
    await assertAppError(
      saveOrderAsPackage(store, SUPER_ACTOR, multiId, { name: "Multi" }, "t"),
      "VALIDATION_ERROR",
      422
    );
    const emptyId = seedOrder([productId], false);
    await assertAppError(
      saveOrderAsPackage(store, SUPER_ACTOR, emptyId, { name: "Empty" }, "t"),
      "VALIDATION_ERROR",
      422
    );
    await assertAppError(
      Promise.resolve().then(() => getOrderEntitlementSnapshot(store, SUPER_ACTOR, randomUUID())),
      "NOT_FOUND",
      404
    );
  });

  it("E-13: logo_asset_id is stored on create, validated, and cleared with null on update", async () => {
    const created = await createProduct(store, SUPER_ACTOR, {
      code: "LOGOPROD",
      slug: "logoprod",
      name: "Logo Product",
      product_type: "wordpress_plugin",
      logo_asset_id: assetId,
    }, "test:logo-1");
    assert.equal(created.logo_asset_id, assetId);

    await assertAppError(
      createProduct(store, SUPER_ACTOR, {
        code: "BADLOGO",
        slug: "badlogo",
        name: "Bad Logo",
        product_type: "wordpress_plugin",
        logo_asset_id: randomUUID(),
      }, "t"),
      "VALIDATION_ERROR",
      422
    );

    const cleared = await updateProductMetadata(store, SUPER_ACTOR, created.id, { logo_asset_id: null }, "test:logo-2");
    assert.equal(cleared.logo_asset_id, null);
  });
});

describe("Batch E — payments delete guards (E-16)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  async function seedProviderAndMethod() {
    const provider = await createPaymentProviderByAdmin(store, SUPER_ACTOR, {
      provider_key: "bkash-manual",
      display_name: "bKash Manual",
      provider_type: "manual_mfs",
      adapter_key: "manual_mfs",
      status: "enabled",
    }, "test:prov");
    const method = await createPaymentMethodByAdmin(store, SUPER_ACTOR, {
      provider_id: provider.id,
      method_key: "bkash-personal",
      display_name: "bKash Personal",
      method_kind: "mfs_account",
      account_type: "personal",
      configuration: { account_number: "01700000000", transaction_id_requirement: "required" },
      transfer_rails: [],
    }, "test:method");
    return { provider, method };
  }

  it("E-16: provider with methods is 409; method with submissions is 409; clean deletes work and audit", async () => {
    const { provider, method } = await seedProviderAndMethod();
    await assertAppError(
      deletePaymentProviderByAdmin(store, SUPER_ACTOR, provider.id, "t"),
      "CONFLICT",
      409
    );

    store.state.payment_submissions.push({
      id: randomUUID(),
      order_id: randomUUID(),
      customer_id: randomUUID(),
      payment_method_id: method.id,
      installment_id: null,
      amount_minor: 100000,
      currency_code: "BDT",
      sender_name: "Test",
      sender_phone: null,
      sender_bank_name: null,
      sender_account_reference: null,
      transfer_rail_key: null,
      transaction_reference: "TXN1",
      normalized_transaction_reference: "TXN1",
      payment_date: "2026-11-25",
      proof_asset_id: null,
      duplicate_risk_Warning: false,
      status: "submitted",
      customer_note: null,
      submitted_at: NOW,
      reviewed_at: null,
      reviewed_by_user_id: null,
    });
    await assertAppError(
      deletePaymentMethodByAdmin(store, SUPER_ACTOR, method.id, "t"),
      "CONFLICT",
      409
    );

    // History cleared (test-only removal of the seeded submission) → delete works.
    store.state.payment_submissions = [];
    const deletedMethod = await deletePaymentMethodByAdmin(store, SUPER_ACTOR, method.id, "test:del-method");
    assert.equal(deletedMethod.id, method.id);
    assert.equal(store.state.payment_methods.length, 0);
    assert.ok(store.state.audit_logs.some((l) => l.action === "payments.method.deleted"));

    const deletedProvider = await deletePaymentProviderByAdmin(store, SUPER_ACTOR, provider.id, "test:del-prov");
    assert.equal(deletedProvider.id, provider.id);
    assert.ok(store.state.audit_logs.some((l) => l.action === "payments.provider.deleted"));

    await assertAppError(
      deletePaymentProviderByAdmin(store, SUPER_ACTOR, provider.id, "t"),
      "NOT_FOUND",
      404
    );
  });
});

describe("Batch E — tracking test event (E-18)", () => {
  let store: StackMateDataStore;
  let groupId: string;

  beforeEach(() => {
    store = new StackMateDataStore();
    const siteId = randomUUID();
    store.state.integrated_sites.push({
      id: siteId,
      site_key: "test-site",
      name: "Test Site",
      environment: "staging",
      status: "active",
      api_version: "v1",
      allowed_capabilities: ["tracking.events.write"],
      product_ids: [],
      domains: [
        {
          id: randomUUID(),
          domain: "test.example.com",
          verification_method: "dns_txt",
          verification_challenge: "challenge",
          verification_status: "verified",
          verified_at: NOW,
          is_primary: true,
        },
      ],
      created_at: NOW,
      updated_at: NOW,
    });
    groupId = randomUUID();
    store.state.tracking_configurations.push({
      id: groupId,
      integrated_site_id: siteId,
      provider: "meta",
      label: "Test pixel",
      pixel_id: "1234567890",
      access_token_ciphertext: encryptSecretAtRest("tok", ENCRYPTION_KEY, KEY_VERSION, `tracking_configurations:${groupId}`),
      encryption_key_version: KEY_VERSION,
      test_event_code: "TEST-CODE-9",
      enabled_events: ["Lead", "Purchase"],
      status: "enabled",
      created_at: NOW,
      updated_at: NOW,
      rotated_at: null,
    });
  });

  it("E-18: synthetic Lead goes through the normal pipeline with the test code attached", async () => {
    const result = await sendTrackingTestEvent(
      store,
      SUPER_ACTOR,
      { pixel_group_id: groupId, event_name: "Lead" },
      "test:test-event-1"
    );
    assert.equal(result.accepted, true);
    assert.equal(result.deduplicated, false);
    assert.ok(result.tracking_event_id);
    assert.equal(result.test_event_code, "TEST-CODE-9");
    const record = store.state.tracking_events.find((t) => t.id === result.tracking_event_id)!;
    assert.equal(record.event_source_url, "https://test.example.com");
    assert.equal(record.sanitized_payload.test_event, true);
    assert.equal(record.sanitized_payload.test_event_code, "TEST-CODE-9");
    assert.equal(record.status, "queued");
    assert.ok(
      store.state.outbox_events.some(
        (e) => e.event_type === "tracking.meta_capi.dispatch" && (e.payload as Record<string, unknown>).tracking_event_id === result.tracking_event_id
      )
    );
    assert.ok(store.state.audit_logs.some((l) => l.action === "tracking.test_event.sent"));
  });

  it("E-18: Purchase stays forbidden, unknown/disabled groups and un-enabled events are rejected", async () => {
    await assertAppError(
      sendTrackingTestEvent(store, SUPER_ACTOR, { pixel_group_id: groupId, event_name: "Purchase" }, "t"),
      "PURCHASE_EVENT_FORBIDDEN",
      403
    );
    await assertAppError(
      sendTrackingTestEvent(store, SUPER_ACTOR, { pixel_group_id: randomUUID(), event_name: "Lead" }, "t"),
      "NOT_FOUND",
      404
    );
    await assertAppError(
      sendTrackingTestEvent(store, SUPER_ACTOR, { pixel_group_id: groupId, event_name: "PageView" }, "t"),
      "VALIDATION_ERROR",
      422
    );
    const group = store.state.tracking_configurations.find((g) => g.id === groupId)!;
    group.status = "disabled";
    await assertAppError(
      sendTrackingTestEvent(store, SUPER_ACTOR, { pixel_group_id: groupId, event_name: "Lead" }, "t"),
      "CONFLICT",
      409
    );
  });
});

describe("F-07 — license v2 minting switch (follow-up)", () => {
  const VERIFIER_SECRET = "test-license-verifier-secret";
  let store: StackMateDataStore;
  let productId: string;
  let customerId: string;

  beforeEach(() => {
    store = new StackMateDataStore();
    productId = randomUUID();
    customerId = randomUUID();
    store.state.products.push({
      id: productId,
      code: "TESTPROD",
      slug: "testprod",
      name: "Test Product",
      description: null,
      product_type: "wordpress_plugin",
      fulfillment_type: "software_license",
      distribution_channels: ["wordpress"],
      default_activation_limit: 2,
      offline_grace_hours: 72,
      status: "active",
      website_url: null,
      documentation_url: null,
      created_by_user_id: SUPER_ACTOR.user.id,
      created_at: NOW,
      updated_at: NOW,
    });
    store.state.customers.push({
      id: customerId,
      customer_number: "CUS-1001",
      customer_type: "person",
      name: "F07 Customer",
      email: "f07@example.com",
      normalized_email: "f07@example.com",
      phone: null,
      normalized_phone: null,
      whatsapp: null,
      credit_balance_minor: 0,
      company_name: null,
      website: null,
      country_code: "BD",
      status: "active",
      registration_source: "admin",
      notes: null,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it("new licenses mint v2 and activate / validate / deactivate through the verifier lookup", async () => {
    const granted = await createManualLicenseGrantByAdmin(
      store,
      SUPER_ACTOR,
      {
        customer_id: customerId,
        product_id: productId,
        activation_limit: 2,
        reason: "F-07 test grant",
        entitlements: {},
      },
      VERIFIER_SECRET,
      "test:f07-mint"
    );
    assert.ok(granted.license.license_key_hash.startsWith("v2:"));
    assert.ok(!granted.license.license_key_hash.startsWith("v1:"));

    const activated = await activateLicenseInstallation(
      store,
      {
        license_key: granted.issued_license_key_once,
        product_code: "TESTPROD",
        installation_id: "f07-install-1",
        environment: "production",
      },
      { verifierSecret: VERIFIER_SECRET, issuerUrl: "https://api.test.example", requestId: "test:f07-activate" }
    );
    assert.equal(activated.valid, true);
    assert.equal(activated.activation.active_count, 1);

    const validated = await validateLicenseInstallation(
      store,
      {
        license_key: granted.issued_license_key_once,
        product_code: "TESTPROD",
        installation_id: "f07-install-1",
      },
      { verifierSecret: VERIFIER_SECRET, issuerUrl: "https://api.test.example" }
    );
    assert.equal(validated.valid, true);

    const deactivated = await deactivateLicenseInstallation(
      store,
      {
        license_key: granted.issued_license_key_once,
        product_code: "TESTPROD",
        installation_id: "f07-install-1",
      },
      { verifierSecret: VERIFIER_SECRET, requestId: "test:f07-deactivate" }
    );
    assert.equal(deactivated.deactivated, true);
    assert.equal(deactivated.active_count, 0);
  });

  it("legacy v1 licenses still activate (backward compat)", async () => {
    const { rawKey } = generateFormattedLicenseKey("TESTPROD");
    const licenseId = randomUUID();
    const snapshotId = randomUUID();
    store.state.licenses.push({
      id: licenseId,
      license_number: "LIC-40002",
      product_id: productId,
      customer_id: customerId,
      source_order_item_id: null,
      subscription_id: null,
      license_key_hash: computeLicenseKeyVerifier(rawKey, VERIFIER_SECRET),
      license_key_hint: "SM-TESTPROD-...-XXXXX",
      issued_raw_key_once: "seed-only-not-a-real-key",
      status: "active",
      activation_limit: 2,
      valid_from: NOW,
      expires_at: null,
      grace_until: null,
      current_entitlement_snapshot_id: snapshotId,
      snapshots: [
        {
          id: snapshotId,
          license_id: licenseId,
          version_number: 1,
          source_type: "manual_grant",
          effective_at: NOW,
          reason: "legacy v1 seed",
          snapshot_hash: "hash",
          items: [],
          created_by_user_id: null,
          created_at: NOW,
        },
      ],
      activations: [],
      issued_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.ok(
      store.state.licenses[0]!.license_key_hash.startsWith("v1:"),
      "seed is genuinely a v1 row"
    );

    const activated = await activateLicenseInstallation(
      store,
      {
        license_key: rawKey,
        product_code: "TESTPROD",
        installation_id: "f07-legacy-install",
        environment: "production",
      },
      { verifierSecret: VERIFIER_SECRET, issuerUrl: "https://api.test.example", requestId: "test:f07-legacy" }
    );
    assert.equal(activated.valid, true);
  });

  it("a wrong key still fails with LICENSE_INVALID", async () => {
    await assertAppError(
      activateLicenseInstallation(
        store,
        {
          license_key: "SM-TESTPROD-AAAAA-BBBBB-CCCCC-DDDDD",
          product_code: "TESTPROD",
          installation_id: "f07-wrong",
          environment: "production",
        },
        { verifierSecret: VERIFIER_SECRET, issuerUrl: "https://api.test.example", requestId: "t" }
      ),
      "LICENSE_INVALID",
      401
    );
  });
});
