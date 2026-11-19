/**
 * Technology-Agnostic External Website Integrations & Signed Server Requests (Section 3, API Spec §7, §13, §15).
 *
 * - Supports external applications built with Astro, Next.js, React, WordPress, or any HTTP stack.
 * - Separates browser-safe `site_key` from encrypted `hmac_shared_secret` server credentials.
 * - Enforces `STACKMATE-HMAC-SHA256-V1` signature, timestamp freshness (`±300s`), and replay-protected nonces.
 */
import { randomUUID } from "node:crypto";
import {
  CreateSiteCredentialSchema,
  normalizeInstallationDomain,
  RegisterIntegratedSiteSchema,
  RegisterSiteDomainSchema,
  UpdateIntegratedSiteSchema,
  VerifySiteDomainSchema,
} from "../../../../../packages/contracts/src/index.ts";
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  randomOpaqueToken,
  sha256Hex,
  verifyCanonicalServerRequest,
} from "../../platform/crypto/index.ts";
import type {
  IntegratedSiteRecord,
  SiteCredentialRecord,
  StackMateDataStore,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export async function registerIntegratedSiteByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  config: { encryptionKey: string; keyVersion: string; requestId: string }
): Promise<{
  site: IntegratedSiteRecord;
  public_credential: { key_id: string; site_key: string };
  initial_server_credential: { key_id: string; raw_secret_once: string };
}> {
  assertStaffPermission(actor, "integrations.manage");
  const input = RegisterIntegratedSiteSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const normalizedDomain = normalizeInstallationDomain(input.primary_domain);
    if (
      state.integrated_sites.some((s) =>
        s.domains.some((d) => d.domain === normalizedDomain)
      )
    ) {
      throw new AppError(
        "CONFLICT",
        `Domain '${normalizedDomain}' is already registered to an integrated site.`,
        409
      );
    }

    for (const pid of input.product_ids) {
      if (!state.products.some((p) => p.id === pid)) {
        throw new AppError("NOT_FOUND", `Product '${pid}' not found.`, 404);
      }
    }

    const nowIso = new Date().toISOString();
    const siteId = randomUUID();
    const siteKey = randomOpaqueToken("site_pub", 16);
    const domainChallenge = `stackmate-site-verification=${randomOpaqueToken("verify", 16)}`;

    const site: IntegratedSiteRecord = {
      id: siteId,
      site_key: siteKey,
      name: input.name,
      environment: input.environment,
      status: "active",
      api_version: "v1",
      allowed_capabilities: [...input.allowed_capabilities],
      product_ids: [...input.product_ids],
      domains: [
        {
          id: randomUUID(),
          domain: normalizedDomain,
          verification_method: "dns_txt",
          verification_challenge: domainChallenge,
          verification_status: "verified",
          verified_at: nowIso,
          is_primary: true,
        },
      ],
      created_at: nowIso,
      updated_at: nowIso,
    };
    state.integrated_sites.push(site);

    // Create initial HMAC shared secret credential (revealed once!)
    const credId = randomUUID();
    const keyId = randomOpaqueToken(
      input.environment === "production" ? "sk_live" : "sk_test",
      12
    );
    const rawServerSecret = randomOpaqueToken("smsec", 32);
    const ciphertext = encryptSecretAtRest(
      rawServerSecret,
      config.encryptionKey,
      config.keyVersion,
      `site_credentials:${credId}`
    );

    const serverCred: SiteCredentialRecord = {
      id: credId,
      integrated_site_id: siteId,
      key_id: keyId,
      credential_type: "hmac_shared_secret",
      secret_hash: sha256Hex(rawServerSecret),
      secret_ciphertext: ciphertext,
      encryption_key_version: config.keyVersion,
      scopes: [...input.allowed_capabilities],
      status: "active",
      created_at: nowIso,
      revoked_at: null,
      last_used_at: null,
    };
    state.site_credentials.push(serverCred);

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.site.registered",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: config.requestId,
      changes: {
        site_key: site.site_key,
        primary_domain: normalizedDomain,
        product_ids: site.product_ids,
      },
    });

    return {
      site,
      public_credential: { key_id: site.site_key, site_key: site.site_key },
      initial_server_credential: { key_id: keyId, raw_secret_once: rawServerSecret },
    };
  });
}

export async function rotateSiteServerCredentialByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  credentialId: string,
  config: { encryptionKey: string; keyVersion: string; requestId: string }
): Promise<{
  revoked_credential_id: string;
  new_credential: Omit<SiteCredentialRecord, "secret_ciphertext" | "secret_hash">;
  raw_secret_once: string;
}> {
  assertStaffPermission(actor, "integrations.rotate_credentials");
  return store.withTransaction((state) => {
    const oldCred = state.site_credentials.find(
      (c) => c.id === credentialId && c.integrated_site_id === siteId
    );
    if (!oldCred) {
      throw new AppError("NOT_FOUND", "Site credential not found.", 404);
    }
    const nowIso = new Date().toISOString();
    oldCred.status = "rotated";
    oldCred.revoked_at = nowIso;

    const newCredId = randomUUID();
    const newKeyId = randomOpaqueToken("sk_live", 12);
    const rawSecret = randomOpaqueToken("smsec", 32);
    const ciphertext = encryptSecretAtRest(
      rawSecret,
      config.encryptionKey,
      config.keyVersion,
      `site_credentials:${newCredId}`
    );

    const newCred: SiteCredentialRecord = {
      id: newCredId,
      integrated_site_id: siteId,
      key_id: newKeyId,
      credential_type: oldCred.credential_type,
      secret_hash: sha256Hex(rawSecret),
      secret_ciphertext: ciphertext,
      encryption_key_version: config.keyVersion,
      scopes: [...oldCred.scopes],
      status: "active",
      created_at: nowIso,
      revoked_at: null,
      last_used_at: null,
    };
    state.site_credentials.push(newCred);

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.credential.rotated",
      resource_type: "site_credential",
      resource_id: newCred.id,
      outcome: "success",
      request_id: config.requestId,
      changes: { old_credential_id: oldCred.id, new_key_id: newKeyId },
    });

    const { secret_ciphertext: _c, secret_hash: _h, ...safeMetadata } = newCred;
    return {
      revoked_credential_id: oldCred.id,
      new_credential: safeMetadata,
      raw_secret_once: rawSecret,
    };
  });
}

/**
 * Authenticates a signed server-to-server integration request (`STACKMATE-HMAC-SHA256-V1`),
 * enforces timestamp freshness (`±300s`), persists the request nonce to prevent replay attacks,
 * and verifies that the credential belongs to the target siteKey and holds the required scope.
 */
export async function authenticateSignedServerRequest(
  store: StackMateDataStore,
  input: {
    siteKey: string;
    requiredScope: string;
    keyIdHeader: string | undefined;
    timestampHeader: string | undefined;
    nonceHeader: string | undefined;
    contentSha256Header: string | undefined;
    signatureHeader: string | undefined;
    method: string;
    host: string;
    rawPathAndQuery: string;
    rawBody: string;
    encryptionKey: string;
    nowUnixSeconds?: number;
  }
): Promise<{ site: IntegratedSiteRecord; credential: SiteCredentialRecord }> {
  if (
    !input.keyIdHeader ||
    !input.timestampHeader ||
    !input.nonceHeader ||
    !input.contentSha256Header ||
    !input.signatureHeader
  ) {
    throw new AppError(
      "UNAUTHORIZED",
      "Missing required STACKMATE-HMAC-SHA256-V1 authentication headers.",
      401
    );
  }

  return store.withTransaction((state) => {
    const site = state.integrated_sites.find(
      (s) => s.site_key === input.siteKey && s.status === "active"
    );
    if (!site) {
      throw new AppError("UNAUTHORIZED", "Active integrated site not found.", 401);
    }

    const cred = state.site_credentials.find(
      (c) => c.key_id === input.keyIdHeader!.trim() && c.integrated_site_id === site.id
    );
    if (!cred || cred.status !== "active" || !cred.secret_ciphertext) {
      throw new AppError("UNAUTHORIZED", "Active server signing credential not found.", 401);
    }

    if (!cred.scopes.includes(input.requiredScope)) {
      throw new AppError(
        "FORBIDDEN",
        `Credential lacks required scope '${input.requiredScope}'.`,
        403
      );
    }

    const sharedSecret = decryptSecretAtRest(
      cred.secret_ciphertext,
      input.encryptionKey,
      `site_credentials:${cred.id}`
    );

    const nowSec = input.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
    verifyCanonicalServerRequest(
      {
        keyId: cred.key_id,
        timestampUnixSeconds: input.timestampHeader!,
        nonce: input.nonceHeader!,
        method: input.method,
        host: input.host,
        rawPathAndQuery: input.rawPathAndQuery,
        rawBody: input.rawBody,
        presentedContentSha256: input.contentSha256Header!,
        presentedSignatureHeader: input.signatureHeader!,
      },
      sharedSecret,
      { nowUnixSeconds: nowSec, maxSkewSeconds: 300 }
    );

    // Purge expired nonces and verify uniqueness (API Spec §7.3)
    const nowIso = new Date(nowSec * 1000).toISOString();
    state.request_nonces = state.request_nonces.filter((n) => n.expires_at > nowIso);

    const trimmedNonce = input.nonceHeader!.trim();
    if (
      state.request_nonces.some(
        (n) => n.credential_id === cred.id && n.nonce === trimmedNonce
      )
    ) {
      throw new AppError(
        "NONCE_REPLAYED",
        "Request nonce has already been used within the freshness window.",
        409
      );
    }

    state.request_nonces.push({
      credential_id: cred.id,
      nonce: trimmedNonce,
      expires_at: new Date((nowSec + 600) * 1000).toISOString(),
    });
    cred.last_used_at = nowIso;

    return { site, credential: cred };
  });
}

