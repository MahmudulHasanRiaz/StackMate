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
  computeLicenseKeyVerifierV2,
  generateFormattedLicenseKey,
  signEntitlementJws,
  verifyLicenseKeyVerifier,
} from "../../platform/crypto/index.ts";
import type { Client as PgClient } from "pg";
import type {
  DatabaseState,
  LicenseActivationRecord,
  LicenseEntitlementSnapshotRecord,
  LicenseEventRecord,
  LicenseRecord,
  OrderItemRecord,
  OrderRecord,
  StackMateDataStore,
  SubscriptionRecord,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

/**
 * Append one license_events row (F-04). The single implementation for
 * every license transition — the activation module imports this (it
 * already imports `issueLicenseForOrderItemInTx` from here, so the
 * dependency runs one way: activation → licensing, never a cycle).
 * Returns the created row: callers thread its id into the outbox
 * `event_key` (F-06) so the key is deterministic.
 *
 * WHY THIS MATTERS (F-04): the missed-schedule sweep decides
 * reactivation purely from the LATEST license_events row
 * (`missedScheduleSuspendedLicenses`). A manual suspend/resume that
 * writes no row is invisible to the sweep, so a staff suspension
 * could be silently auto-reactivated the next time an installment
 * was paid. Manual transitions therefore write rows with
 * `metadata.reason === "manual"`.
 */
export function recordLicenseEventInTx(
  state: DatabaseState,
  license: LicenseRecord,
  eventType: "activated" | "suspended" | "reactivated" | "expired",
  actorType: "system" | "staff" | "client",
  actorUserId: string | null,
  metadata: Record<string, unknown>,
  nowIso: string
): LicenseEventRecord {
  const row: LicenseEventRecord = {
    id: randomUUID(),
    license_id: license.id,
    event_type: eventType,
    actor_type: actorType,
    actor_user_id: actorUserId,
    activation_id: null,
    metadata,
    created_at: nowIso,
  };
  state.license_events.push(row);
  return row;
}

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
  const keyHash = computeLicenseKeyVerifierV2(rawKey, verifierSecret);

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

/**
 * F-07: find a license by raw key through verifyLicenseKeyVerifier —
 * v2 rows verify with the v2 derivation, v1 rows with v1, so minting
 * v2 never orphans a legacy license. Cost is one HMAC per candidate
 * row (the scan is already O(licenses) in-memory); the future
 * targeted-SQL path (DrizzleStore.findLicenseForValidation, currently
 * unwired) must compute the candidate hashes instead of this scan.
 */
function findLicenseByRawKey(
  state: DatabaseState,
  rawKey: string,
  verifierSecret: string
): LicenseRecord | undefined {
  return state.licenses.find((l) =>
    verifyLicenseKeyVerifier(rawKey, l.license_key_hash, verifierSecret)
  );
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
  config: { verifierSecret: string; issuerUrl: string; requestId: string }
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
    const license = findLicenseByRawKey(state, input.license_key, config.verifierSecret);
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
    // M-14: audit only real transitions (a new activation row, or a
    // non-active one flipped back to active) — not heartbeat
    // re-activations of an already-active installation.
    let changed = false;

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
        changed = true;
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
      changed = true;
    }

    const signed = buildSignedEntitlementToken(store, license, productCode, config.issuerUrl);
    const activeCountAfter = license.activations.filter((a) => a.status === "active").length;

    // M-14: a license activation is a mutation (a seat is consumed) —
    // it belongs in the audit log. Actor "system": the caller proved a
    // license key, not a staff session. The activation id (not the
    // installation hash) is what staff correlate on.
    if (changed) {
      appendAuditLog(state, {
        actor_type: "system",
        action: "licensing.activation.activated",
        resource_type: "license",
        resource_id: license.id,
        outcome: "success",
        request_id: config.requestId,
        changes: {
          license_number: license.license_number,
          activation_id: activation.id,
          environment: activation.environment,
          active_count: activeCountAfter,
          activation_limit: license.activation_limit,
        },
      });
    }

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
    const license = findLicenseByRawKey(state, input.license_key, config.verifierSecret);
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

/**
 * B-01 targeted license validation: the same contract as
 * validateLicenseInstallation, but the lookup + checks run on the
 * targeted reads (findLicenseForValidation) instead of the full
 * in-transaction state — safe on a createTargeted store, whose state
 * holds only seed rows. The candidate hashes are computed here (v2
 * first, then v1) instead of scanning every license row through
 * verifyLicenseKeyVerifier — the same dual-version acceptance the
 * scan provides, as an equality match per hash. The usability checks
 * below mirror assertLicenseIsUsable check-for-check (same codes,
 * messages, statuses, and order), fed by the targeted method's
 * productCode + subscriptionStatus instead of state lookups.
 *
 * B-01 Track A (2026-11-27) — the lookup is ONE statement, not a
 * sequential v2-then-v1 loop: on a DrizzleStore both candidate
 * hashes go in a single findLicenseForValidation([v2, v1]) call,
 * which also returns the signing-key fingerprint in the same
 * statement; ensureSigningKeys(fingerprint) then resolves the keys
 * just before signing (warm path: zero extra queries — see
 * DrizzleStore.ensureSigningKeys). The in-memory store has neither
 * method, so it keeps the sequential loop and its in-memory keys —
 * same results, same errors. The signing keys are therefore always
 * validated (M-16 fingerprint) before any token is signed.
 *
 * The one write on this path is the activation heartbeat
 * (last_seen_at): a single-row targeted UPDATE through the store's
 * database client when one exists, or an in-place touch of the live
 * record on the in-memory store (see touchActivationLastSeen). No
 * transaction, no full load. The expired-status flip the legacy path
 * performs is deliberately NOT reproduced: it runs immediately
 * before the LICENSE_EXPIRED throw, so the legacy transaction rolls
 * it back and it never persisted — the response is identical either
 * way. Validation writes no license_validation_logs row (the legacy
 * path never did either).
 */
export async function validateLicenseInstallationTargeted(
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
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const candidateHashes = [
    computeLicenseKeyVerifierV2(input.license_key, config.verifierSecret),
    computeLicenseKeyVerifier(input.license_key, config.verifierSecret),
  ];
  // B-01 Track A: a DrizzleStore resolves BOTH candidate hashes in
  // ONE statement and returns the signing-key fingerprint in the same
  // statement (see DrizzleStore.findLicenseForValidation). The
  // in-memory store exposes neither merged method, so it keeps the
  // sequential loop below — same results, same errors.
  const drizzle = store as unknown as {
    findLicenseForValidation?: (
      keyHashes: string[],
      opts?: { includeSigningKeyFingerprint?: boolean }
    ) => Promise<
      | (Awaited<ReturnType<typeof store.findLicenseForValidation>> & {
          signingKeyFingerprint: string | null;
        })
      | null
    >;
    ensureSigningKeys?: (fingerprint: string | null) => Promise<void>;
  };
  let found: Awaited<ReturnType<typeof store.findLicenseForValidation>> = null;
  let signingKeyFingerprint: string | null = null;
  // True when the merged Drizzle lookup ran: the keys are then
  // resolved via drizzle.ensureSigningKeys just before signing
  // (called as a method on the store, so `this` stays bound).
  let mergedLookup = false;
  if (
    typeof drizzle.findLicenseForValidation === "function" &&
    typeof drizzle.ensureSigningKeys === "function"
  ) {
    const merged = await drizzle.findLicenseForValidation(candidateHashes, {
      includeSigningKeyFingerprint: true,
    });
    found = merged;
    signingKeyFingerprint = merged?.signingKeyFingerprint ?? null;
    mergedLookup = true;
  } else {
    for (const keyHash of candidateHashes) {
      found = await store.findLicenseForValidation(keyHash);
      if (found) break;
    }
  }
  if (!found) {
    throw new AppError("LICENSE_INVALID", "Invalid license key.", 401);
  }
  const { license, productCode, subscriptionStatus } = found;

  if (
    !productCode ||
    productCode.toUpperCase() !== input.product_code.trim().toUpperCase()
  ) {
    throw new AppError(
      "PRODUCT_MISMATCH",
      `License does not belong to product '${input.product_code}'.`,
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
      throw new AppError("LICENSE_EXPIRED", "This license and its grace period have expired.", 403);
    }
  }
  if (
    license.subscription_id &&
    subscriptionStatus !== null &&
    (subscriptionStatus === "cancelled" || subscriptionStatus === "expired")
  ) {
    const graceMs = license.grace_until ? new Date(license.grace_until).getTime() : 0;
    if (nowMs > graceMs) {
      throw new AppError("SUBSCRIPTION_NOT_ACTIVE", "Underlying subscription is not active.", 403);
    }
  }

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

  await touchActivationLastSeen(store, activation, nowIso);
  // B-01 Track A: resolve the signing keys NOW, against the
  // fingerprint the lookup statement computed — warm path costs no
  // extra query; a rotation/cold cache reloads here, before any
  // token is signed (and fails closed on a corrupt row). In-memory
  // stores skip this: their keys are already in memory from
  // construction. Never signs before this line on a DrizzleStore.
  if (mergedLookup) {
    await drizzle.ensureSigningKeys!(signingKeyFingerprint);
  }
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
}

/**
 * Single-row activation heartbeat for the targeted validate path.
 * When the store carries a database client (DrizzleStore), the touch
 * is one indexed UPDATE by activation id — the same class of
 * targeted single-row write as a validation-log insert, no state
 * load, no transaction. When there is no client (in-memory store),
 * the activation record is the live state object, so the in-place
 * touch is the persist. A failed heartbeat fails the validation
 * (fail closed), exactly as a failed legacy transaction would.
 */
async function touchActivationLastSeen(
  store: StackMateDataStore,
  activation: LicenseActivationRecord,
  nowIso: string
): Promise<void> {
  const withDb = store as unknown as {
    drizzleDb?: { $client: PgClient };
  };
  const client = withDb.drizzleDb?.$client;
  if (client && typeof client.query === "function") {
    await client.query(
      `UPDATE license_activations SET last_seen_at = $1 WHERE id = $2`,
      [nowIso, activation.id]
    );
    return;
  }
  activation.last_seen_at = nowIso;
}

export async function deactivateLicenseInstallation(
  store: StackMateDataStore,
  rawInput: unknown,
  config: { verifierSecret: string; requestId: string }
): Promise<{
  deactivated: true;
  license_number: string;
  active_count: number;
  activation_limit: number;
}> {
  const input = DeactivateLicenseRequestSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const license = findLicenseByRawKey(state, input.license_key, config.verifierSecret);
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
      // M-14: freeing a seat is a mutation — audit the transition
      // (idempotent re-deactivations of an already-deactivated
      // installation write no row).
      appendAuditLog(state, {
        actor_type: "system",
        action: "licensing.activation.deactivated",
        resource_type: "license",
        resource_id: license.id,
        outcome: "success",
        request_id: config.requestId,
        changes: {
          license_number: license.license_number,
          activation_id: activation.id,
        },
      });
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
    // F-07: new licenses mint v2 (HKDF-derived HMAC key). Lookups below
    // verify through verifyLicenseKeyVerifier, so v1 rows keep working.
    const keyHash = computeLicenseKeyVerifierV2(rawKey, verifierSecret);

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

    // F-15: revoke is terminal — revoking an already-revoked license
    // must 409 instead of writing a duplicate outbox event + audit row.
    if (action === "revoke" && license.status === "revoked") {
      throw new AppError("CONFLICT", "License is already revoked.", 409);
    }

    // F-04: manual suspend/resume MUST write license_events rows. The
    // missed-schedule sweep decides reactivation purely from the
    // LATEST license_events row — without a row here, a staff
    // suspension is invisible to the sweep and gets silently
    // auto-reactivated the next time an installment is paid. The rows
    // carry `reason: "manual"` so the sweep never treats them as
    // missed-schedule suspensions.
    let licenseEventId: string | null = null;
    if (action === "suspend") {
      if (license.status !== "active") {
        throw new AppError("CONFLICT", "Only active licenses can be suspended.", 409);
      }
      license.status = "suspended";
      licenseEventId = recordLicenseEventInTx(state, license, "suspended", "staff", actor.user.id, {
        reason: "manual",
        from_status: prev,
        to_status: "suspended",
      }, now).id;
    } else if (action === "resume") {
      if (license.status !== "suspended") {
        throw new AppError("CONFLICT", "Only suspended licenses can be resumed.", 409);
      }
      license.status = "active";
      licenseEventId = recordLicenseEventInTx(state, license, "reactivated", "staff", actor.user.id, {
        reason: "manual",
        from_status: prev,
        to_status: "active",
      }, now).id;
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

    // F-06: the outbox key is deterministic. Suspend/resume keys carry
    // the license_events row id they describe; revoke has no event row
    // (there is no "revoked" license event type) but the F-15 guard
    // above guarantees exactly one successful revoke, so
    // `license.revoke:<id>` can never collide.
    const eventKey =
      action === "revoke"
        ? `license.revoke:${license.id}`
        : action === "suspend"
          ? `license.suspended:${license.id}:${licenseEventId}`
          : `entitlement.updated:${license.id}:${licenseEventId}`;
    state.outbox_events.push({
      id: randomUUID(),
      event_key: eventKey,
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

/* ------------------------------------------------------------------ */
/* E-03: license activation transfer (Roadmap Stage 6 exit, API §12.2) */
/* E-05: signing-key lifecycle wrappers (PRD §13.5, API §16.6)        */
/* ------------------------------------------------------------------ */

/**
 * Transfer one activation to a new installation (E-03).
 *
 * Audited staff command, not a generic PATCH: the source activation is
 * deactivated and the target installation is activated in ONE
 * transaction, reusing the activate/deactivate primitives' rules —
 * the license must be usable (not revoked/suspended), the target must
 * not already hold an active activation, and the source must be
 * active. A previously-deactivated activation for the target
 * installation is reactivated instead of consuming a second seat, the
 * same idempotency the activation endpoint provides. The raw license
 * key is never involved: staff authorize by session + `licenses.manage`.
 *
 * Dual-key note: `installation_id` / `installationId` (and
 * `site_url` / `siteUrl`) are both accepted and normalized here.
 */
export async function transferActivation(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  licenseId: string,
  activationId: string,
  rawInput: unknown,
  requestId: string
): Promise<{
  license: LicenseRecord;
  from_activation: LicenseActivationRecord;
  to_activation: LicenseActivationRecord;
}> {
  assertStaffPermission(actor, "licenses.manage");
  const raw = (rawInput ?? {}) as Record<string, unknown>;
  // Dual-key note: `installation_id` / `installationId` (and
  // `site_url` / `siteUrl`) are both accepted and normalized here.
  // The SPA transfer dialog sends the `new_*` aliases
  // (`new_installation_id`, `new_domain_normalized`) — accept those
  // too, so the UI and the service agree on the body shape.
  const installationId =
    typeof raw.installation_id === "string"
      ? raw.installation_id
      : typeof raw.installationId === "string"
        ? raw.installationId
        : typeof raw.new_installation_id === "string"
          ? raw.new_installation_id
          : null;
  const siteUrl =
    typeof raw.site_url === "string"
      ? raw.site_url
      : typeof raw.siteUrl === "string"
        ? raw.siteUrl
        : typeof raw.new_domain_normalized === "string"
          ? raw.new_domain_normalized
          : null;
  const environmentRaw =
    typeof raw.environment === "string" && raw.environment.trim().length > 0
      ? raw.environment.trim()
      : null;
  const environment: LicenseActivationRecord["environment"] | null =
    environmentRaw === null
      ? null
      : environmentRaw === "production" ||
          environmentRaw === "staging" ||
          environmentRaw === "development" ||
          environmentRaw === "other"
        ? environmentRaw
        : null;
  if (environmentRaw !== null && environment === null) {
    throw new AppError(
      "VALIDATION_ERROR",
      "environment must be one of: production, staging, development, other.",
      422
    );
  }
  const reason =
    typeof raw.reason === "string" && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : "Transferred by staff";
  if (!installationId || installationId.trim().length === 0) {
    throw new AppError("VALIDATION_ERROR", "installation_id is required.", 422);
  }

  return store.withTransaction((state) => {
    const license = state.licenses.find((l) => l.id === licenseId);
    if (!license) throw new AppError("NOT_FOUND", "License not found.", 404);
    if (license.status === "revoked") {
      throw new AppError("LICENSE_REVOKED", "This license has been revoked.", 403);
    }
    if (license.status === "suspended") {
      throw new AppError("LICENSE_SUSPENDED", "This license is currently suspended.", 403);
    }
    const source = license.activations.find((a) => a.id === activationId);
    if (!source) throw new AppError("NOT_FOUND", "License activation not found.", 404);
    if (source.status !== "active") {
      throw new AppError(
        "CONFLICT",
        `Activation is already '${source.status}'.`,
        409
      );
    }

    const targetHash = computeInstallationIdHash(license.id, installationId);
    if (targetHash === source.installation_id_hash) {
      throw new AppError(
        "CONFLICT",
        "Target installation is the same as the source installation.",
        409
      );
    }
    const existingTarget = license.activations.find(
      (a) => a.installation_id_hash === targetHash
    );
    if (existingTarget?.status === "active") {
      throw new AppError(
        "CONFLICT",
        "Target installation already holds an active activation for this license.",
        409
      );
    }
    if (existingTarget?.status === "blocked") {
      throw new AppError("INSTALLATION_NOT_ACTIVE", "Target installation has been blocked.", 403);
    }

    let normalizedDomain: string | null = null;
    if (siteUrl) {
      try {
        normalizedDomain = normalizeInstallationDomain(siteUrl);
      } catch (err) {
        throw new AppError("DOMAIN_NOT_ALLOWED", (err as Error).message, 422);
      }
    }

    const nowIso = new Date().toISOString();
    // Free the source seat first: the transfer can never exceed the
    // activation limit, because the deactivation happens in the same
    // transaction as the new activation.
    source.status = "deactivated";
    source.deactivated_at = nowIso;

    let target: LicenseActivationRecord;
    if (existingTarget) {
      // Reactivate a previously-deactivated installation (same
      // idempotency as activateLicenseInstallation) — no second seat.
      existingTarget.status = "active";
      existingTarget.deactivated_at = null;
      existingTarget.last_seen_at = nowIso;
      if (normalizedDomain) existingTarget.domain_normalized = normalizedDomain;
      if (environment) existingTarget.environment = environment;
      target = existingTarget;
    } else {
      target = {
        id: randomUUID(),
        license_id: license.id,
        installation_id_hash: targetHash,
        domain_normalized: normalizedDomain,
        environment: environment ?? source.environment,
        status: "active",
        activated_at: nowIso,
        last_seen_at: nowIso,
        deactivated_at: null,
        metadata: {
          transferred_from_activation_id: source.id,
          transfer_reason: reason,
          integration_profile: null,
          product_version: null,
          client_version: null,
        },
        created_at: nowIso,
      };
      license.activations.push(target);
    }
    license.updated_at = nowIso;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "licensing.activation.transferred",
      resource_type: "license",
      resource_id: license.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        license_number: license.license_number,
        activation_id: source.id,
        to_activation_id: target.id,
        reason,
      },
    });

    return { license, from_activation: source, to_activation: target };
  });
}

/**
 * E-05: signing-key lifecycle as audited admin operations. The store
 * methods (`rotateSigningKey` / `revokeSigningKey`) already exist and
 * are durable on DrizzleStore (encrypted private JWK in `signing_keys`,
 * old row retired in the same transaction) — these wrappers only add
 * the permission gate, the audit row, and a safe return shape. The
 * private key material is NEVER returned: only the public JWK (which
 * already carries `kid`) leaves the service.
 */
export function listSigningKeysByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal
): { active_key_id: string; keys: Array<Record<string, unknown>> } {
  assertStaffPermission(actor, "licenses.read");
  return {
    active_key_id: store.activeSigningKeyId,
    keys: store.listPublicSigningKeys(),
  };
}

export async function rotateSigningKeyByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<{
  active_key_id: string;
  previous_key_id: string;
  public_key: Record<string, unknown>;
}> {
  assertStaffPermission(actor, "licenses.manage");
  const raw = (rawInput ?? {}) as Record<string, unknown>;
  const provided =
    typeof raw.key_id === "string"
      ? raw.key_id
      : typeof raw.keyId === "string"
        ? raw.keyId
        : null;
  let newKeyId: string;
  if (provided !== null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/.test(provided)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "key_id must start with a letter or digit and use only letters, digits, hyphens, or underscores (3–81 chars).",
        422
      );
    }
    newKeyId = provided;
  } else {
    const day = new Date().toISOString().slice(0, 10);
    newKeyId = `sm-ed25519-${day}-${randomUUID().slice(0, 8)}`;
  }
  const previousKeyId = store.activeSigningKeyId;
  // DrizzleStore persists the new key + retires the old row in one
  // transaction; the base store does the in-memory equivalent.
  const material = await store.rotateSigningKey(newKeyId);
  await store.withTransaction((state) => {
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "licensing.signing_key.rotated",
      resource_type: "signing_key",
      resource_id: material.keyId,
      outcome: "success",
      request_id: requestId,
      changes: { previous_key_id: previousKeyId, new_key_id: material.keyId },
    });
  });
  return {
    active_key_id: material.keyId,
    previous_key_id: previousKeyId,
    public_key: material.publicKeyJwk,
  };
}

export async function revokeSigningKeyByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  keyId: string,
  requestId: string
): Promise<{ revoked_key_id: string }> {
  // Destructive and irreversible for tokens signed with this key —
  // gated on licenses.revoke, the same permission as license revocation.
  assertStaffPermission(actor, "licenses.revoke");
  // The store refuses the active key (rotate first) and unknown ids.
  await store.revokeSigningKey(keyId);
  await store.withTransaction((state) => {
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "licensing.signing_key.revoked",
      resource_type: "signing_key",
      resource_id: keyId,
      outcome: "success",
      request_id: requestId,
      changes: { key_id: keyId },
    });
  });
  return { revoked_key_id: keyId };
}
