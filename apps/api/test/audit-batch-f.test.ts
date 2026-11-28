/**
 * Audit fix Batch F (2026-11-25) — security hardening, identity/crypto.
 *
 *  - F-04: invite/reset tokens + site secrets are HMAC-peppered for new
 *    rows; old bare-SHA-256 rows still verify (backward compat).
 *  - F-05: common/breached passwords rejected at set/change time
 *    (length ≥10 floor unchanged, no complexity rules).
 *  - F-07: v3 envelope (random per-envelope salt), re-encryption path,
 *    HKDF-derived license/checkout HMAC keys.
 *  - A-15: verifyEntitlementJws JSON parses wrapped (LICENSE_INVALID).
 *
 * In-memory only (no Postgres needed): the reset-token DB round-trip
 * stays covered by the existing Postgres suites (auth-email.test.ts),
 * which keep passing with legacy hashes.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  hashTokenPeppered,
  verifyTokenHash,
  issueCheckoutAccessToken,
  verifyCheckoutAccessToken,
  generateEd25519KeyMaterial,
  signEntitlementJws,
  verifyEntitlementJws,
  encryptSecretAtRest,
  decryptSecretAtRest,
  needsReEncryption,
  reEncryptSecretAtRest,
} from "../src/platform/crypto/index.ts";
import {
  acceptStaffInvitation,
  bootstrapInitialSuperAdmin,
  changeStaffPassword,
  createPasswordResetToken,
  createStaffInvitationByAdmin,
  type StaffPrincipal,
} from "../src/modules/identity/service.ts";
import {
  AcceptStaffInvitationSchema,
  isCommonPassword,
} from "../../../packages/contracts/src/index.ts";
import { AppError } from "../src/shared/errors.ts";

const PEPPER = "test-pepper-do-not-use-in-production-0123456789";
const MASTER = "test-master-secret-2026";

function superPrincipal(userId: string): StaffPrincipal {
  return {
    user: {
      id: userId,
      name: "Batch F Admin",
      email: "batchf-admin@stackmate.local",
      status: "active",
      avatar_url: null,
      email_verified: true,
    },
    session_id: "test-session",
    roles: ["super_admin"],
    permissions: ["users.manage"],
    two_factor_enabled: false,
    two_factor_setup_required: false,
  };
}

describe("F-04 — peppered token hashes (crypto unit)", () => {
  it("new hashes are peppered HMACs; old bare SHA-256 rows still verify", () => {
    const raw = "inv_test-token-1234567890";
    const peppered = hashTokenPeppered(raw, PEPPER);
    assert.ok(peppered.startsWith("peppered:"));
    assert.equal(verifyTokenHash(raw, peppered, PEPPER), true);
    assert.equal(verifyTokenHash(raw, peppered, "wrong-pepper"), false);
    // A peppered row with NO pepper available fails closed, never
    // silently falls back to the unpeppered hash.
    assert.equal(verifyTokenHash(raw, peppered, undefined), false);
    assert.equal(verifyTokenHash("other-token", peppered, PEPPER), false);

    // Old row: bare SHA-256 (no pepper) still verifies, with or
    // without a pepper configured.
    const legacy = hashTokenPeppered(raw);
    assert.ok(!legacy.startsWith("peppered:"));
    assert.equal(verifyTokenHash(raw, legacy, PEPPER), true);
    assert.equal(verifyTokenHash(raw, legacy, undefined), true);
    assert.equal(verifyTokenHash("other-token", legacy, PEPPER), false);
  });

  it("createPasswordResetToken mints peppered hashes when a pepper is given", () => {
    const store = new StackMateDataStore();
    const peppered = createPasswordResetToken(store, randomUUID(), "password_reset", PEPPER);
    assert.ok(peppered.tokenHash.startsWith("peppered:"));
    assert.equal(verifyTokenHash(peppered.rawToken, peppered.tokenHash, PEPPER), true);
    const legacy = createPasswordResetToken(store, randomUUID(), "password_reset");
    assert.ok(!legacy.tokenHash.startsWith("peppered:"));
    assert.equal(verifyTokenHash(legacy.rawToken, legacy.tokenHash, PEPPER), true);
  });
});

describe("F-04 — invitations: peppered mint + legacy accept (in-memory)", () => {
  let store: StackMateDataStore;
  let actor: StaffPrincipal;

  beforeEach(async () => {
    store = new StackMateDataStore();
    const boot = await bootstrapInitialSuperAdmin(store, {
      name: "Batch F Admin",
      email: "batchf-admin@stackmate.local",
      password: "BatchF-Admin-Strong-99",
      requestId: "batch-f-test",
    });
    actor = superPrincipal(boot.user.id);
  });

  it("new invitation is peppered and accepts; a legacy SHA-256 invitation still accepts", async () => {
    const created = await createStaffInvitationByAdmin(
      store,
      actor,
      { name: "New Invitee", email: "new-invitee@stackmate.local", role_keys: ["admin"] },
      "batch-f-test",
      PEPPER
    );
    const storedNew = store.state.staff_invitations!.find(
      (i) => i.email === "new-invitee@stackmate.local"
    )!;
    assert.ok(storedNew.token_hash.startsWith("peppered:"));
    assert.equal(
      verifyTokenHash(created.token_once, storedNew.token_hash, PEPPER),
      true
    );
    const accepted = await acceptStaffInvitation(
      store,
      { token: created.token_once, name: "New Invitee", password: "Invitee-Strong-Pass-77" },
      "batch-f-test",
      PEPPER
    );
    assert.equal(accepted.user.email, "new-invitee@stackmate.local");

    // Legacy row: mint without a pepper, accept WITH a pepper
    // configured — the old bare hash must still verify.
    const legacy = await createStaffInvitationByAdmin(
      store,
      actor,
      { name: "Legacy Invitee", email: "legacy-invitee@stackmate.local", role_keys: ["admin"] },
      "batch-f-test"
    );
    const storedLegacy = store.state.staff_invitations!.find(
      (i) => i.email === "legacy-invitee@stackmate.local"
    )!;
    assert.ok(!storedLegacy.token_hash.startsWith("peppered:"));
    const acceptedLegacy = await acceptStaffInvitation(
      store,
      { token: legacy.token_once, name: "Legacy Invitee", password: "Legacy-Strong-Pass-88" },
      "batch-f-test",
      PEPPER
    );
    assert.equal(acceptedLegacy.user.email, "legacy-invitee@stackmate.local");
  });

  it("wrong token still 401 with a pepper configured", async () => {
    await createStaffInvitationByAdmin(
      store,
      actor,
      { name: "Wrong Token", email: "wrong-token@stackmate.local", role_keys: ["admin"] },
      "batch-f-test",
      PEPPER
    );
    await assert.rejects(
      () =>
        acceptStaffInvitation(
          store,
          { token: "inv_wrong-token-value-0123456789abcdef", name: "Wrong Token", password: "Wrong-Token-Pass-99" },
          "batch-f-test",
          PEPPER
        ),
      (err: unknown) => err instanceof AppError && err.statusCode === 401
    );
  });
});

describe("F-05 — common/breached passwords rejected, length floor kept", () => {
  it("isCommonPassword: listed words and digit-suffixed bases, case-insensitive", () => {
    assert.equal(isCommonPassword("Password1234"), true);
    assert.equal(isCommonPassword("password"), true);
    assert.equal(isCommonPassword("admin2024"), true);
    assert.equal(isCommonPassword("qwerty"), true);
    assert.equal(isCommonPassword("letmein"), true);
    assert.equal(isCommonPassword("Tr0ub4dor-9xQw!z"), false);
    assert.equal(isCommonPassword("Correct-Horse-Battery-99"), false);
    assert.equal(isCommonPassword("BatchF-Admin-Strong-99"), false);
  });

  it("invite-accept schema rejects a common password (422-style validation error)", () => {
    assert.throws(() =>
      AcceptStaffInvitationSchema.parse({
        token: "inv_0123456789abcdef0123456789abcdef",
        name: "Someone",
        password: "Password1234",
      })
    );
    const ok = AcceptStaffInvitationSchema.parse({
      token: "inv_0123456789abcdef0123456789abcdef",
      name: "Someone",
      password: "Tr0ub4dor-9xQw!z",
    });
    assert.equal(ok.password, "Tr0ub4dor-9xQw!z");
  });

  it("bootstrap + change-password reject common passwords, accept strong ones", async () => {
    const store = new StackMateDataStore();
    await assert.rejects(
      () =>
        bootstrapInitialSuperAdmin(store, {
          name: "Weak Admin",
          email: "weak-admin@stackmate.local",
          password: "Password1234",
          requestId: "batch-f-test",
        }),
      (err: unknown) => err instanceof AppError && err.statusCode === 422
    );
    // Short passwords still fail on length, not on the common list.
    await assert.rejects(
      () =>
        bootstrapInitialSuperAdmin(store, {
          name: "Short Admin",
          email: "short-admin@stackmate.local",
          password: "short",
          requestId: "batch-f-test",
        }),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 422 &&
        /at least 10/.test(err.message)
    );

    const boot = await bootstrapInitialSuperAdmin(store, {
      name: "Strong Admin",
      email: "strong-admin@stackmate.local",
      password: "Tr0ub4dor-9xQw!z",
      requestId: "batch-f-test",
    });
    const principal = superPrincipal(boot.user.id);
    // Test-adapter branch (no Better Auth): wrong current 401,
    // common new password 422, strong new password succeeds.
    await assert.rejects(
      () =>
        changeStaffPassword(store, principal, {
          currentPassword: "Tr0ub4dor-9xQw!z",
          newPassword: "Password1234",
          requestId: "batch-f-test",
        }),
      (err: unknown) => err instanceof AppError && err.statusCode === 422
    );
    const changed = await changeStaffPassword(store, principal, {
      currentPassword: "Tr0ub4dor-9xQw!z",
      newPassword: "N3w-Strong-Pass-42!",
      requestId: "batch-f-test",
    });
    assert.equal(changed.changed, true);
  });
});

describe("F-07 — v3 envelope + HKDF checkout keys", () => {
  it("new writes are v3 with a random per-envelope salt; v1/v2 still decrypt; re-encrypt sweeps to v3", () => {
    const v3 = encryptSecretAtRest("fresh", MASTER, undefined, "test:aad");
    assert.ok(v3.startsWith("v3:"));
    assert.equal(v3.split(":").length, 5);
    assert.equal(needsReEncryption(v3), false);
    assert.equal(decryptSecretAtRest(v3, MASTER, "test:aad"), "fresh");

    const v1 = encryptSecretAtRest("old", MASTER, "v1", "test:aad");
    const v2 = encryptSecretAtRest("mid", MASTER, "v2", "test:aad");
    assert.equal(needsReEncryption(v1), true);
    assert.equal(needsReEncryption(v2), true);
    assert.equal(decryptSecretAtRest(v1, MASTER, "test:aad"), "old");
    assert.equal(decryptSecretAtRest(v2, MASTER, "test:aad"), "mid");
    const swept = reEncryptSecretAtRest(v1, MASTER, "test:aad");
    assert.ok(swept.startsWith("v3:"));
    assert.equal(decryptSecretAtRest(swept, MASTER, "test:aad"), "old");
    assert.throws(() => decryptSecretAtRest(v3, "wrong-secret", "test:aad"));
    assert.throws(() => decryptSecretAtRest(v3, MASTER, "other:aad"));
  });

  it("checkout tokens mint with the HKDF key and old SHA-256-keyed tokens still verify", () => {
    const secret = "checkout-secret-2026";
    const payload = {
      oid: randomUUID(),
      ref: "ORD-1",
      sid: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = issueCheckoutAccessToken(payload, secret);
    assert.ok(token.startsWith("smc_v1."));
    const verified = verifyCheckoutAccessToken(token, secret);
    assert.equal(verified.oid, payload.oid);

    // Legacy token: same format, signed with the OLD single-SHA-256
    // derivation — build it by hand and confirm the verifier still
    // accepts it (in-flight 2h tokens must not break on deploy).
    const bodyB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const legacySig = createHmac("sha256", legacyCheckoutKey(secret))
      .update(`sm-checkout-v1.${bodyB64}`, "utf8")
      .digest("base64url");
    const legacyToken = `smc_v1.${bodyB64}.${legacySig}`;
    assert.equal(verifyCheckoutAccessToken(legacyToken, secret).oid, payload.oid);
    assert.throws(() => verifyCheckoutAccessToken(token, "wrong-secret"));
  });
});

describe("A-15 — verifyEntitlementJws malformed JSON is LICENSE_INVALID, not 500", () => {
  const material = generateEd25519KeyMaterial("test-key-1");
  const now = Math.floor(Date.now() / 1000);
  const good = signEntitlementJws(
    {
      iss: "stackmate",
      aud: "stackmate-product:TEST",
      sub: randomUUID(),
      iat: now,
      nbf: now - 60,
      exp: now + 3600,
      jti: randomUUID(),
      entitlement_version: 1,
      product_code: "TEST",
      license_status: "active",
      grace_until: null,
      activation_usage: { active_count: 1, activation_limit: 5 },
      entitlements: {},
    },
    material
  );

  it("valid token still verifies", () => {
    const out = verifyEntitlementJws(good, material.publicKeyPem);
    assert.equal(out.claims.product_code, "TEST");
  });

  it("malformed header JSON throws LICENSE_INVALID 401", () => {
    const parts = good.split(".");
    const bad = `!!!not-json.${parts[1]}.${parts[2]}`;
    assert.throws(
      () => verifyEntitlementJws(bad, material.publicKeyPem),
      (err: unknown) => err instanceof AppError && err.code === "LICENSE_INVALID" && err.statusCode === 401
    );
  });

  it("malformed payload JSON throws LICENSE_INVALID 401", () => {
    const parts = good.split(".");
    const bad = `${parts[0]}.!!!not-json.${parts[2]}`;
    assert.throws(
      () => verifyEntitlementJws(bad, material.publicKeyPem),
      (err: unknown) => err instanceof AppError && err.code === "LICENSE_INVALID" && err.statusCode === 401
    );
  });

  it("non-object payload JSON throws LICENSE_INVALID 401", () => {
    const parts = good.split(".");
    const numPayload = Buffer.from("42", "utf8").toString("base64url");
    const bad = `${parts[0]}.${numPayload}.${parts[2]}`;
    assert.throws(
      () => verifyEntitlementJws(bad, material.publicKeyPem),
      (err: unknown) => err instanceof AppError && err.code === "LICENSE_INVALID" && err.statusCode === 401
    );
  });
});

// -- helpers (test-only) ----------------------------------------------------

function legacyCheckoutKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}
