/**
 * Audit fix remainders — crypto / contracts / general-settings / renewal.
 *
 * Items under test:
 *  - M-3 SSRF validator: IP canonicalization (hex/octal/decimal/short
 *    IPv4, IPv6-mapped hex forms), `fc.example.com` false positive,
 *    async DNS resolution + re-check.
 *  - M-4 master-secret KDF: scrypt v2, v1 dual-decrypt (incl. a fixture
 *    ciphertext produced by the OLD single-SHA-256 derivation), rotation
 *    helpers.
 *  - L-9 favicon SVG: full-document parser-based check (script past
 *    byte 2048, event handlers, javascript: URLs).
 *  - F-05 contracts: `activation_date` refine (strict ISO, today-or-future).
 *  - H-02 contracts: `CreateCustomerSchema` accepts `address` natively;
 *    one-request customer create (strip removed).
 *  - L-13 contracts: `CreateRoleSchema.permissions` capped at 64.
 *  - F-03 contracts: `RecordManualRefundSchema`.
 *  - F-12: business-timezone boundaries in the sweep (`planSweepInTx`)
 *    and in `activationDueNow`.
 *  - M-23: `users.avatar_url` round-trips through the DrizzleStore
 *    (needs local Postgres — skipped without DATABASE_URL).
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  DATABASE_URL,
  SUPER_ACTOR,
  setupTestDb,
} from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import { DrizzleStore } from "../src/platform/db/drizzle-store.ts";
import {
  computeLicenseKeyVerifier,
  computeLicenseKeyVerifierV2,
  decryptSecretAtRest,
  encryptSecretAtRest,
  isLegacyV1Ciphertext,
  needsReEncryption,
  reEncryptSecretAtRest,
  validateSafeExternalUrl,
  validateSafeExternalUrlAsync,
  verifyLicenseKeyVerifier,
} from "../src/platform/crypto/index.ts";
import { verifyFaviconBytes } from "../src/modules/general-settings/service.ts";
import { createCustomerByAdmin } from "../src/modules/customers/service.ts";
import {
  activationDueNow,
  businessTodayIso,
} from "../src/modules/activation/service.ts";
import { planSweepInTx } from "../src/modules/renewal/sweep.ts";
import {
  AdminCreateOrderSchema,
  CreateCustomerSchema,
  CreateRoleSchema,
  RecordManualRefundSchema,
} from "../../../packages/contracts/src/index.ts";
import { SchemaValidationError } from "../../../packages/contracts/src/common/validator.ts";

const MASTER = "test-master-secret-2026";

/**
 * v1 fixture: produced by the OLD derivation (single unsalted SHA-256)
 * BEFORE the M-4 change — plaintext "stackmate-kdf-fixture-plaintext",
 * master "test-master-secret-2026", aad "test:aad". If this stops
 * decrypting, the rotation broke backward compatibility.
 */
const V1_FIXTURE =
  "v1:GSxhkqpTYz5smACl:WCbSmpOmIwtxQbk290QsnQ:fmpxl-cEOQtwe2eNQCjMkyrdydaFJSNpX4saLL2--w";

function ssrfBlocked(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => {
    const e = err as { code?: string };
    return e.code === "SSRF_BLOCKED";
  });
}

describe("M-3 — SSRF validator canonicalization", () => {
  it("blocks hex / octal / decimal / short IPv4 loopback forms", () => {
    for (const host of [
      "0x7f000001",
      "0177.0.0.1",
      "2130706433",
      "127.1",
      "0x7f.0.0.1",
      "3232235521", // 192.168.0.1
      "169.254.169.254",
      "10.0.0.5",
    ]) {
      ssrfBlocked(() => validateSafeExternalUrl(`https://${host}/hook`));
    }
  });

  it("blocks IPv4-mapped IPv6 in dotted AND hex form", () => {
    for (const host of [
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[0:0:0:0:0:ffff:127.0.0.1]",
      "[::ffff:10.0.0.1]",
      "[::ffff:a00:1]",
      "[::ffff:192.168.0.1]",
      "[::ffff:c0a8:1]",
      "[::ffff:169.254.169.254]",
      "[::ffff:a9fe:a9fe]",
    ]) {
      ssrfBlocked(() => validateSafeExternalUrl(`https://${host}/hook`));
    }
  });

  it("blocks IPv6 loopback / unspecified / ULA / link-local, incl. 6to4-embedded private IPv4", () => {
    for (const host of ["[::1]", "[::]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[febf::1]", "[2002:7f00:1::1]"]) {
      ssrfBlocked(() => validateSafeExternalUrl(`https://${host}/hook`));
    }
  });

  it("does NOT block hostnames starting with fc/fd (old false positive)", () => {
    for (const host of ["fc.example.com", "fd.example.com", "fca.com"]) {
      const url = validateSafeExternalUrl(`https://${host}/hook`);
      assert.equal(url.hostname, host);
    }
  });

  it("allows public IPs and public hostnames", () => {
    for (const host of ["8.8.8.8", "93.184.216.34", "example.com", "[2606:4700:4700::1111]"]) {
      const url = validateSafeExternalUrl(`https://${host}/hook`);
      assert.ok(url.hostname.length > 0);
    }
  });
});

