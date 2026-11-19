import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import {
  formatDisplayDateDDMMYYYY,
  formatDisplayDateTimeDDMMYYYY,
  parseStrictDDMMYYYYToIsoDate,
  addBillingIntervalUTC,
  parseMajorStringToMinor,
  formatMinorMoney,
  calculateLineTotals,
  calculateOrderTotals,
  normalizeInstallationDomain,
} from "@stackmate/contracts";
import { createStackMateApp } from "../src/app";
import { resolveRuntimeConfig } from "../src/env";
import { StackMateDataStore } from "../src/platform/db/store";
import { createRequestHyperdriveSession, type SqlDriverClient } from "../src/platform/db/hyperdrive";
import {
  signCanonicalServerRequest,
  encryptSecretAtRest,
  decryptSecretAtRest,
  verifyEntitlementJws,
  validateSafeExternalUrl,
  signOutboundWebhookPayload,
  verifyOutboundWebhookSignature,
} from "../src/platform/crypto/index";
import { verifyFileMagicBytes } from "../src/platform/storage/r2";

describe("StackMate End-to-End Domain, Security, Concurrency & Hyperdrive Test Suite (in-memory test adapter — NOT Postgres)", () => {
  // Test-only fixture value (never a real secret): the operator-set
  // SETUP_TOKEN that gates POST /api/auth/bootstrap-super-admin.
  const TEST_SETUP_TOKEN =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  let store: StackMateDataStore;
  let app: ReturnType<typeof createStackMateApp>;
  let env: ReturnType<typeof resolveRuntimeConfig>;

  beforeEach(() => {
    store = new StackMateDataStore();
    env = resolveRuntimeConfig({ APP_ENV: "test", SETUP_TOKEN: TEST_SETUP_TOKEN });
    app = createStackMateApp(store);
  });

  async function apiRequest(
    path: string,
    init: RequestInit = {},
    cookieOrBearer?: { cookie?: string; bearer?: string; origin?: string }
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers = new Headers(init.headers || {});
    if (cookieOrBearer?.cookie) {
      headers.set("Cookie", cookieOrBearer.cookie);
    }
    if (cookieOrBearer?.bearer) {
      headers.set("Authorization", `Bearer ${cookieOrBearer.bearer}`);
    }
    if (cookieOrBearer?.origin) {
      headers.set("Origin", cookieOrBearer.origin);
    }
    const req = new Request(`http://localhost:8787${path}`, {
      ...init,
      headers,
    });
    const res = await app.fetch(req, env);
    const body = await res.json();
    return { status: res.status, body, headers: res.headers };
  }

  async function bootstrapAndLoginSuperAdmin(): Promise<{
    cookie: string;
    token: string;
    userId: string;
  }> {
    const bootRes = await apiRequest("/api/auth/bootstrap-super-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mahmudul Hasan Riaz",
        email: "admin@stackmate.local",
        password: "StackMate#SuperAdmin2026!",
        setupToken: TEST_SETUP_TOKEN,
      }),
    });
    assert.equal(bootRes.status, 201);

    const signInRes = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@stackmate.local",
        password: "StackMate#SuperAdmin2026!",
      }),
    });
    assert.equal(signInRes.status, 200);
    const token = signInRes.body.data.session_token;
    return {
      cookie: `stackmate_session=${token}`,
      token,
      userId: signInRes.body.data.principal.user.id,
    };
  }

  it("1. Enforces DD/MM/YYYY date formatting, strict calendar validation, and UTC ISO 8601 storage", () => {
    const isoDate = parseStrictDDMMYYYYToIsoDate("19/04/2026");
    assert.equal(isoDate, "2026-04-19");
    assert.equal(formatDisplayDateDDMMYYYY(isoDate, "UTC"), "19/04/2026");
    assert.equal(
      formatDisplayDateTimeDDMMYYYY("2026-04-19T06:30:00.000Z", "Asia/Dhaka"),
      "19/04/2026 12:30"
    );

    // Reject MM/DD/YYYY input where month > 12
    assert.throws(() => parseStrictDDMMYYYYToIsoDate("04/19/2026"), /Invalid calendar date/);

    // Reject impossible leap day on non-leap year
    assert.throws(() => parseStrictDDMMYYYYToIsoDate("29/02/2026"), /Invalid calendar date/);

    // Accept valid leap day on leap year
    assert.equal(parseStrictDDMMYYYYToIsoDate("29/02/2028"), "2028-02-29");

    // End-of-month billing interval clamping (Jan 31 + 1 month -> Feb 28 in non-leap year)
    assert.equal(
      addBillingIntervalUTC("2026-01-31T00:00:00.000Z", "month", 1),
      "2026-02-28T00:00:00.000Z"
    );
  });

  it("2. Enforces integer minor-unit money calculations (BDT poisha exponent 2) with zero floating-point drift", () => {
    const minor = parseMajorStringToMinor("4999.50", "BDT");
    assert.equal(minor, 499950);
    assert.equal(formatMinorMoney(minor, "BDT"), "৳4,999.50");

    // Reject 3 decimal places for BDT (exponent 2)
    assert.throws(
      () => parseMajorStringToMinor("100.125", "BDT"),
      /Currency BDT supports at most 2 decimal places/
    );

    const line1 = calculateLineTotals({
      unit_amount_minor: 499900,
      quantity: 2,
      line_discount_minor: 99800,
      line_tax_minor: 0,
      currency_code: "BDT",
    });
    assert.equal(line1.line_subtotal_minor, 999800);
    assert.equal(line1.line_total_minor, 900000);

    const line2 = calculateLineTotals({
      unit_amount_minor: 250000,
      quantity: 1,
      currency_code: "BDT",
    });

    const summary = calculateOrderTotals([line1, line2], 50000, 22000);
    assert.equal(summary.subtotal_minor, 1249800);
    assert.equal(summary.discount_minor, 149800);
    assert.equal(summary.tax_minor, 22000);
    assert.equal(summary.total_minor, 1122000);

    // Reject mixing currencies without explicit conversion
    const usdLine = calculateLineTotals({
      unit_amount_minor: 4900,
      quantity: 1,
      currency_code: "USD",
    });
    assert.throws(() => calculateOrderTotals([line1, usdLine]), /Currency mismatch/);
  });

  it("3. Verifies Cloudflare Hyperdrive dual-binding separation (NO_CACHE vs CACHED), transaction pin, and rollback", async () => {
    const executedQueries: Array<{ conn: string; sql: string }> = [];
    const mockFactory = async (connStr: string): Promise<SqlDriverClient> => ({
      async connect() {},
      async query<T = Record<string, unknown>>(sqlText: string) {
        executedQueries.push({ conn: connStr, sql: sqlText });
        return { rows: [] as T[], rowCount: 0 };
      },
      async end() {},
    });

    const customEnv = resolveRuntimeConfig({
      APP_ENV: "test",
      HYPERDRIVE_NO_CACHE: { connectionString: "postgres://hyperdrive-no-cache.internal/stackmate" },
      HYPERDRIVE_CACHED: { connectionString: "postgres://hyperdrive-cached.internal/stackmate" },
    });

    const hdSession = createRequestHyperdriveSession(customEnv, undefined, mockFactory);

    // 1. Read-only public catalog query uses HYPERDRIVE_CACHED before any write transaction
    const cachedClient = await hdSession.getCachedReadClient();
    await cachedClient.query("SELECT * FROM products WHERE status = 'active'");
    assert.equal(executedQueries[0]?.conn, "postgres://hyperdrive-cached.internal/stackmate");

    // 2. Interactive transaction pins to HYPERDRIVE_NO_CACHE and rolls back cleanly on error
    await assert.rejects(async () => {
      await hdSession.runInteractiveTransaction(async (tx) => {
        await tx.query("SELECT * FROM payment_submissions WHERE id = $1 FOR UPDATE", ["sub_1"]);
        throw new Error("Simulated transaction abort");
      });
    }, /Simulated transaction abort/);

    const txSqls = executedQueries
      .filter((q) => q.conn === "postgres://hyperdrive-no-cache.internal/stackmate")
      .map((q) => q.sql);
    assert.deepEqual(txSqls, [
      "BEGIN",
      "SELECT * FROM payment_submissions WHERE id = $1 FOR UPDATE",
      "ROLLBACK",
    ]);

    // 3. Domain store transaction rollback verification
    const initialProductsCount = store.state.products.length;
    await assert.rejects(async () => {
      await store.withTransaction((state) => {
        state.products.push({
          id: "temp-prod",
          code: "TEMP",
          slug: "temp",
          name: "Temp",
          description: null,
          product_type: "wordpress_plugin",
          fulfillment_type: "software_license",
          distribution_channels: ["wordpress"],
          default_activation_limit: 1,
          offline_grace_hours: 72,
          status: "draft",
          website_url: null,
          documentation_url: null,
          created_by_user_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        throw new Error("Rollback domain state");
      });
    }, /Rollback domain state/);
    assert.equal(store.state.products.length, initialProductsCount);
    assert.equal(store.queryMetrics.transactionsRolledBack, 1);

    await hdSession.dispose();
  });

  it("4. Enforces authentication, CSRF origin checks, and 5-role RBAC permission boundaries", async () => {
    const superAdmin = await bootstrapAndLoginSuperAdmin();

    // Create a Finance Manager user and a Support Operations user
    const financeCreateRes = await apiRequest(
      "/api/v1/admin/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Finance Manager",
          email: "finance@stackmate.local",
          password: "StackMate#Finance2026!",
          role_keys: ["finance_manager"],
        }),
      },
      { cookie: superAdmin.cookie }
    );
    assert.equal(financeCreateRes.status, 201);

    const financeSignIn = await apiRequest("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "finance@stackmate.local",
        password: "StackMate#Finance2026!",
      }),
    });
    assert.equal(financeSignIn.status, 200);
    const financeCookie = `stackmate_session=${financeSignIn.body.data.session_token}`;

    // Finance manager CANNOT create catalog products (`products.create` denied)
    const forbiddenProductRes = await apiRequest(
      "/api/v1/admin/products",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "UNAUTH_PROD",
          slug: "unauth-prod",
          name: "Unauthorized Product",
          product_type: "wordpress_plugin",
        }),
      },
      { cookie: financeCookie }
    );
    assert.equal(forbiddenProductRes.status, 403);

    // Cross-origin state-changing request with session cookie from untrusted Origin is blocked by CSRF policy
    const csrfBlockedRes = await apiRequest(
      "/api/v1/admin/products",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "CSRF_ATTACK",
          slug: "csrf-attack",
          name: "CSRF Attack",
          product_type: "wordpress_plugin",
        }),
      },
      { cookie: superAdmin.cookie, origin: "https://evil-attacker.example.com" }
    );
    assert.equal(csrfBlockedRes.status, 403);
  });

  it("5. Supports all 6 product types (wordpress_plugin, wordpress_theme, licensed_software, saas_application, dedicated_deployment, digital_service)", async () => {
    const admin = await bootstrapAndLoginSuperAdmin();
    const productTypes = [
      "wordpress_plugin",
      "wordpress_theme",
      "licensed_software",
      "saas_application",
      "dedicated_deployment",
      "digital_service",
    ] as const;

    for (const pt of productTypes) {
      const res = await apiRequest(
        "/api/v1/admin/products",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: `SM_${pt.toUpperCase()}`,
            slug: `sm-${pt.replace(/_/g, "-")}`,
            name: `StackMate ${pt}`,
            product_type: pt,
            default_activation_limit: 5,
            offline_grace_hours: 168,
          }),
        },
        { cookie: admin.cookie }
      );
      assert.equal(res.status, 201, `Failed creating product_type ${pt}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.data.product_type, pt);
    }

    const listRes = await apiRequest(
      "/api/v1/admin/products",
      { method: "GET" },
      { cookie: admin.cookie }
    );
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.items.length, 6);
  });

  it("6. Executes full end-to-end commerce, manual payment proof R2 upload, concurrent double-approval race prevention, verified-only Meta CAPI Purchase, and WordPress plugin licensing", async () => {
    const admin = await bootstrapAndLoginSuperAdmin();

    // 1. Create & publish EcoMate WordPress Plugin product
    const prodRes = await apiRequest(
      "/api/v1/admin/products",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "ECOMATE",
          slug: "ecomate-woo-plugin",
          name: "EcoMate WooCommerce SaaS Plugin",
          product_type: "wordpress_plugin",
          fulfillment_type: "software_license",
          default_activation_limit: 3,
          offline_grace_hours: 168,
        }),
      },
      { cookie: admin.cookie }
    );
    assert.equal(prodRes.status, 201);
    const productId = prodRes.body.data.id;

    // 2. Create product feature (`pos_module`, boolean) and (`monthly_orders`, quota)
    const feat1Res = await apiRequest(
      `/api/v1/admin/products/${productId}/features`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feature_key: "pos_module",
          name: "POS Integration",
          value_type: "boolean",
        }),
      },
      { cookie: admin.cookie }
    );
    assert.equal(feat1Res.status, 201);
    const feat1Id = feat1Res.body.data.id;

    // 3. Create package with draft version, attach BDT price (4,999.00 BDT = 499900 poisha), and publish
    const pkgRes = await apiRequest(
      `/api/v1/admin/products/${productId}/packages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          package_key: "agency-plan",
          name: "Agency Plan",
          features: [
            {
              product_feature_id: feat1Id,
              entitlement_value: { value_type: "boolean", value: true },
            },
          ],
          change_summary: "Initial Agency Plan release",
        }),
      },
      { cookie: admin.cookie }
    );
    assert.equal(pkgRes.status, 201);
    const versionId = pkgRes.body.data.version.id;

    const priceRes = await apiRequest(
      `/api/v1/admin/package-versions/${versionId}/prices`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          price_key: "bdt-yearly",
          price_kind: "recurring",
          amount_minor: 499900,
          currency_code: "BDT",
          interval_unit: "year",
          interval_count: 1,
        }),
      },
      { cookie: admin.cookie }
    );
    assert.equal(priceRes.status, 201);
    const priceId = priceRes.body.data.id;

    const pubVerRes = await apiRequest(
      `/api/v1/admin/package-versions/${versionId}/publish`,
      { method: "POST" },
      { cookie: admin.cookie }
    );
    assert.equal(pubVerRes.status, 200);

    const pubProdRes = await apiRequest(
      `/api/v1/admin/products/${productId}/publish`,
      { method: "POST" },
      { cookie: admin.cookie }
    );
    assert.equal(pubProdRes.status, 200);

    // 4. Configure bKash Merchant manual payment method & Bank Transfer method with rails
    const bkashProvider = store.state.payment_providers.find((p) => p.provider_key === "bkash_manual")!;
    const bkashMethodRes = await apiRequest(
      "/api/v1/admin/payment-methods",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: bkashProvider.id,
          method_key: "bkash-merchant-main",
          display_name: "bKash Merchant Payment",
          method_kind: "mfs_account",
          account_type: "merchant",
          configuration: {
            account_number: "01700000000",
            account_holder_name: "StackMate Technologies Ltd.",
            transaction_id_requirement: "required",
          },
        }),
      },
      { cookie: admin.cookie }
    );
    assert.equal(bkashMethodRes.status, 201);
    const bkashMethodId = bkashMethodRes.body.data.id;

    // 5. Register External Website (`ecomate.bd`) and configure Meta CAPI tracking
    const siteRes = await apiRequest(
      "/api/v1/admin/integrated-sites",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "EcoMate Official Astro Website",
          environment: "production",
          primary_domain: "ecomate.bd",
          product_ids: [productId],
          allowed_capabilities: [
            "catalog.read",
            "checkout.create",
            "orders.read:own",
            "tracking.events.write",
          ],
        }),
      },
      { cookie: admin.cookie }
    );
    assert.equal(siteRes.status, 201);
    const siteId = siteRes.body.data.site.id;
    const siteKey = siteRes.body.data.site.site_key;
    const hmacKeyId = siteRes.body.data.initial_server_credential.key_id;
    const hmacSharedSecret = siteRes.body.data.initial_server_credential.raw_secret_once;

    const trackCfgRes = await apiRequest(
      `/api/v1/admin/integrated-sites/${siteId}/tracking`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "meta",
          pixel_id: "123456789012345",
          access_token: "EAAB_mock_meta_capi_system_user_token_2026",
          enabled_events: ["PageView", "InitiateCheckout", "Purchase"],
          status: "enabled",
        }),
      },
      { cookie: admin.cookie }
    );
    assert.equal(trackCfgRes.status, 200);

    // Verify public website CANNOT spoof a `Purchase` conversion event directly!
    const spoofPurchaseRes = await apiRequest(
      `/api/v1/public/sites/${siteKey}/tracking/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_name: "Purchase",
          event_id: "evt_spoofed_12345",
          event_time: new Date().toISOString(),
          event_source_url: "https://ecomate.bd/checkout",
          consent: { status: "granted", policy_version: "v1" },
        }),
      }
    );
    assert.equal(spoofPurchaseRes.status, 403);

    // 6. Public website fetches catalog (increments cachedQueries metric) and creates idempotent checkout order
    const pubCatRes = await apiRequest(
      `/api/v1/public/sites/${siteKey}/products`,
      {
        method: "GET",
        headers: { "X-StackMate-Site-Key": siteKey },
      }
    );
    assert.equal(pubCatRes.status, 200);
    assert.equal(pubCatRes.body.data.items.length, 1);
    assert.ok(store.queryMetrics.cachedQueries >= 1);

    const checkoutBody = {
      items: [
        {
          product_slug: "ecomate-woo-plugin",
          package_version_id: versionId,
          price_id: priceId,
          quantity: 1,
        },
      ],
      customer: {
        name: "Tanvir Rahman",
        email: "tanvir@agency.bd",
        phone: "+8801711223344",
      },
      attribution: {
        utm_source: "facebook",
        utm_campaign: "ramadan_2026",
        fbp: "fb.1.1713484800000.111222333",
        fbc: "fb.1.1713484800000.IwAR0abc",
      },
    };

    const checkoutRes = await apiRequest(
      `/api/v1/public/sites/${siteKey}/checkout/orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StackMate-Site-Key": siteKey,
          "Idempotency-Key": "idem-checkout-order-101",
        },
        body: JSON.stringify(checkoutBody),
      }
    );
    assert.equal(checkoutRes.status, 201);
    const publicReference = checkoutRes.body.data.order.public_reference;
    const checkoutToken = checkoutRes.body.data.checkout_access_token;
    assert.equal(checkoutRes.body.data.order.total_minor, 499900);

    // Replaying same Idempotency-Key returns 200 with identical order
    const replayCheckout = await apiRequest(
      `/api/v1/public/sites/${siteKey}/checkout/orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StackMate-Site-Key": siteKey,
          "Idempotency-Key": "idem-checkout-order-101",
        },
        body: JSON.stringify(checkoutBody),
      }
    );
    assert.equal(replayCheckout.status, 200);
    assert.equal(replayCheckout.body.data.order.id, checkoutRes.body.data.order.id);

    // 7. Upload private payment proof to R2 (reject invalid magic bytes, accept valid PNG)
    const badEvidenceRes = await apiRequest(
      `/api/v1/public/sites/${siteKey}/checkout/orders/${publicReference}/payment-evidence`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "fake.png",
          content_type: "image/png",
          content_base64: Buffer.from("not-a-valid-png-file-header").toString("base64"),
        }),
      },
      { bearer: checkoutToken }
    );
    assert.equal(badEvidenceRes.status, 415);

    const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const goodEvidenceRes = await apiRequest(
      `/api/v1/public/sites/${siteKey}/checkout/orders/${publicReference}/payment-evidence`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "bkash_receipt.png",
          content_type: "image/png",
          content_base64: validPng.toString("base64"),
        }),
      },
      { bearer: checkoutToken }
    );
    assert.equal(goodEvidenceRes.status, 201);
    const evidenceAssetId = goodEvidenceRes.body.data.evidence_asset_id;

    // 8. Submit manual payment claim
    const submitPayRes = await apiRequest(
      `/api/v1/public/sites/${siteKey}/checkout/orders/${publicReference}/payment-submissions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-payment-sub-101",
        },
        body: JSON.stringify({
          payment_method_id: bkashMethodId,
          amount_minor: 499900,
          currency_code: "BDT",
          sender_phone: "01711223344",
          transaction_id: "BKA20260419XYZ",
          payment_date_display: "19/04/2026",
          evidence_asset_id: evidenceAssetId,
        }),
      },
      { bearer: checkoutToken }
    );
    assert.equal(submitPayRes.status, 201);
    const submissionId = submitPayRes.body.data.payment_submission.id;

    // Verify analytics overview BEFORE approval: pending payment is NEVER counted as verified revenue!
    const preAnalytics = await apiRequest(
      "/api/v1/admin/analytics/overview",
      { method: "GET" },
      { cookie: admin.cookie }
    );
    assert.equal(preAnalytics.body.data.verified_revenue_minor, 0);
    assert.equal(preAnalytics.body.data.pending_payment_submissions, 1);

    // 9. Concurrent double-approval race test: two simultaneous approve requests
    const approvePayload = {
      verified_amount_minor: 499900,
      currency_code: "BDT",
      verification_reference: "BKASH-STMT-20260419-01",
      internal_note: "Verified against bKash merchant portal",
    };

    const [approveA, approveB] = await Promise.all([
      apiRequest(
        `/api/v1/admin/payment-submissions/${submissionId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(approvePayload),
        },
        { cookie: admin.cookie }
      ),
      apiRequest(
        `/api/v1/admin/payment-submissions/${submissionId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(approvePayload),
        },
        { cookie: admin.cookie }
      ),
    ]);

    const approvalStatuses = [approveA.status, approveB.status].sort();
    assert.deepEqual(
      approvalStatuses,
      [200, 409],
      "Exactly one approval must succeed (200) and the concurrent race must fail with 409"
    );

    const winningApproval = approveA.status === 200 ? approveA : approveB;
    assert.equal(winningApproval.body.data.payment_status, "paid");
    assert.equal(winningApproval.body.data.issued_licenses.length, 1);
    const rawLicenseKey = winningApproval.body.data.issued_licenses[0].issued_license_key_once;
    assert.ok(rawLicenseKey.startsWith("SM-ECOMAT-"));

    // Verify verified-only Meta CAPI Purchase event was enqueued after approval
    const purchaseEvents = store.state.tracking_events.filter((e) => e.event_name === "Purchase");
    assert.equal(purchaseEvents.length, 1);

    // 10. WordPress Plugin Licensing Lifecycle & Concurrent Seat Limit Race Test (limit = 3 seats)
    // Reject license_key in query string (security rule)
    const queryLeakRes = await apiRequest(
      `/api/v1/licenses/validate?license_key=${encodeURIComponent(rawLicenseKey)}`,
      { method: "POST" }
    );
    assert.equal(queryLeakRes.status, 400);

    // Fire 5 concurrent production activations against a 3-seat license limit
    const concurrentActivations = Array.from({ length: 5 }, (_, idx) =>
      apiRequest("/api/v1/licenses/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          license_key: rawLicenseKey,
          product_code: "ECOMATE",
          integration_profile: "wordpress_plugin",
          installation_id: `wp-site-${idx + 1}`,
          site_url: `https://shop-${idx + 1}.bd`,
          environment: "production",
          product_version: "2.4.0",
        }),
      })
    );
    const actResults = await Promise.all(concurrentActivations);
    const actSuccess = actResults.filter((r) => r.status === 200);
    const actExceeded = actResults.filter(
      (r) => r.status === 409 && r.body.error.code === "ACTIVATION_LIMIT_REACHED"
    );
    assert.equal(actSuccess.length, 3, "Exactly 3 concurrent activations must succeed");
    assert.equal(actExceeded.length, 2, "Remaining 2 concurrent activations must be blocked");

    // Verify Ed25519 signed JWS entitlement token using public JWKS from /api/v1/licenses/signing-keys
    const jwsToken = actSuccess[0]!.body.data.entitlement_token;
    const keysRes = await apiRequest("/api/v1/licenses/signing-keys");
    const pubJwk = keysRes.body.data.keys[0];
    const verifiedJws = verifyEntitlementJws(jwsToken, pubJwk, {
      expectedProductCode: "ECOMATE",
    });
    assert.equal(verifiedJws.header.alg, "EdDSA");
    assert.equal(verifiedJws.claims.product_code, "ECOMATE");
    assert.deepEqual(verifiedJws.claims.entitlements.pos_module, {
      value_type: "boolean",
      value: true,
    });

    // Deactivate one installation and verify seat count drops from 3 to 2
    const deactRes = await apiRequest("/api/v1/licenses/deactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: rawLicenseKey,
        product_code: "ECOMATE",
        integration_profile: "wordpress_plugin",
        installation_id: "wp-site-1",
      }),
    });
    assert.equal(deactRes.status, 200);
    assert.equal(deactRes.body.data.active_count, 2);

    // 11. Test canonical STACKMATE-HMAC-SHA256-V1 server-to-server signed request & replay protection
    const s2sPath = `/api/v1/integrations/sites/${siteKey}/orders/${publicReference}`;
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "nonce_s2s_9876543210";
    const signed = signCanonicalServerRequest(
      {
        keyId: hmacKeyId,
        timestampUnixSeconds: ts,
        nonce,
        method: "GET",
        host: "localhost:8787",
        rawPathAndQuery: s2sPath,
        rawBody: "",
      },
      hmacSharedSecret
    );

    const s2sRes1 = await apiRequest(s2sPath, {
      method: "GET",
      headers: {
        "X-StackMate-Key-Id": hmacKeyId,
        "X-StackMate-Timestamp": String(ts),
        "X-StackMate-Nonce": nonce,
        "X-StackMate-Content-SHA256": signed.contentSha256Header,
        "X-StackMate-Signature": signed.signatureHeader,
      },
    });
    assert.equal(s2sRes1.status, 200);
    assert.equal(s2sRes1.body.data.payment_status, "paid");

    // Replay the exact same signed request -> must fail with 409 NONCE_REPLAYED
    const s2sReplay = await apiRequest(s2sPath, {
      method: "GET",
      headers: {
        "X-StackMate-Key-Id": hmacKeyId,
        "X-StackMate-Timestamp": String(ts),
        "X-StackMate-Nonce": nonce,
        "X-StackMate-Content-SHA256": signed.contentSha256Header,
        "X-StackMate-Signature": signed.signatureHeader,
      },
    });
    assert.equal(s2sReplay.status, 409);
    assert.equal(s2sReplay.body.error.code, "NONCE_REPLAYED");
  });

  it("7. Verifies AES-256-GCM envelope encryption, SSRF protection, magic-byte validation, and domain normalization", () => {
    const masterKey = "master-secret-key-for-aes-256-gcm-envelope-test";
    const ciphertext = encryptSecretAtRest("secret-meta-capi-token", masterKey, "v1", "site:123");
    assert.equal(decryptSecretAtRest(ciphertext, masterKey, "site:123"), "secret-meta-capi-token");

    // Tampered AAD must throw authentication error
    assert.throws(() => decryptSecretAtRest(ciphertext, masterKey, "site:999"));

    // Outbound webhook HMAC signing & verification
    const whSig = signOutboundWebhookPayload(1713484800, "deliv_1", '{"event":"order.paid"}', "whsec_test");
    assert.equal(
      verifyOutboundWebhookSignature(
        1713484800,
        "deliv_1",
        '{"event":"order.paid"}',
        whSig.signatureHeader,
        "whsec_test",
        1713484850
      ),
      true
    );

    // SSRF protection blocks localhost, RFC1918 private IPs, and cloud metadata IPs
    assert.equal(validateSafeExternalUrl("https://hooks.partner.com/webhook").hostname, "hooks.partner.com");
    assert.throws(() => validateSafeExternalUrl("http://hooks.partner.com/webhook"), /must use HTTPS/);
    assert.throws(() => validateSafeExternalUrl("https://127.0.0.1/webhook"), /blocked by SSRF/);
    assert.throws(() => validateSafeExternalUrl("https://169.254.169.254/latest/meta-data"), /blocked by SSRF/);
    assert.throws(() => validateSafeExternalUrl("https://192.168.1.10/webhook"), /blocked by SSRF/);
    assert.throws(() => validateSafeExternalUrl("https://localhost/webhook"), /prohibited by SSRF/);

    // Magic-byte verification
    assert.doesNotThrow(() =>
      verifyFileMagicBytes(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
        "application/pdf"
      )
    );
    assert.throws(
      () => verifyFileMagicBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]), "application/pdf"),
      /File signature does not match PDF format/
    );

    // Domain normalization
    assert.equal(normalizeInstallationDomain("https://WWW.ExampleShop.BD:443/wp-admin/"), "exampleshop.bd");
  });
});
