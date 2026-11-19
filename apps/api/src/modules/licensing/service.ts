/**
 * StackMate Licensing Engine (PRD §13, TAD §13, API Spec §16, Section 4.1).
 *
 * Supports WordPress Plugins, WordPress Themes, Licensed Software, and Dedicated SaaS Deployments.
 * - Stores only a keyed HMAC-SHA256 verifier (`license_key_hash`) + `license_key_hint`.
 * - Enforces activation limits atomically inside serialized transactions (`SELECT ... FOR UPDATE`).
 * - Signs compact Ed25519 (`EdDSA`) JWS entitlement documents (`entitlement_token`) containing zero PII.
 */
import { randomUUID } from "node:crypto";
import {
  ActivateLicenseRequestSchema,
  AdminManualGrantLicenseSchema,
  computeCanonicalSnapshotHash,
  DeactivateLicenseRequestSchema,
  type EntitlementTokenClaims,
  normalizeInstallationDomain,
  type TypedEntitlementValue,
  ValidateLicenseRequestSchema,
  validateFeatureEntitlementValue,
} from "../../../../../packages/contracts/src/index.ts";
import {
  computeInstallationIdHash,
  computeLicenseKeyVerifier,
  generateFormattedLicenseKey,
  signEntitlementJws,
} from "../../platform/crypto/index.ts";
import type {
  DatabaseState,
  LicenseActivationRecord,
  LicenseEntitlementSnapshotRecord,
  LicenseRecord,
  OrderItemRecord,
  OrderRecord,
  StackMateDataStore,
  SubscriptionRecord,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export function issueLicenseForOrderItemInTx(
  state: DatabaseState,
  order: OrderRecord,
  orderItem: OrderItemRecord,
  subscription: SubscriptionRecord | null,
  verifierSecret: string
): { license: LicenseRecord; rawKeyOnce: string } {
  const product = state.products.find((p) => p.id === orderItem.product_id);
  if (!product) {
    throw new AppError("NOT_FOUND", "Product for license issuance not found.", 404);
  }

  // Idempotency guard: if a license was already issued for this order item, return it
  const existing = state.licenses.find((l) => l.source_order_item_id === orderItem.id);
  if (existing) {
    return { license: existing, rawKeyOnce: existing.issued_raw_key_once ?? existing.license_key_hint };
  }

  state.sequence_counters.license += 1;
  const licenseNumber = `LIC-${state.sequence_counters.license}`;
  const { rawKey, hint } = generateFormattedLicenseKey(product.code);
  const keyHash = computeLicenseKeyVerifier(rawKey, verifierSecret);

  const nowIso = new Date().toISOString();
  const expiresAt = subscription?.current_period_end ?? null;
  const graceUntil = expiresAt
    ? new Date(
        new Date(expiresAt).getTime() + product.offline_grace_hours * 3600 * 1000
      ).toISOString()
    : null;

  const licenseId = randomUUID();
  const snapshotId = randomUUID();
  const snapshot: LicenseEntitlementSnapshotRecord = {
    id: snapshotId,
    license_id: licenseId,
    version_number: 1,
    source_type: "order_item",
    effective_at: nowIso,
    reason: `Initial fulfillment from Order ${order.order_number}`,
    snapshot_hash: orderItem.entitlement_snapshot.snapshot_hash,
    items: structuredClone(orderItem.entitlement_snapshot.items),
    created_by_user_id: null,
    created_at: nowIso,
  };

  const license: LicenseRecord = {
    id: licenseId,
    license_number: licenseNumber,
    product_id: product.id,
    customer_id: order.customer_id,
    source_order_item_id: orderItem.id,
    subscription_id: subscription?.id ?? null,
    license_key_hash: keyHash,
    license_key_hint: hint,
    issued_raw_key_once: rawKey,
    status: "active",
    activation_limit: orderItem.activation_limit_snapshot,
    valid_from: nowIso,
    expires_at: expiresAt,
    grace_until: graceUntil,
    current_entitlement_snapshot_id: snapshotId,
    snapshots: [snapshot],
    activations: [],
    issued_at: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
  };

  state.licenses.push(license);
  state.outbox_events.push({
    id: randomUUID(),
    event_key: `license.created:${license.id}`,
    aggregate_type: "license",
    aggregate_id: license.id,
    event_type: "license.created",
    payload: {
      license_number: license.license_number,
      product_code: product.code,
      status: license.status,
      expires_at: license.expires_at,
    },
    status: "pending",
    attempt_count: 0,
    available_at: nowIso,
    locked_until: null,
    locked_by: null,
    last_error_code: null,
    created_at: nowIso,
    processed_at: null,
  });

  return { license, rawKeyOnce: rawKey };
}

function buildSignedEntitlementToken(
  store: StackMateDataStore,
  license: LicenseRecord,
  productCode: string,
  issuerUrl: string,
  ttlSeconds = 12 * 3600
): {
  entitlement_token: string;
  entitlement_expires_at: string;
  next_validation_after: string;
  claims: EntitlementTokenClaims;
} {
  const currentSnapshot =
    license.snapshots.find((s) => s.id === license.current_entitlement_snapshot_id) ??
    license.snapshots[license.snapshots.length - 1]!;

  const entitlementsMap: Record<string, TypedEntitlementValue> = {};
  for (const item of currentSnapshot.items) {
    entitlementsMap[item.feature_key_snapshot] = item.entitlement_value as TypedEntitlementValue;
  }

  const activeCount = license.activations.filter((a) => a.status === "active").length;
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + ttlSeconds;
  const refreshSec = nowSec + Math.floor(ttlSeconds / 2);

  const claims: EntitlementTokenClaims = {
    iss: issuerUrl,
    aud: `stackmate-product:${productCode}`,
    sub: license.license_number,
    iat: nowSec,
    nbf: nowSec,
    exp: expSec,
    jti: `ent_${randomUUID()}`,
    entitlement_version: currentSnapshot.version_number,
    product_code: productCode,
    license_status: license.status,
    grace_until: license.grace_until,
    activation_usage: {
      active_count: activeCount,
      activation_limit: license.activation_limit,
    },
    entitlements: entitlementsMap,
  };

  const activeKey = store.getActiveSigningKey();
  const token = signEntitlementJws(claims, activeKey);

  return {
    entitlement_token: token,
    entitlement_expires_at: new Date(expSec * 1000).toISOString(),
    next_validation_after: new Date(refreshSec * 1000).toISOString(),
    claims,
  };
}

function assertLicenseIsUsable(
  state: DatabaseState,
  license: LicenseRecord,
  expectedProductCode: string,
  nowMs = Date.now()
): { productCode: string } {
  const product = state.products.find((p) => p.id === license.product_id);
  if (!product || product.code.toUpperCase() !== expectedProductCode.trim().toUpperCase()) {
    throw new AppError(
      "PRODUCT_MISMATCH",
      `License does not belong to product '${expectedProductCode}'.`,
      403
    );
  }
  if (license.status === "revoked") {
    throw new AppError("LICENSE_REVOKED", "This license has been revoked.", 403);
  }
  if (license.status === "suspended") {
    throw new AppError("LICENSE_SUSPENDED", "This license is currently suspended.", 403);
  }
  if (new Date(license.valid_from).getTime() > nowMs) {
    throw new AppError("LICENSE_NOT_YET_VALID", "This license is not yet valid.", 403);
  }
  if (license.expires_at) {
    const expMs = new Date(license.expires_at).getTime();
    const graceMs = license.grace_until ? new Date(license.grace_until).getTime() : expMs;
    if (nowMs > graceMs) {
      license.status = "expired";
      throw new AppError("LICENSE_EXPIRED", "This license and its grace period have expired.", 403);
    }
  }
  if (license.subscription_id) {
    const sub = state.subscriptions.find((s) => s.id === license.subscription_id);
    if (sub && (sub.status === "cancelled" || sub.status === "expired")) {
      const graceMs = license.grace_until ? new Date(license.grace_until).getTime() : 0;
      if (nowMs > graceMs) {
        throw new AppError("SUBSCRIPTION_NOT_ACTIVE", "Underlying subscription is not active.", 403);
      }
    }
  }
  return { productCode: product.code };
}

/**
 * Atomic, concurrent-safe license activation (API Spec §16.2, Database Design §21.4).
 * Re-activating the same installation_id updates heartbeat idempotently without consuming a new slot.
 */
export async function activateLicenseInstallation(
  store: StackMateDataStore,
  rawInput: unknown,
  config: { verifierSecret: string; issuerUrl: string }
): Promise<{
  valid: true;
  license_number: string;
  license_status: string;
  activation: {
    id: string;
    status: string;
    domain_normalized: string | null;
    environment: string;
    active_count: number;
    activation_limit: number;
  };
  entitlement_token: string;
  entitlement_expires_at: string;
  next_validation_after: string;
}> {
  const input = ActivateLicenseRequestSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const keyHash = computeLicenseKeyVerifier(input.license_key, config.verifierSecret);
    const license = state.licenses.find((l) => l.license_key_hash === keyHash);
    if (!license) {
      throw new AppError("LICENSE_INVALID", "Invalid license key.", 401);
    }

    const { productCode } = assertLicenseIsUsable(state, license, input.product_code);
    const installHash = computeInstallationIdHash(license.id, input.installation_id);
    let normalizedDomain: string | null = null;
    if (input.site_url) {
      try {
        normalizedDomain = normalizeInstallationDomain(input.site_url);
      } catch (err) {
        throw new AppError("DOMAIN_NOT_ALLOWED", (err as Error).message, 422);
      }
    }

    const nowIso = new Date().toISOString();
    let activation = license.activations.find(
      (a) => a.installation_id_hash === installHash
    );

    if (activation) {
      if (activation.status === "blocked") {
        throw new AppError("INSTALLATION_NOT_ACTIVE", "This installation has been blocked.", 403);
      }
      if (activation.status !== "active") {
        const activeCount = license.activations.filter((a) => a.status === "active").length;
        if (activeCount >= license.activation_limit) {
          throw new AppError(
            "ACTIVATION_LIMIT_REACHED",
            `License activation limit (${license.activation_limit}) has been reached.`,
            409
          );
        }
        activation.status = "active";
        activation.deactivated_at = null;
      }
      activation.last_seen_at = nowIso;
      if (normalizedDomain) activation.domain_normalized = normalizedDomain;
      activation.environment = input.environment;
    } else {
      const activeCount = license.activations.filter((a) => a.status === "active").length;
      if (activeCount >= license.activation_limit) {
        throw new AppError(
          "ACTIVATION_LIMIT_REACHED",
          `License activation limit (${license.activation_limit}) has been reached.`,
          409
        );
      }
      activation = {
        id: randomUUID(),
        license_id: license.id,
        installation_id_hash: installHash,
        domain_normalized: normalizedDomain,
        environment: input.environment,
        status: "active",
        activated_at: nowIso,
        last_seen_at: nowIso,
        deactivated_at: null,
        metadata: {
          integration_profile: input.integration_profile,
          product_version: input.product_version ?? null,
          client_version: input.client_version ?? null,
        },
        created_at: nowIso,
      };
      license.activations.push(activation);
    }

    const signed = buildSignedEntitlementToken(store, license, productCode, config.issuerUrl);
    const activeCountAfter = license.activations.filter((a) => a.status === "active").length;

    return {
      valid: true,
      license_number: license.license_number,
      license_status: license.status,
      activation: {
        id: activation.id,
        status: activation.status,
        domain_normalized: activation.domain_normalized,
        environment: activation.environment,
        active_count: activeCountAfter,
        activation_limit: license.activation_limit,
      },
      entitlement_token: signed.entitlement_token,
      entitlement_expires_at: signed.entitlement_expires_at,
      next_validation_after: signed.next_validation_after,
    };
  });
}