describe("M-3 — SSRF async validation (DNS + re-check)", () => {
  it("IP literals skip DNS and keep the sync verdict", async () => {
    const ok = await validateSafeExternalUrlAsync("https://8.8.8.8/hook");
    assert.equal(ok.hostname, "8.8.8.8");
    await assert.rejects(
      () => validateSafeExternalUrlAsync("https://0x7f000001/hook"),
      (err: unknown) => (err as { code?: string }).code === "SSRF_BLOCKED"
    );
    await assert.rejects(
      () => validateSafeExternalUrlAsync("https://localhost/hook"),
      (err: unknown) => (err as { code?: string }).code === "SSRF_BLOCKED"
    );
  });

  it("a public hostname resolves and passes; a name resolving to loopback is blocked", async () => {
    // Needs DNS egress (available in this environment and in CI with
    // network); the resolver result is re-checked like any literal.
    // `ip6-localhost` resolves to ::1 via /etc/hosts — the DNS
    // re-check path, deterministically. (An unresolvable host fails
    // closed too, but this sandbox's DNS is a wildcard sinkhole, so no
    // name can be made unresolvable here to prove it.)
    const ok = await validateSafeExternalUrlAsync("https://example.com/hook");
    assert.equal(ok.hostname, "example.com");
    await assert.rejects(
      () => validateSafeExternalUrlAsync("https://ip6-localhost/hook"),
      (err: unknown) => (err as { code?: string }).code === "SSRF_BLOCKED"
    );
  });
});