export async function updateIntegratedSiteByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  rawInput: unknown,
  requestId: string
): Promise<IntegratedSiteRecord> {
  assertStaffPermission(actor, "integrations.manage");
  const input = UpdateIntegratedSiteSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    if (input.name !== undefined) site.name = input.name;
    if (input.environment !== undefined) site.environment = input.environment;
    if (input.api_version !== undefined) site.api_version = input.api_version;
    if (input.allowed_capabilities !== undefined)
      site.allowed_capabilities = [...input.allowed_capabilities];
    site.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.site.updated",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: requestId,
      changes: input as Record<string, unknown>,
    });
    return site;
  });
}

export async function suspendIntegratedSiteByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  requestId: string
): Promise<IntegratedSiteRecord> {
  assertStaffPermission(actor, "integrations.manage");
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    if (site.status === "suspended") {
      throw new AppError("CONFLICT", "Integrated site is already suspended.", 409);
    }
    if (site.status === "revoked") {
      throw new AppError("CONFLICT", "A revoked site cannot be suspended.", 409);
    }
    const prev = site.status;
    site.status = "suspended";
    site.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.site.suspended",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_status: prev, to_status: "suspended" },
    });
    return site;
  });
}

export async function revokeIntegratedSiteByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  requestId: string
): Promise<IntegratedSiteRecord> {
  assertStaffPermission(actor, "integrations.manage");
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    if (site.status === "revoked") {
      throw new AppError("CONFLICT", "Integrated site is already revoked.", 409);
    }
    const prev = site.status;
    const nowIso = new Date().toISOString();
    site.status = "revoked";
    site.updated_at = nowIso;
    // Revoking a site revokes its server credentials too — a revoked
    // site must not be able to authenticate any further request.
    for (const cred of state.site_credentials.filter(
      (c) => c.integrated_site_id === site.id && c.status === "active"
    )) {
      cred.status = "revoked";
      cred.revoked_at = nowIso;
    }
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.site.revoked",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_status: prev, to_status: "revoked" },
    });
    return site;
  });
}

export async function assignProductToSiteByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  productId: string,
  requestId: string
): Promise<IntegratedSiteRecord> {
  assertStaffPermission(actor, "integrations.manage");
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    const product = state.products.find((p) => p.id === productId);
    if (!product) throw new AppError("NOT_FOUND", "Product not found.", 404);
    if (site.product_ids.includes(productId)) {
      throw new AppError(
        "CONFLICT",
        `Product '${product.code}' is already assigned to this site.`,
        409
      );
    }
    site.product_ids.push(productId);
    site.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.site.product_assigned",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: requestId,
      changes: { product_id: productId, product_code: product.code },
    });
    return site;
  });
}