export async function validateLicenseInstallation(
  store: StackMateDataStore,
  rawInput: unknown,
  config: { verifierSecret: string; issuerUrl: string }
): Promise<{
  valid: true;
  license_number: string;
  license_status: string;
  entitlement_version: number;
  entitlement_token: string;
  entitlement_expires_at: string;
  next_validation_after: string;
}> {
  const input = ValidateLicenseRequestSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const keyHash = computeLicenseKeyVerifier(input.license_key, config.verifierSecret);
    const license = state.licenses.find((l) => l.license_key_hash === keyHash);
    if (!license) {
      throw new AppError("LICENSE_INVALID", "Invalid license key.", 401);
    }

    const { productCode } = assertLicenseIsUsable(state, license, input.product_code);
    const installHash = computeInstallationIdHash(license.id, input.installation_id);
    const activation = license.activations.find(
      (a) => a.installation_id_hash === installHash && a.status === "active"
    );
    if (!activation) {
      throw new AppError(
        "INSTALLATION_NOT_ACTIVE",
        "Installation is not active for this license. Call /api/v1/licenses/activate first.",
        403
      );
    }

    activation.last_seen_at = new Date().toISOString();
    const signed = buildSignedEntitlementToken(store, license, productCode, config.issuerUrl);

    return {
      valid: true,
      license_number: license.license_number,
      license_status: license.status,
      entitlement_version: signed.claims.entitlement_version,
      entitlement_token: signed.entitlement_token,
      entitlement_expires_at: signed.entitlement_expires_at,
      next_validation_after: signed.next_validation_after,
    };
  });
}

