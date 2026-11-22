/**
 * API-domain audit fixes — licensing/activation (F-04, F-15, F-06, M-14d).
 *
 *  - F-04: a manual staff suspension must NEVER be silently
 *    auto-reactivated by the missed-schedule sweep. The regression
 *    sequence: missed-schedule suspend → admin resumes → admin
 *    suspends again → installment paid → sweep must NOT reactivate
 *    (the latest license_events row is the manual suspension).
 *  - F-15: revoking an already-revoked license 409s — no duplicate
 *    outbox event or audit row.
 *  - F-06: outbox event keys are deterministic (aggregate + type +
 *    license_events row id) — repeated transitions never collide.
 *  - M-14d: license activate/deactivate write audit rows, but only
 *    on real transitions (heartbeat re-activations and idempotent
 *    re-deactivations write none).
 *
 * In-memory (no Postgres).
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SUPER_ACTOR,
  seedCustomer,
  seedLicense,
  seedOrder,
  seedProduct,
} from "./customer-order-helpers.ts";
import { StackMateDataStore } from "../src/platform/db/store.ts";
import {
  activateLicenseInstallation,
  deactivateLicenseInstallation,
  transitionLicenseStatusByAdmin,
} from "../src/modules/licensing/service.ts";
import { evaluateSuspensionForOrderInTx } from "../src/modules/activation/service.ts";
import { createInstallmentsForOrderInTx } from "../src/modules/payments/service.ts";
import { computeLicenseKeyVerifier } from "../src/platform/crypto/index.ts";
import type { AppError } from "../src/shared/errors.ts";

const VERIFIER_SECRET = "test-verifier-secret";
const LICENSE_KEY = "TEST-LICENSE-KEY-123456";
const NOW = new Date("2026-11-19T12:00:00+06:00");

describe("licensing — audit fixes (F-04, F-15, F-06, M-14d)", () => {
  let store: StackMateDataStore;

  beforeEach(() => {
    store = new StackMateDataStore();
  });

  /** Order with suspend-on-missed-schedule + a license on its item. */
  async function seedSuspendableOrder() {
    let orderId = "";
    let licenseId = "";
    let productCode = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Lic Test" });
      const order = seedOrder(state, customer.id, product, {
        suspend_on_missed_schedule: true,
      });
      createInstallmentsForOrderInTx(
        state,
        order,
        { kind: "full", due_date: "2026-11-01" },
        new Date("2026-11-17T00:00:00.000Z"),
      );
      const license = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        source_order_item_id: order.items[0]!.id,
      });
      orderId = order.id;
      licenseId = license.id;
      productCode = product.code;
    });
    return {
      order: store.state.orders.find((o) => o.id === orderId)!,
      licenseId,
      productCode,
    };
  }

  /** License with a real key hash + entitlement snapshot, for activate/deactivate. */
  async function seedActivatableLicense() {
    let licenseId = "";
    let productCode = "";
    await store.withTransaction((state) => {
      const product = seedProduct(state);
      const customer = seedCustomer(state, { name: "Act Test" });
      const keyHash = computeLicenseKeyVerifier(LICENSE_KEY, VERIFIER_SECRET);
      const license = seedLicense(state, {
        product_id: product.id,
        customer_id: customer.id,
        license_key_hash: keyHash,
      });
      const snapshotId = randomUUID();
      license.current_entitlement_snapshot_id = snapshotId;
      license.snapshots = [
        {
          id: snapshotId,
          license_id: license.id,
          version_number: 1,
          source_type: "manual_grant",
          effective_at: new Date().toISOString(),
          reason: null,
          snapshot_hash: "test-snapshot-hash",
          items: [],
          created_by_user_id: null,
          created_at: new Date().toISOString(),
        },
      ];
      licenseId = license.id;
      productCode = product.code;
    });
    return { licenseId, productCode };
  }

  it("F-04: manual suspend survives the sweep after the installment is paid", async () => {
    const { order, licenseId } = await seedSuspendableOrder();
    const cfg = { actorUserId: null, requestId: "test:sweep" };

    // 1. Missed schedule suspends the license (event: suspended / missed_schedule).
    const first = await store.withTransaction((state) =>
      evaluateSuspensionForOrderInTx(state, order, NOW, cfg),
    );
    assert.equal(first.suspended.length, 1);
    assert.equal(
      store.state.licenses.find((l) => l.id === licenseId)?.status,
      "suspended",
    );

    // 2. Admin resumes it (event: reactivated / manual).
    await transitionLicenseStatusByAdmin(
      store,
      SUPER_ACTOR,
      licenseId,
      "resume",
      "Customer called",
      "test:resume",
    );
    assert.equal(
      store.state.licenses.find((l) => l.id === licenseId)?.status,
      "active",
    );

    // 3. Admin suspends it again (event: suspended / manual).
    await transitionLicenseStatusByAdmin(
      store,
      SUPER_ACTOR,
      licenseId,
      "suspend",
      "Abuse confirmed",
      "test:suspend",
    );
    const events = store.state.license_events.filter((e) => e.license_id === licenseId);
    assert.equal(events.length, 3);
    const latest = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]!;
    assert.equal(latest.event_type, "suspended");
    assert.equal((latest.metadata as Record<string, unknown>)?.reason, "manual");

    // 4. The installment is paid — nothing is missed anymore.
    await store.withTransaction((state) => {
      for (const inst of state.order_installments) {
        if (inst.order_id === order.id) {
          inst.paid_amount_minor = inst.amount_minor;
          inst.status = "paid";
          inst.paid_at = new Date().toISOString();
        }
      }
    });

    // 5. The sweep must NOT reactivate the manually suspended license.
    const second = await store.withTransaction((state) =>
      evaluateSuspensionForOrderInTx(state, order, NOW, cfg),
    );
    assert.equal(second.reactivated.length, 0);
    assert.equal(
      store.state.licenses.find((l) => l.id === licenseId)?.status,
      "suspended",
    );
  });

  it("F-15: revoking twice 409s — one outbox event, one audit row", async () => {
    const { licenseId } = await seedSuspendableOrder();
    await transitionLicenseStatusByAdmin(
      store,
      SUPER_ACTOR,
      licenseId,
      "revoke",
      "Fraud",
      "test:revoke-1",
    );
    await assert.rejects(
      () =>
        transitionLicenseStatusByAdmin(
          store,
          SUPER_ACTOR,
          licenseId,
          "revoke",
          "Fraud again",
          "test:revoke-2",
        ),
      (err: AppError) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "CONFLICT");
        return true;
      },
    );
    assert.equal(
      store.state.outbox_events.filter((e) => e.event_type === "license.revoked").length,
      1,
    );
    assert.equal(
      store.state.audit_logs.filter((l) => l.action === "licensing.license.revoke").length,
      1,
    );
  });

  it("F-06: suspend/resume outbox keys are deterministic and never collide", async () => {
    const { licenseId } = await seedSuspendableOrder();
    await transitionLicenseStatusByAdmin(
      store,
      SUPER_ACTOR,
      licenseId,
      "suspend",
      "First",
      "test:key-1",
    );
    await transitionLicenseStatusByAdmin(
      store,
      SUPER_ACTOR,
      licenseId,
      "resume",
      "Back",
      "test:key-2",
    );
    await transitionLicenseStatusByAdmin(
      store,
      SUPER_ACTOR,
      licenseId,
      "suspend",
      "Again",
      "test:key-3",
    );
    const keys = store.state.outbox_events.map((e) => e.event_key);
    assert.equal(new Set(keys).size, keys.length);
    const suspendKeys = keys.filter((k) => k.startsWith(`license.suspended:${licenseId}:`));
    assert.equal(suspendKeys.length, 2);
    // Each key carries the license_events row id it describes.
    for (const key of suspendKeys) {
      const eventId = key.split(":").pop()!;
      assert.ok(store.state.license_events.some((e) => e.id === eventId));
    }
  });

  it("M-14d: activate/deactivate audit only real transitions", async () => {
    const { productCode } = await seedActivatableLicense();
    const activateBody = {
      license_key: LICENSE_KEY,
      product_code: productCode,
      installation_id: "install-001",
    };
    const activateCfg = {
      verifierSecret: VERIFIER_SECRET,
      issuerUrl: "https://stackmate.test",
      requestId: "test:act-1",
    };
    const first = await activateLicenseInstallation(store, activateBody, activateCfg);
    assert.equal(first.valid, true);
    assert.equal(first.activation.active_count, 1);
    assert.equal(
      store.state.audit_logs.filter((l) => l.action === "licensing.activation.activated")
        .length,
      1,
    );

    // Heartbeat re-activation of the same installation: no second row.
    await activateLicenseInstallation(store, activateBody, activateCfg);
    assert.equal(
      store.state.audit_logs.filter((l) => l.action === "licensing.activation.activated")
        .length,
      1,
    );

    const deactivateBody = {
      license_key: LICENSE_KEY,
      product_code: productCode,
      installation_id: "install-001",
    };
    const deactivated = await deactivateLicenseInstallation(store, deactivateBody, {
      verifierSecret: VERIFIER_SECRET,
      requestId: "test:deact-1",
    });
    assert.equal(deactivated.deactivated, true);
    assert.equal(deactivated.active_count, 0);
    assert.equal(
      store.state.audit_logs.filter((l) => l.action === "licensing.activation.deactivated")
        .length,
      1,
    );

    // Idempotent re-deactivation: no second row.
    await deactivateLicenseInstallation(store, deactivateBody, {
      verifierSecret: VERIFIER_SECRET,
      requestId: "test:deact-2",
    });
    assert.equal(
      store.state.audit_logs.filter((l) => l.action === "licensing.activation.deactivated")
        .length,
      1,
    );
  });
});