describe("M-4 — master-secret KDF (scrypt v2, v1 dual-decrypt)", () => {
  it("the OLD v1 fixture still decrypts after the change", () => {
    assert.equal(
      decryptSecretAtRest(V1_FIXTURE, MASTER, "test:aad"),
      "stackmate-kdf-fixture-plaintext"
    );
    assert.equal(isLegacyV1Ciphertext(V1_FIXTURE), true);
  });

  it("explicit v1 encrypt round-trips and is detected as legacy", () => {
    const ct = encryptSecretAtRest("legacy-row", MASTER, "v1", "test:aad");
    assert.ok(ct.startsWith("v1:"));
    assert.equal(decryptSecretAtRest(ct, MASTER, "test:aad"), "legacy-row");
    assert.equal(isLegacyV1Ciphertext(ct), true);
  });

  it("new writes default to v3 (scrypt over a random per-envelope salt) and round-trip", () => {
    const ct = encryptSecretAtRest("fresh-secret", MASTER, undefined, "test:aad");
    assert.ok(ct.startsWith("v3:"));
    assert.equal(ct.split(":").length, 5);
    assert.equal(decryptSecretAtRest(ct, MASTER, "test:aad"), "fresh-secret");
    assert.equal(isLegacyV1Ciphertext(ct), false);
    assert.equal(needsReEncryption(ct), false);
  });

  it("dual-decrypt fallback: a v2-tagged ciphertext derived under v1 still reads", () => {
    const v1 = encryptSecretAtRest("drifted-row", MASTER, "v1", "test:aad");
    const retagged = `v2:${v1.split(":").slice(1).join(":")}`;
    assert.equal(decryptSecretAtRest(retagged, MASTER, "test:aad"), "drifted-row");
  });

  it("wrong master secret fails; AAD mismatch fails; random IVs differ", () => {
    const ct = encryptSecretAtRest("x", MASTER, undefined, "test:aad");
    assert.throws(() => decryptSecretAtRest(ct, "wrong-secret", "test:aad"));
    assert.throws(() => decryptSecretAtRest(ct, MASTER, "other:aad"));
    const ct2 = encryptSecretAtRest("x", MASTER, undefined, "test:aad");
    assert.notEqual(ct, ct2);
  });

  it("HMAC paths are untouched: license verifier is deterministic and unchanged", () => {
    const a = computeLicenseKeyVerifier("SM-TEST-AAAAA-BBBBB-CCCCC-DDDDD", "verifier-secret");
    const b = computeLicenseKeyVerifier("SM-TEST-AAAAA-BBBBB-CCCCC-DDDDD", "verifier-secret");
    assert.equal(a, b);
    assert.ok(a.startsWith("v1:"));
  });

  it("F-07: v2 license verifier is HKDF-derived and verify accepts both v1 and v2", () => {
    const raw = "SM-TEST-AAAAA-BBBBB-CCCCC-DDDDD";
    const v1 = computeLicenseKeyVerifier(raw, "verifier-secret");
    const v2 = computeLicenseKeyVerifierV2(raw, "verifier-secret");
    assert.ok(v2.startsWith("v2:"));
    assert.notEqual(v1, v2);
    assert.equal(verifyLicenseKeyVerifier(raw, v1, "verifier-secret"), true);
    assert.equal(verifyLicenseKeyVerifier(raw, v2, "verifier-secret"), true);
    assert.equal(verifyLicenseKeyVerifier(raw, v2, "wrong-secret"), false);
    assert.equal(verifyLicenseKeyVerifier("SM-TEST-AAAAA-BBBBB-CCCCC-XXXXX", v2, "verifier-secret"), false);
  });

  it("F-07: v2 rows re-encrypt to v3 and old v1/v2 rows still decrypt (backward compat)", () => {
    const v1 = encryptSecretAtRest("old-row", MASTER, "v1", "test:aad");
    const v2 = encryptSecretAtRest("mid-row", MASTER, "v2", "test:aad");
    assert.equal(needsReEncryption(v1), true);
    assert.equal(needsReEncryption(v2), true);
    assert.equal(decryptSecretAtRest(v1, MASTER, "test:aad"), "old-row");
    assert.equal(decryptSecretAtRest(v2, MASTER, "test:aad"), "mid-row");
    for (const old of [v1, v2]) {
      const v3 = reEncryptSecretAtRest(old, MASTER, "test:aad");
      assert.ok(v3.startsWith("v3:"));
      assert.equal(decryptSecretAtRest(v3, MASTER, "test:aad"), decryptSecretAtRest(old, MASTER, "test:aad"));
      assert.equal(needsReEncryption(v3), false);
    }
    // Two v3 envelopes of the same plaintext differ (random salt + IV).
    const a = encryptSecretAtRest("same", MASTER, "v3", "test:aad");
    const b = encryptSecretAtRest("same", MASTER, "v3", "test:aad");
    assert.notEqual(a, b);
    assert.notEqual(a.split(":")[1], b.split(":")[1]);
  });
});

describe("L-9 — favicon SVG full-document check", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const good = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#00E599"/></svg>';

  it("accepts a well-formed SVG (with XML declaration)", () => {
    verifyFaviconBytes(enc(`<?xml version="1.0" encoding="UTF-8"?>${good}`), "image/svg+xml");
    verifyFaviconBytes(enc(good), "image/svg+xml");
  });

  it("rejects a <script> placed AFTER byte 2048 (the old blind spot)", () => {
    const pad = `<g>${" ".repeat(3000)}</g>`;
    const evil = `<svg xmlns="http://www.w3.org/2000/svg">${pad}<script>alert(1)</script></svg>`;
    assert.ok(evil.indexOf("<script") > 2048);
    assert.throws(
      () => verifyFaviconBytes(enc(evil), "image/svg+xml"),
      (err: unknown) => (err as { code?: string }).code === "UNSUPPORTED_MEDIA_TYPE"
    );
  });

  it("rejects event handlers and javascript: URLs anywhere in the document", () => {
    assert.throws(() =>
      verifyFaviconBytes(
        enc('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" onload="alert(1)"/></svg>'),
        "image/svg+xml"
      )
    );
    assert.throws(() =>
      verifyFaviconBytes(
        enc('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'),
        "image/svg+xml"
      )
    );
    assert.throws(() =>
      verifyFaviconBytes(
        enc('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>hi</div></foreignObject></svg>'),
        "image/svg+xml"
      )
    );
  });

  it("rejects malformed XML and non-SVG documents", () => {
    assert.throws(() => verifyFaviconBytes(enc('<svg xmlns="http://www.w3.org/2000/svg"><rect>'), "image/svg+xml"));
    assert.throws(() => verifyFaviconBytes(enc("<html><body>not svg</body></html>"), "image/svg+xml"));
    // An XML stylesheet processing instruction is NOT a declaration —
    // it must still be rejected, not stripped with the declaration.
    assert.throws(() =>
      verifyFaviconBytes(
        enc('<?xml-stylesheet href="https://example.com/x.css"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'),
        "image/svg+xml"
      )
    );
  });
});