export async function deactivateLicenseInstallation(
  store: StackMateDataStore,
  rawInput: unknown,
  config: { verifierSecret: string }
): Promise<{
  deactivated: true;
  license_number: string;
  active_count: number;
  activation_limit: number;
}> {
  const input = DeactivateLicenseRequestSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const keyHash = computeLicenseKeyVerifier(input.license_key, config.verifierSecret);
    const license = state.licenses.find((l) => l.license_key_hash === keyHash);
    if (!license) {
      throw new AppError("LICENSE_INVALID", "Invalid license key.", 401);
    }
    const product = state.products.find((p) => p.id === license.product_id);
    if (!product || product.code.toUpperCase() !== input.product_code.trim().toUpperCase()) {
      throw new AppError("PRODUCT_MISMATCH", "Product code does not match license.", 403);
    }

    const installHash = computeInstallationIdHash(license.id, input.installation_id);
    const activation = license.activations.find((a) => a.installation_id_hash === installHash);
    if (!activation) {
      throw new AppError(
        "INSTALLATION_NOT_ACTIVE",
        "Matching installation not found for this license.",
        404
      );
    }

    if (activation.status === "active") {
      activation.status = "deactivated";
      activation.deactivated_at = new Date().toISOString();
    }

    const activeCount = license.activations.filter((a) => a.status === "active").length;
    return {
      deactivated: true,
      license_number: license.license_number,
      active_count: activeCount,
      activation_limit: license.activation_limit,
    };
  });
}