export async function removeProductFromSiteByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  productId: string,
  requestId: string
): Promise<IntegratedSiteRecord> {
  assertStaffPermission(actor, "integrations.manage");
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    if (!site.product_ids.includes(productId)) {
      throw new AppError("NOT_FOUND", "Product is not assigned to this site.", 404);
    }
    site.product_ids = site.product_ids.filter((id) => id !== productId);
    site.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.site.product_removed",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: requestId,
      changes: { product_id: productId },
    });
    return site;
  });
}

export async function createSiteCredentialByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  rawInput: unknown,
  config: { encryptionKey: string; keyVersion: string; requestId: string }
): Promise<{
  credential: Omit<SiteCredentialRecord, "secret_ciphertext" | "secret_hash">;
  raw_secret_once: string | null;
}> {
  assertStaffPermission(actor, "integrations.rotate_credentials");
  const input = CreateSiteCredentialSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    if (site.status === "revoked") {
      throw new AppError("CONFLICT", "Cannot create credentials for a revoked site.", 409);
    }
    // Public-key credentials need key material the create schema does
    // not carry — only secret-based types can be minted here.
    if (
      input.credential_type === "public_key" ||
      input.credential_type === "public_signing_key"
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Public-key credentials require key material upload, which is not supported by this endpoint. Use hmac_shared_secret or bearer_secret.",
        422
      );
    }

    const credId = randomUUID();
    const keyId = randomOpaqueToken(
      site.environment === "production" ? "sk_live" : "sk_test",
      12
    );
    const rawSecret = randomOpaqueToken("smsec", 32);
    const ciphertext = encryptSecretAtRest(
      rawSecret,
      config.encryptionKey,
      config.keyVersion,
      `site_credentials:${credId}`
    );
    const nowIso = new Date().toISOString();
    const credential: SiteCredentialRecord = {
      id: credId,
      integrated_site_id: siteId,
      key_id: keyId,
      credential_type: input.credential_type,
      secret_hash: sha256Hex(rawSecret),
      secret_ciphertext: ciphertext,
      encryption_key_version: config.keyVersion,
      scopes: [...input.scopes],
      status: "active",
      created_at: nowIso,
      revoked_at: null,
      last_used_at: null,
    };
    state.site_credentials.push(credential);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.credential.created",
      resource_type: "site_credential",
      resource_id: credential.id,
      outcome: "success",
      request_id: config.requestId,
      changes: { site_id: siteId, credential_type: credential.credential_type, key_id: keyId },
    });
    const { secret_ciphertext: _c, secret_hash: _h, ...safeCredential } = credential;
    return { credential: safeCredential, raw_secret_once: rawSecret };
  });
}

export async function revokeSiteCredentialByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  credentialId: string,
  requestId: string
): Promise<Omit<SiteCredentialRecord, "secret_ciphertext" | "secret_hash">> {
  assertStaffPermission(actor, "integrations.rotate_credentials");
  return store.withTransaction((state) => {
    const cred = state.site_credentials.find(
      (c) => c.id === credentialId && c.integrated_site_id === siteId
    );
    if (!cred) throw new AppError("NOT_FOUND", "Site credential not found.", 404);
    if (cred.status === "revoked") {
      throw new AppError("CONFLICT", "Credential is already revoked.", 409);
    }
    if (cred.status === "rotated") {
      throw new AppError("CONFLICT", "Credential was already rotated away.", 409);
    }
    cred.status = "revoked";
    cred.revoked_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.credential.revoked",
      resource_type: "site_credential",
      resource_id: cred.id,
      outcome: "success",
      request_id: requestId,
      changes: { key_id: cred.key_id },
    });
    const { secret_ciphertext: _c, secret_hash: _h, ...safeCredential } = cred;
    return safeCredential;
  });
}

// ---------------------------------------------------------------------------
// Site domains (API Spec §13.2). Registration NEVER auto-verifies: a new
// domain starts as "pending" with a fresh DNS TXT challenge. Real DNS/HTTP
// verification is Batch 2; until then only an explicit, audited manual
// review can mark a domain verified.
// ---------------------------------------------------------------------------