describe("F-05 — AdminCreateOrderSchema activation_date refine", () => {
  const base = {
    product_id: "00000000-0000-4000-8000-000000000001",
    customer_id: "00000000-0000-4000-8000-000000000002",
  };
  const todayUtc = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  it("rejects a past date, a DD/MM/YYYY date, and an impossible date", () => {
    for (const bad of ["2020-01-01", "15/11/2026", "2026-02-30", "not-a-date"]) {
      const r = AdminCreateOrderSchema.safeParse({
        ...base,
        activation_mode: "on_date",
        activation_date: bad,
      });
      assert.equal(r.success, false, bad);
    }
  });

  it("accepts today and tomorrow; on_full_payment needs no date", () => {
    assert.equal(
      AdminCreateOrderSchema.safeParse({ ...base, activation_mode: "on_date", activation_date: todayUtc }).success,
      true
    );
    assert.equal(
      AdminCreateOrderSchema.safeParse({ ...base, activation_mode: "on_date", activation_date: tomorrow }).success,
      true
    );
    assert.equal(
      AdminCreateOrderSchema.safeParse({ ...base, activation_mode: "on_full_payment" }).success,
      true
    );
  });
});

describe("H-02 — CreateCustomerSchema accepts address natively", () => {
  const ADDRESS = {
    address_line_1: "House 12, Road 5",
    address_line_2: null,
    city: "Dhaka",
    state_or_region: null,
    postal_code: "1212",
    country_code: "BD",
    is_default: true,
  };

  it("parses the address in the same body (no strip needed)", () => {
    const parsed = CreateCustomerSchema.parse({
      name: "Schema Amina",
      email: "schema-amina@example.com",
      address: ADDRESS,
    });
    assert.equal(parsed.address?.address_line_1, "House 12, Road 5");
    assert.equal(parsed.address?.city, "Dhaka");
  });

  it("one-request create still creates customer + address; a bad address 422s with NO customer left", async () => {
    const store = new StackMateDataStore();
    const created = await createCustomerByAdmin(
      store,
      SUPER_ACTOR,
      { name: "Atomic Amina", email: "atomic-amina@example.com", phone: "01711111111", address: ADDRESS },
      "test:remainders-h02-1"
    );
    assert.ok(created.address);
    assert.equal(created.address.line1, "House 12, Road 5");
    assert.equal(store.state.customers.length, 1);
    assert.equal(store.state.customer_addresses.length, 1);

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
          "test:remainders-h02-2"
        ),
      (err: unknown) => err instanceof SchemaValidationError
    );
    assert.equal(store.state.customers.length, 1, "no customer left behind by the failed create");
  });
});

describe("L-13 — CreateRoleSchema permissions cap", () => {
  it("rejects 65 permissions, accepts 64", () => {
    const many = Array.from({ length: 65 }, (_, i) => `perm.key_${i}`);
    assert.equal(
      CreateRoleSchema.safeParse({ key: "test_role", name: "Test", permissions: many }).success,
      false
    );
    const ok = Array.from({ length: 64 }, (_, i) => `perm.key_${i}`);
    assert.equal(
      CreateRoleSchema.safeParse({ key: "test_role", name: "Test", permissions: ok }).success,
      true
    );
  });
});