export async function createManualLicenseGrantByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  verifierSecret: string,
  requestId: string
): Promise<{ license: LicenseRecord; issued_license_key_once: string }> {
  assertStaffPermission(actor, "licenses.manage");
  const input = AdminManualGrantLicenseSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const customer = state.customers.find((c) => c.id === input.customer_id);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
    const product = state.products.find((p) => p.id === input.product_id);
    if (!product) throw new AppError("NOT_FOUND", "Product not found.", 404);

    const snapshotItems = [];
    for (const [featureKey, rawVal] of Object.entries(input.entitlements)) {
      const featureDef = state.product_features.find(
        (f) => f.product_id === product.id && f.feature_key === featureKey
      );
      if (!featureDef) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Feature '${featureKey}' does not exist on product '${product.code}'.`,
          422
        );
      }
      const validated = validateFeatureEntitlementValue(featureDef.value_type, rawVal);
      snapshotItems.push({
        feature_key_snapshot: featureDef.feature_key,
        value_type_snapshot: featureDef.value_type,
        entitlement_value: validated,
        unit_snapshot: featureDef.unit,
      });
    }

    const snapshotHash = computeCanonicalSnapshotHash(
      snapshotItems.map((si) => ({
        feature_key: si.feature_key_snapshot,
        value_type: si.value_type_snapshot,
        entitlement_value: si.entitlement_value,
        unit: si.unit_snapshot,
      }))
    );

    state.sequence_counters.license += 1;
    const licenseNumber = `LIC-${state.sequence_counters.license}`;
    const { rawKey, hint } = generateFormattedLicenseKey(product.code);
    const keyHash = computeLicenseKeyVerifier(rawKey, verifierSecret);

    const nowIso = new Date().toISOString();
    const licenseId = randomUUID();
    const snapshotId = randomUUID();
    const snapshot: LicenseEntitlementSnapshotRecord = {
      id: snapshotId,
      license_id: licenseId,
      version_number: 1,
      source_type: "manual_grant",
      effective_at: nowIso,
      reason: input.reason,
      snapshot_hash: snapshotHash,
      items: snapshotItems,
      created_by_user_id: actor.user.id,
      created_at: nowIso,
    };

    const license: LicenseRecord = {
      id: licenseId,
      license_number: licenseNumber,
      product_id: product.id,
      customer_id: customer.id,
      source_order_item_id: null,
      subscription_id: null,
      license_key_hash: keyHash,
      license_key_hint: hint,
      issued_raw_key_once: rawKey,
      status: "active",
      activation_limit: input.activation_limit,
      valid_from: nowIso,
      expires_at: input.expires_at ?? null,
      grace_until: input.expires_at ?? null,
      current_entitlement_snapshot_id: snapshotId,
      snapshots: [snapshot],
      activations: [],
      issued_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    };

    state.licenses.push(license);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "licensing.license.manual_grant_created",
      resource_type: "license",
      resource_id: license.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        license_number: license.license_number,
        product_code: product.code,
        reason: input.reason,
      },
    });

    return { license, issued_license_key_once: rawKey };
  });
}

export async function transitionLicenseStatusByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  licenseId: string,
  action: "suspend" | "resume" | "revoke",
  reason: string,
  requestId: string
): Promise<LicenseRecord> {
  if (action === "revoke") {
    assertStaffPermission(actor, "licenses.revoke");
  } else {
    assertStaffPermission(actor, "licenses.manage");
  }

  return store.withTransaction((state) => {
    const license = state.licenses.find((l) => l.id === licenseId);
    if (!license) throw new AppError("NOT_FOUND", "License not found.", 404);
    const prev = license.status;
    const now = new Date().toISOString();

    if (action === "suspend") {
      if (license.status !== "active") {
        throw new AppError("CONFLICT", "Only active licenses can be suspended.", 409);
      }
      license.status = "suspended";
    } else if (action === "resume") {
      if (license.status !== "suspended") {
        throw new AppError("CONFLICT", "Only suspended licenses can be resumed.", 409);
      }
      license.status = "active";
    } else if (action === "revoke") {
      license.status = "revoked";
      for (const act of license.activations) {
        if (act.status === "active") {
          act.status = "deactivated";
          act.deactivated_at = now;
        }
      }
    }
    license.updated_at = now;

    state.outbox_events.push({
      id: randomUUID(),
      event_key: `license.${action}:${license.id}:${Date.now()}`,
      aggregate_type: "license",
      aggregate_id: license.id,
      event_type:
        action === "suspend"
          ? "license.suspended"
          : action === "revoke"
            ? "license.revoked"
            : "entitlement.updated",
      payload: {
        license_number: license.license_number,
        from_status: prev,
        to_status: license.status,
        reason,
      },
      status: "pending",
      attempt_count: 0,
      available_at: now,
      locked_until: null,
      locked_by: null,
      last_error_code: null,
      created_at: now,
      processed_at: null,
    });

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: `licensing.license.${action}`,
      resource_type: "license",
      resource_id: license.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_status: prev, to_status: license.status, reason },
    });

    return license;
  });
}

export async function appendLicenseEntitlementSnapshotByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  licenseId: string,
  input: {
    reason: string;
    entitlements: Record<string, unknown>;
    requestId: string;
  }
): Promise<LicenseEntitlementSnapshotRecord> {
  assertStaffPermission(actor, "licenses.manage");
  return store.withTransaction((state) => {
    const license = state.licenses.find((l) => l.id === licenseId);
    if (!license) throw new AppError("NOT_FOUND", "License not found.", 404);
    const product = state.products.find((p) => p.id === license.product_id);
    if (!product) throw new AppError("NOT_FOUND", "Product not found.", 404);

    const snapshotItems = [];
    for (const [featureKey, rawVal] of Object.entries(input.entitlements)) {
      const featureDef = state.product_features.find(
        (f) => f.product_id === product.id && f.feature_key === featureKey
      );
      if (!featureDef) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Feature '${featureKey}' does not belong to product '${product.code}'.`,
          422
        );
      }
      const validated = validateFeatureEntitlementValue(featureDef.value_type, rawVal);
      snapshotItems.push({
        feature_key_snapshot: featureDef.feature_key,
        value_type_snapshot: featureDef.value_type,
        entitlement_value: validated,
        unit_snapshot: featureDef.unit,
      });
    }

    const nextVer =
      license.snapshots.reduce((max, s) => Math.max(max, s.version_number), 0) + 1;
    const snapshotHash = computeCanonicalSnapshotHash(
      snapshotItems.map((si) => ({
        feature_key: si.feature_key_snapshot,
        value_type: si.value_type_snapshot,
        entitlement_value: si.entitlement_value,
        unit: si.unit_snapshot,
      }))
    );

    const nowIso = new Date().toISOString();
    const snapshot: LicenseEntitlementSnapshotRecord = {
      id: randomUUID(),
      license_id: license.id,
      version_number: nextVer,
      source_type: "admin_adjustment",
      effective_at: nowIso,
      reason: input.reason,
      snapshot_hash: snapshotHash,
      items: snapshotItems,
      created_by_user_id: actor.user.id,
      created_at: nowIso,
    };

    // Append-only: never mutates previous snapshots in license.snapshots
    license.snapshots.push(snapshot);
    license.current_entitlement_snapshot_id = snapshot.id;
    license.updated_at = nowIso;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "licensing.entitlement_snapshot.created",
      resource_type: "license",
      resource_id: license.id,
      outcome: "success",
      request_id: input.requestId,
      changes: { version_number: nextVer, reason: input.reason, snapshot_hash: snapshotHash },
    });

    return snapshot;
  });
}