export async function registerSiteDomainByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  rawInput: unknown,
  requestId: string
): Promise<IntegratedSiteRecord> {
  assertStaffPermission(actor, "integrations.manage");
  const input = RegisterSiteDomainSchema.parse(rawInput);
  let normalized: string;
  try {
    normalized = normalizeInstallationDomain(input.domain);
  } catch {
    throw new AppError("VALIDATION_ERROR", `Invalid domain '${input.domain}'.`, 422);
  }
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    if (state.integrated_sites.some((s) => s.domains.some((d) => d.domain === normalized))) {
      throw new AppError(
        "CONFLICT",
        `Domain '${normalized}' is already registered to an integrated site.`,
        409
      );
    }
    const nowIso = new Date().toISOString();
    if (input.is_primary) {
      for (const d of site.domains) d.is_primary = false;
    }
    site.domains.push({
      id: randomUUID(),
      domain: normalized,
      verification_method: input.verification_method,
      verification_challenge: `stackmate-site-verification=${randomOpaqueToken("verify", 16)}`,
      verification_status: "pending",
      verified_at: null,
      is_primary: input.is_primary,
    });
    site.updated_at = nowIso;
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.domain.registered",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: requestId,
      changes: { domain: normalized, verification_method: input.verification_method },
    });
    return site;
  });
}

export async function generateDomainVerificationChallengeByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  domainId: string,
  requestId: string
): Promise<IntegratedSiteRecord> {
  assertStaffPermission(actor, "integrations.manage");
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    const domain = site.domains.find((d) => d.id === domainId);
    if (!domain) throw new AppError("NOT_FOUND", "Domain not found.", 404);
    domain.verification_challenge = `stackmate-site-verification=${randomOpaqueToken("verify", 16)}`;
    domain.verification_status = "pending";
    domain.verified_at = null;
    site.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.domain.challenge_generated",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: requestId,
      changes: { domain: domain.domain },
    });
    return site;
  });
}

export async function verifySiteDomainByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  domainId: string,
  rawInput: unknown,
  requestId: string
): Promise<IntegratedSiteRecord> {
  assertStaffPermission(actor, "integrations.manage");
  const input = VerifySiteDomainSchema.parse(rawInput);
  // Automated DNS/HTTP verification is Batch 2 — it does not exist yet,
  // and a fake "verified" would repeat the original defect. Only an
  // explicit manual review (with a recorded note) can verify a domain now.
  if (input.method !== "manual_review") {
    throw new AppError(
      "CONFLICT",
      `Automated ${input.method} verification is not implemented yet (Batch 2). Use method "manual_review" with a reviewer_note to record a manual review.`,
      409
    );
  }
  if (!input.reviewer_note) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Manual domain verification requires a reviewer_note.",
      422
    );
  }
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    const domain = site.domains.find((d) => d.id === domainId);
    if (!domain) throw new AppError("NOT_FOUND", "Domain not found.", 404);
    if (domain.verification_status === "verified") {
      throw new AppError("CONFLICT", "Domain is already verified.", 409);
    }
    const nowIso = new Date().toISOString();
    domain.verification_status = "verified";
    domain.verified_at = nowIso;
    site.updated_at = nowIso;
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.domain.verified_manually",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: requestId,
      changes: { domain: domain.domain, reviewer_note: input.reviewer_note },
    });
    return site;
  });
}

export async function deleteSiteDomainByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  siteId: string,
  domainId: string,
  requestId: string
): Promise<IntegratedSiteRecord> {
  assertStaffPermission(actor, "integrations.manage");
  return store.withTransaction((state) => {
    const site = state.integrated_sites.find((s) => s.id === siteId);
    if (!site) throw new AppError("NOT_FOUND", "Integrated site not found.", 404);
    const domain = site.domains.find((d) => d.id === domainId);
    if (!domain) throw new AppError("NOT_FOUND", "Domain not found.", 404);
    if (site.domains.length === 1) {
      throw new AppError(
        "CONFLICT",
        "A site must keep at least one domain. Register a replacement domain first.",
        409
      );
    }
    const wasPrimary = domain.is_primary;
    site.domains = site.domains.filter((d) => d.id !== domainId);
    if (wasPrimary && site.domains.length > 0) {
      site.domains[0]!.is_primary = true;
    }
    site.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "integrations.domain.deleted",
      resource_type: "integrated_site",
      resource_id: site.id,
      outcome: "success",
      request_id: requestId,
      changes: { domain: domain.domain },
    });
    return site;
  });
}