describe("F-03 — RecordManualRefundSchema", () => {
  const valid = {
    payment_transaction_id: "00000000-0000-4000-8000-000000000001",
    amount_minor: 50000,
    currency_code: "BDT",
    reason: "Customer asked for a refund.",
    provider_refund_id: "bKashRefund123",
  };

  it("accepts a transaction refund and an order refund", () => {
    assert.equal(RecordManualRefundSchema.safeParse(valid).success, true);
    assert.equal(
      RecordManualRefundSchema.safeParse({
        order_id: "00000000-0000-4000-8000-000000000002",
        amount_minor: 100,
        currency_code: "bdt",
        reason: "r",
      }).success,
      true
    );
  });

  it("rejects both/neither reference, zero amount, bad currency, over-long reason", () => {
    assert.equal(
      RecordManualRefundSchema.safeParse({ ...valid, order_id: "00000000-0000-4000-8000-000000000002" }).success,
      false,
      "both references"
    );
    const { payment_transaction_id: _omit, ...noRef } = valid;
    assert.equal(RecordManualRefundSchema.safeParse(noRef).success, false, "neither reference");
    assert.equal(RecordManualRefundSchema.safeParse({ ...valid, amount_minor: 0 }).success, false);
    assert.equal(RecordManualRefundSchema.safeParse({ ...valid, currency_code: "BD" }).success, false);
    assert.equal(
      RecordManualRefundSchema.safeParse({ ...valid, reason: "x".repeat(1001) }).success,
      false
    );
  });
});

describe("F-12 — business-timezone boundaries", () => {
  // 2026-11-16T19:00:00Z is 2026-11-17 01:00 in Dhaka but still
  // 2026-11-16 in UTC — the boundary case the UTC code got wrong.
  const NOW = new Date("2026-11-16T19:00:00.000Z");

  it("businessTodayIso: Dhaka says 2026-11-17, UTC says 2026-11-16", () => {
    assert.equal(businessTodayIso(NOW, "Asia/Dhaka"), "2026-11-17");
    assert.equal(businessTodayIso(NOW, "UTC"), "2026-11-16");
  });

  it("activationDueNow (on_date 2026-11-17): due in Dhaka, not yet in UTC", () => {
    const order = {
      activation_mode: "on_date",
      activation_date: "2026-11-17",
      total_minor: 100000,
    } as Parameters<typeof activationDueNow>[0];
    assert.equal(activationDueNow(order, 0, NOW, "Asia/Dhaka").due, true);
    assert.equal(activationDueNow(order, 0, NOW, "UTC").due, false);
  });

  it("planSweepInTx marks an installment overdue on the Dhaka date, not the UTC date", () => {
    const buildState = () => {
      const store = new StackMateDataStore();
      const state = store.state;
      state.order_installments.push({
        id: "inst-test-1",
        order_id: "order-test-1",
        installment_number: 1,
        amount_minor: 100000,
        paid_amount_minor: 0,
        due_date: "2026-11-16",
        status: "pending",
        paid_at: null,
        notes: null,
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-01T00:00:00.000Z",
      });
      return state;
    };
    const dhaka = planSweepInTx(buildState(), NOW, "test-verifier", "test:f12-dhaka", "Asia/Dhaka");
    assert.equal(dhaka.installments_marked_overdue, 1);
    assert.deepEqual(dhaka.errors, []);
    const utc = planSweepInTx(buildState(), NOW, "test-verifier", "test:f12-utc", "UTC");
    assert.equal(utc.installments_marked_overdue, 0);
    assert.deepEqual(utc.errors, []);
  });
});

describe.skipIf(!DATABASE_URL)("M-23 — users.avatar_url round-trips through the DrizzleStore", () => {
  const DB_NAME = "stackmate_test_avatar";
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

  it("set → reload → clear → reload round-trips avatar_url (insert + update persist)", async () => {
    const dbUrl = new URL(DATABASE_URL!);
    dbUrl.pathname = `/${DB_NAME}`;
    const userId = SUPER_ACTOR.user.id;

    await store.withTransaction((state) => {
      const user = state.users.find((u) => u.id === userId)!;
      user.avatar_url = "avatars/test-super-admin.png";
    });
    let reloaded = await DrizzleStore.create({ connectionString: dbUrl.toString() });
    try {
      const seen = (await reloaded.loadState()).users.find((u) => u.id === userId)!;
      assert.equal(seen.avatar_url, "avatars/test-super-admin.png");
    } finally {
      await reloaded.close();
    }

    await store.withTransaction((state) => {
      const user = state.users.find((u) => u.id === userId)!;
      user.avatar_url = null;
    });
    reloaded = await DrizzleStore.create({ connectionString: dbUrl.toString() });
    try {
      const seen = (await reloaded.loadState()).users.find((u) => u.id === userId)!;
      assert.equal(seen.avatar_url, null);
    } finally {
      await reloaded.close();
    }
  });
});