/**
 * Staff deactivation of one license installation (API Spec §12.2).
 * The customer-side deactivateLicenseInstallation (license key + product
 * code) is a different trust boundary — this one is staff-authorized and
 * takes the activation id directly. Deactivation frees one seat under
 * the license's activation limit.
 */
export async function deactivateLicenseActivationByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  licenseId: string,
  activationId: string,
  rawInput: unknown,
  requestId: string
): Promise<{ license: LicenseRecord; activation: LicenseActivationRecord }> {
  assertStaffPermission(actor, "licenses.manage");
  const reason =
    typeof (rawInput as { reason?: unknown } | null)?.reason === "string" &&
    ((rawInput as { reason: string }).reason.trim().length ?? 0) > 0
      ? (rawInput as { reason: string }).reason.trim()
      : "Deactivated by staff";
  return store.withTransaction((state) => {
    const license = state.licenses.find((l) => l.id === licenseId);
    if (!license) throw new AppError("NOT_FOUND", "License not found.", 404);
    const activation = license.activations.find((a) => a.id === activationId);
    if (!activation) throw new AppError("NOT_FOUND", "License activation not found.", 404);
    if (activation.status !== "active") {
      throw new AppError(
        "CONFLICT",
        `Activation is already '${activation.status}'.`,
        409
      );
    }
    const nowIso = new Date().toISOString();
    activation.status = "deactivated";
    activation.deactivated_at = nowIso;
    license.updated_at = nowIso;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "licensing.activation.deactivated_by_staff",
      resource_type: "license",
      resource_id: license.id,
      outcome: "success",
      request_id: requestId,
      changes: { activation_id: activation.id, reason },
    });
    return { license, activation };
  });
}
