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
