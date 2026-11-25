/**
 * StackMate Cryptographic Service (ADR-0006):
 * 1. AES-256-GCM envelope encryption with record-bound AAD for recoverable secrets.
 * 2. Keyed HMAC-SHA256 verifier for license keys and checkout tokens.
 * 3. Ed25519 (EdDSA) compact JWS signing and verification for entitlement tokens + JWKS export.
 * 4. STACKMATE-HMAC-SHA256-V1 canonical server request signing & constant-time verification.
 * 5. STACKMATE-WEBHOOK-V1 outbound webhook signing & SSRF URL validator.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  scryptSync,
  sign as nodeSign,
  verify as nodeVerify,
  timingSafeEqual,
} from "node:crypto";
import type { EntitlementTokenClaims } from "../../../../../packages/contracts/src/index.ts";
import { AppError } from "../../shared/errors.ts";

/**
 * Legacy v1 derivation: a single unsalted SHA-256 of the master secret.
 * Kept for two purposes only: (a) the HMAC keys (license verifier,
 * checkout token) — changing those would invalidate every issued
 * license key and checkout token; (b) decrypting v1 envelopes (below).
 * NEVER use it for new encryption.
 */
function derive32ByteKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Master-secret key derivation, v2 (audit M-4): scrypt, a salted
 * memory-hard KDF, instead of the single unsalted SHA-256 of v1.
 *
 * The salt is per-install: derived from the master secret itself, so
 * it differs across installs (no cross-install precomputation) while
 * staying inside the 4-part envelope (`v2:<iv>:<tag>:<ct>` has no room
 * for a stored salt). v3 (F-07) removes that limitation: a random
 * per-envelope salt stored in the 5-part envelope, so two installs
 * sharing a master secret no longer derive the same key.
 *
 * The derived key is cached per (master secret, version) for the life
 * of the isolate — the secret never changes at runtime, and scrypt
 * (~50ms) must not be paid on every request that decrypts a secret.
 * The cache holds only derived keys, never the master secret itself.
 */
const ENCRYPTION_KEY_VERSION_V3 = "v3";
const ENCRYPTION_KEY_VERSION_V2 = "v2";
const ENCRYPTION_KEY_VERSION_V1 = "v1";
const derivedEncryptionKeyCache = new Map<string, Buffer>();

/**
 * v3 key derivation (audit F-07): scrypt with a RANDOM per-envelope
 * salt (16 bytes, stored in the envelope itself). Unlike v2 — whose
 * salt is derived from the master secret, so two installs sharing a
 * secret derive the same key — a v3 salt is fresh per ciphertext, so
 * even identical plaintexts under the same master secret get unrelated
 * keys. The derived key is cached per (master secret, salt) for the
 * life of the isolate; the cache holds only derived keys, never the
 * master secret itself.
 */
function deriveEncryptionKeyV3(masterSecret: string, salt: Buffer): Buffer {
  const cacheKey = `${sha256Hex(masterSecret)}:${ENCRYPTION_KEY_VERSION_V3}:${salt.toString("hex")}`;
  const cached = derivedEncryptionKeyCache.get(cacheKey);
  if (cached) return cached;
  const key = scryptSync(masterSecret, salt, 32, { N: 16384, r: 8, p: 1 });
  if (derivedEncryptionKeyCache.size >= 4) derivedEncryptionKeyCache.clear();
  derivedEncryptionKeyCache.set(cacheKey, key);
  return key;
}

function deriveEncryptionKeyV2(masterSecret: string): Buffer {
  const cacheKey = `${sha256Hex(masterSecret)}:${ENCRYPTION_KEY_VERSION_V2}`;
  const cached = derivedEncryptionKeyCache.get(cacheKey);
  if (cached) return cached;
  const salt = createHash("sha256")
    .update(`stackmate-encryption-salt-v2:${masterSecret}`, "utf8")
    .digest();
  const key = scryptSync(masterSecret, salt, 32, { N: 16384, r: 8, p: 1 });
  if (derivedEncryptionKeyCache.size >= 4) derivedEncryptionKeyCache.clear();
  derivedEncryptionKeyCache.set(cacheKey, key);
  return key;
}

/** Key for an envelope version: v2 → scrypt, v1 → legacy SHA-256.
 * v3 keys need their per-envelope salt — use deriveEncryptionKeyV3
 * directly; asking here throws instead of silently deriving a wrong key. */
function deriveEncryptionKey(masterSecret: string, keyVersion: string): Buffer {
  if (keyVersion === ENCRYPTION_KEY_VERSION_V2) return deriveEncryptionKeyV2(masterSecret);
  if (keyVersion === ENCRYPTION_KEY_VERSION_V1) return derive32ByteKey(masterSecret);
  throw new Error(`Unsupported encryption key version '${keyVersion}'.`);
}

/**
 * True when a stored ciphertext still uses the legacy v1 derivation.
 * Callers that hold a writable row should re-encrypt it (encrypt with
 * the default version) when they read one — that is step (3) of the
 * rotation procedure below.
 */
export function isLegacyV1Ciphertext(encodedCiphertext: string): boolean {
  return encodedCiphertext.startsWith(`${ENCRYPTION_KEY_VERSION_V1}:`);
}

/**
 * True when a stored ciphertext is not yet on the current (v3) envelope.
 * Callers that hold a writable row should re-encrypt it via
 * reEncryptSecretAtRest the next time they write that row.
 */
export function needsReEncryption(encodedCiphertext: string): boolean {
  return !encodedCiphertext.startsWith(`${ENCRYPTION_KEY_VERSION_V3}:`);
}

export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Token hashing (audit F-04): invite / reset / recovery tokens and site
 * secrets are stored as hashes, never raw. New hashes are HMAC-SHA256
 * with a server-side pepper — the existing ENCRYPTION_KEY_V1 master
 * secret, reused as the pepper (no new secret is invented, and the
 * pepper value itself is never written to a file or a log). Stored as
 * `peppered:<hex>`. With no pepper available (e.g. a store that was
 * never given a secret) the legacy bare `sha256Hex` form is used so
 * existing flows keep working; verifyTokenHash accepts both forms, so
 * old rows keep verifying until they expire or rotate.
 */
export function hashTokenPeppered(rawToken: string, pepper?: string | null): string {
  const cleanPepper = pepper?.trim() ?? "";
  if (cleanPepper.length === 0) return sha256Hex(rawToken);
  return `peppered:${createHmac("sha256", cleanPepper).update(rawToken, "utf8").digest("hex")}`;
}

/** Constant-time check of a raw token against a stored hash (either form). */
export function verifyTokenHash(
  rawToken: string,
  storedHash: string,
  pepper?: string | null
): boolean {
  const cleanPepper = pepper?.trim() ?? "";
  let expected: string;
  if (storedHash.startsWith("peppered:")) {
    // A peppered row without a pepper fails CLOSED — it must never
    // silently fall back to the unpeppered hash.
    if (cleanPepper.length === 0) return false;
    expected = hashTokenPeppered(rawToken, cleanPepper);
  } else {
    expected = sha256Hex(rawToken);
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * HKDF-SHA256 key derivation (audit F-07) for HMAC keys that must stay
 * stable across restarts: license verifiers and checkout tokens. The
 * salt is a fixed public domain-separation string (HKDF salt is not a
 * secret); the `purpose` info string keeps the two keys independent
 * even though they derive from different secrets in practice. This
 * replaces the single unsalted SHA-256 derivation for NEW keys; the
 * legacy derivation stays available for verifying keys minted before
 * the switch (see the v1 fallbacks below).
 */
export function deriveHmacKeyV2(secret: string, purpose: string): Buffer {
  const salt = createHash("sha256").update("stackmate-hkdf-salt-v1", "utf8").digest();
  return Buffer.from(hkdfSync("sha256", secret, salt, `stackmate-hmac-v2:${purpose}`, 32));
}

export function randomOpaqueToken(prefix: string, byteLength = 24): string {
  return `${prefix}_${randomBytes(byteLength).toString("base64url")}`;
}

/**
 * Encrypts a secret using AES-256-GCM bound to AAD (e.g., "site_credentials:<id>").
 * Format: v3:<salt_b64url>:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>
 * (v1/v2 keep the 4-part `<version>:<iv>:<tag>:<ct>` shape).
 *
 * New ciphertexts are v3 (scrypt over a random per-envelope salt) by
 * default. Callers may still pass "v1"/"v2" explicitly while a rotation
 * is in flight — the envelope version selects the key at decrypt time,
 * so v1, v2 and v3 rows coexist safely. `ACTIVE_ENCRYPTION_KEY_VERSION`
 * (env) is what the auth-config callers pass; setting it to "v3" flips
 * those writers too (its default is still "v2" — flip it once the v3
 * decrypt path below is live everywhere).
 */
export function encryptSecretAtRest(
  plaintext: string,
  masterSecret: string,
  keyVersion = ENCRYPTION_KEY_VERSION_V3,
  aadContext = "stackmate"
): string {
  if (keyVersion === ENCRYPTION_KEY_VERSION_V3) {
    const salt = randomBytes(16);
    const key = deriveEncryptionKeyV3(masterSecret, salt);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${keyVersion}:${aadContext}`, "utf8"));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${keyVersion}:${salt.toString("base64url")}:${iv.toString("base64url")}:${authTag.toString("base64url")}:${encrypted.toString("base64url")}`;
  }
  const key = deriveEncryptionKey(masterSecret, keyVersion);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${keyVersion}:${aadContext}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${keyVersion}:${iv.toString("base64url")}:${authTag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

/**
 * Re-encryption path (audit F-07): decrypt a ciphertext of ANY
 * version (v1/v2/v3) and re-encrypt it as v3 under the same master
 * secret. This is the per-row step a migration / cron job runs over
 * the secret-bearing tables (OAuth secrets, SMTP password, CAPI
 * tokens, webhook secrets, site credentials, signing-key JWKs):
 * read each row, call this, persist the new ciphertext. The v1/v2
 * decrypt paths below must NOT be dropped until a sweep confirms zero
 * v1/v2 rows remain — rotating ENCRYPTION_KEY_V1 without that sweep
 * breaks every ciphertext the new secret cannot derive.
 */
export function reEncryptSecretAtRest(
  encodedCiphertext: string,
  masterSecret: string,
  aadContext = "stackmate"
): string {
  const plaintext = decryptSecretAtRest(encodedCiphertext, masterSecret, aadContext);
  return encryptSecretAtRest(plaintext, masterSecret, ENCRYPTION_KEY_VERSION_V3, aadContext);
}

/**
 * Decrypts a secret encrypted with encryptSecretAtRest.
 *
 * KEY ROTATION PROCEDURE (audit M-4, updated for v3 / F-07):
 * (1) Introduce the v2 derivation (scrypt, per-install salt) — done
 *     here; new writes default to v2.
 * (2) Dual-decrypt: try the key for the envelope's version first; on
 *     authentication failure, try the OTHER derivation once (same AAD)
 *     before giving up — a row whose version tag drifted still reads.
 *     v1 rows therefore keep decrypting unchanged.
 * (3) Re-encrypt on read: when `isLegacyV1Ciphertext` is true, the
 *     caller that owns the row re-encrypts it with the default version
 *     (and persists it) the next time it writes that row.
 * (4) Remove the v1 fallback (the `catch` branch below) only once
 *     every row is v2 — grep the tables for `v1:` envelopes first.
 * (5) Rotate the master secret itself by re-encrypting every row under
 *     the new secret (same procedure, new secret value); the old secret
 *     stays readable until step (4) confirms zero v1 rows remain.
 * (6) v3 (F-07): new writes default to v3 — scrypt over a RANDOM
 *     per-envelope salt stored in the envelope (`v3:<salt>:<iv>:<tag>:
 *     <ct>`), so two installs sharing a master secret no longer derive
 *     the same key. `reEncryptSecretAtRest` above is the per-row step
 *     for sweeping v1/v2 rows to v3 (OAuth secrets, SMTP password, CAPI
 *     tokens, webhook secrets, site credentials, signing-key JWKs);
 *     run it as a migration/job over those tables, then — and only
 *     then — drop the v1/v2 decrypt paths. `needsReEncryption` tells a
 *     sweep which rows are still pre-v3.
 */
export function decryptSecretAtRest(
  encodedCiphertext: string,
  masterSecret: string,
  aadContext = "stackmate"
): string {
  const parts = encodedCiphertext.split(":");
  if (parts.length === 5 && parts[0] === ENCRYPTION_KEY_VERSION_V3) {
    const [, saltB64, ivB64, tagB64, dataB64] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    const salt = Buffer.from(saltB64, "base64url");
    const iv = Buffer.from(ivB64, "base64url");
    const authTag = Buffer.from(tagB64, "base64url");
    const ciphertext = Buffer.from(dataB64, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveEncryptionKeyV3(masterSecret, salt),
      iv
    );
    decipher.setAAD(Buffer.from(`${ENCRYPTION_KEY_VERSION_V3}:${aadContext}`, "utf8"));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  }
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted secret format.");
  }
  const [keyVersion, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  if (keyVersion !== ENCRYPTION_KEY_VERSION_V1 && keyVersion !== ENCRYPTION_KEY_VERSION_V2) {
    throw new Error(`Unsupported encryption key version '${keyVersion}'.`);
  }
  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(dataB64, "base64url");
  // A (key, AAD-version) pair: the AAD binds the envelope version, so
  // the fallback must pair the OTHER key with the OTHER version's AAD
  // — retrying the other key under the tagged version's AAD can never
  // succeed.
  const tryKey = (key: Buffer, aadVersion: string): string => {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`${aadVersion}:${aadContext}`, "utf8"));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  };
  try {
    return tryKey(deriveEncryptionKey(masterSecret, keyVersion), keyVersion);
  } catch {
    // Dual-decrypt fallback (rotation step 2): the tag says one
    // version, the bytes were derived under the other.
    const fallbackVersion =
      keyVersion === ENCRYPTION_KEY_VERSION_V2
        ? ENCRYPTION_KEY_VERSION_V1
        : ENCRYPTION_KEY_VERSION_V2;
    return tryKey(deriveEncryptionKey(masterSecret, fallbackVersion), fallbackVersion);
  }
}

/**
 * Generates a high-entropy formatted license key: SM-<PROD>-<XXXX>-<XXXX>-<XXXX>-<XXXX>
 */
export function generateFormattedLicenseKey(productCode: string): {
  rawKey: string;
  hint: string;
} {
  const cleanCode = productCode
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 6)
    .padEnd(4, "X");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // unambiguous crockford-like charset
  const bytes = randomBytes(20);
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let chunk = "";
    for (let i = 0; i < 5; i++) {
      const idx = bytes[g * 5 + i]! % alphabet.length;
      chunk += alphabet[idx];
    }
    groups.push(chunk);
  }
  const rawKey = `SM-${cleanCode}-${groups.join("-")}`;
  const lastGroup = groups[3]!;
  const hint = `SM-${cleanCode}-...-${lastGroup}`;
  return { rawKey, hint };
}

export function computeLicenseKeyVerifier(rawKey: string, verifierSecret: string): string {
  const normalized = rawKey.trim().toUpperCase();
  const digest = createHmac("sha256", derive32ByteKey(verifierSecret))
    .update(`stackmate-license-v1:${normalized}`, "utf8")
    .digest("hex");
  return `v1:${digest}`;
}

/**
 * License verifier, v2 (audit F-07): the HMAC key is HKDF-derived
 * (deriveHmacKeyV2, purpose "license-verifier") instead of the single
 * unsalted SHA-256 of v1. NEW licenses should be minted with this
 * once the licensing lookup switches from equality on
 * computeLicenseKeyVerifier to verifyLicenseKeyVerifier below — the
 * lookup is an equality match, so minting v2 before the lookup
 * understands it would orphan every new license. Until that switch,
 * computeLicenseKeyVerifier (v1) stays the minter and this verifier
 * accepts both.
 */
export function computeLicenseKeyVerifierV2(rawKey: string, verifierSecret: string): string {
  const normalized = rawKey.trim().toUpperCase();
  const digest = createHmac("sha256", deriveHmacKeyV2(verifierSecret, "license-verifier"))
    .update(`stackmate-license-v2:${normalized}`, "utf8")
    .digest("hex");
  return `v2:${digest}`;
}

/** Constant-time check of a raw license key against a stored verifier (v1 or v2). */
export function verifyLicenseKeyVerifier(
  rawKey: string,
  storedVerifier: string,
  verifierSecret: string
): boolean {
  const expected = storedVerifier.startsWith("v2:")
    ? computeLicenseKeyVerifierV2(rawKey, verifierSecret)
    : storedVerifier.startsWith("v1:")
      ? computeLicenseKeyVerifier(rawKey, verifierSecret)
      : null;
  if (expected === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(storedVerifier, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function computeInstallationIdHash(licenseId: string, installationId: string): string {
  return createHash("sha256")
    .update(`${licenseId}:${installationId.trim()}`, "utf8")
    .digest("hex");
}

/**
 * Order-scoped short-lived checkout access token (API Spec §6.3, §14.3, ADR-0006).
 */
export interface CheckoutTokenPayload {
  oid: string; // order ID
  ref: string; // public order reference
  sid: string; // integrated site ID
  exp: number; // unix timestamp seconds
}

export function issueCheckoutAccessToken(
  payload: CheckoutTokenPayload,
  secret: string
): string {
  const bodyB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  // v2 key (F-07): HKDF-derived; the token format stays `smc_v1.*` so
  // in-flight tokens and existing clients keep working, and the
  // verifier below tries the HKDF key first, then the legacy
  // single-SHA-256 key for tokens minted before this change (2h TTL,
  // so the legacy fallback is dead once those expire).
  const sigB64 = createHmac("sha256", deriveHmacKeyV2(secret, "checkout-token"))
    .update(`sm-checkout-v1.${bodyB64}`, "utf8")
    .digest("base64url");
  return `smc_v1.${bodyB64}.${sigB64}`;
}

/**
 * Decode a checkout access token's payload WITHOUT verifying it
 * (A-03 re-issue path: the idempotency record stores the token's
 * payload — oid/ref/sid/exp, none of it secret — so a replay can
 * re-issue a fresh token deterministically). NEVER trust the decoded
 * payload for authorization; callers must verify with
 * verifyCheckoutAccessToken before acting on it.
 */
export function decodeCheckoutAccessToken(token: string): CheckoutTokenPayload {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "smc_v1") {
    throw new AppError("CHECKOUT_TOKEN_INVALID", "Invalid checkout access token.", 401);
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8")
    ) as CheckoutTokenPayload;
    if (
      typeof parsed.oid !== "string" ||
      typeof parsed.ref !== "string" ||
      typeof parsed.sid !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      throw new Error("bad payload shape");
    }
    return parsed;
  } catch {
    throw new AppError("CHECKOUT_TOKEN_INVALID", "Invalid checkout access token.", 401);
  }
}

export function verifyCheckoutAccessToken(
  token: string,
  secret: string,
  nowUnixSeconds = Math.floor(Date.now() / 1000)
): CheckoutTokenPayload {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "smc_v1") {
    throw new AppError("CHECKOUT_TOKEN_INVALID", "Invalid checkout access token.", 401);
  }
  const bodyB64 = parts[1]!;
  const presentedSig = Buffer.from(parts[2]!, "base64url");
  const sigMatches = (key: Buffer): boolean => {
    const expectedSig = createHmac("sha256", key)
      .update(`sm-checkout-v1.${bodyB64}`, "utf8")
      .digest();
    return (
      presentedSig.length === expectedSig.length &&
      timingSafeEqual(presentedSig, expectedSig)
    );
  };
  // HKDF key first (all tokens minted after F-07); legacy SHA-256 key
  // second (tokens minted before, still inside their 2h TTL).
  if (
    !sigMatches(deriveHmacKeyV2(secret, "checkout-token")) &&
    !sigMatches(derive32ByteKey(secret))
  ) {
    throw new AppError("CHECKOUT_TOKEN_INVALID", "Invalid checkout access token signature.", 401);
  }

  const parsed = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8")) as CheckoutTokenPayload;
  if (typeof parsed.exp !== "number" || parsed.exp < nowUnixSeconds) {
    throw new AppError("CHECKOUT_TOKEN_INVALID", "Checkout access token has expired.", 401);
  }
  return parsed;
}

/**
 * Ed25519 (EdDSA) JWS Signing & Verification for License Entitlement Documents (API Spec §16.5).
 */
export interface Ed25519KeyMaterial {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyJwk: Record<string, unknown>;
}

export function generateEd25519KeyMaterial(keyId: string): Ed25519KeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    publicKeyJwk: {
      ...jwk,
      kid: keyId,
      alg: "EdDSA",
      use: "sig",
    },
  };
}

/**
 * Export a key material's private key as a compact private-JWK JSON string
 * (kty OKP, crv Ed25519, x + d). This is the plaintext DrizzleStore
 * encrypts into signing_keys.encrypted_private_jwk — never log it, never
 * return it from an API.
 */
export function exportPrivateJwkJson(material: Ed25519KeyMaterial): string {
  const privateKey = createPrivateKey(material.privateKeyPem);
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  return JSON.stringify(jwk);
}

/**
 * Read the `kid` from a compact JWS header WITHOUT verifying the
 * signature — the caller must then verify with that kid's public key.
 * Throws LICENSE_INVALID on a malformed token or a missing kid.
 */
export function readEntitlementJwsKid(jwsToken: string): string {
  const parts = jwsToken.split(".");
  if (parts.length !== 3) {
    throw new AppError("LICENSE_INVALID", "Malformed JWS entitlement token.", 401);
  }
  let header: { kid?: unknown };
  try {
    header = JSON.parse(
      Buffer.from(parts[0]!, "base64url").toString("utf8")
    ) as { kid?: unknown };
  } catch {
    throw new AppError("LICENSE_INVALID", "Malformed JWS entitlement token header.", 401);
  }
  if (typeof header.kid !== "string" || header.kid.trim().length === 0) {
    throw new AppError(
      "LICENSE_INVALID",
      "Entitlement JWS header has no kid; cannot select a verification key.",
      401
    );
  }
  return header.kid;
}

export function signEntitlementJws(
  claims: EntitlementTokenClaims,
  keyMaterial: Ed25519KeyMaterial
): string {
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: keyMaterial.keyId,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8");
  const privKey = createPrivateKey(keyMaterial.privateKeyPem);
  const signature = nodeSign(null, signingInput, privKey);
  return `${encodedHeader}.${encodedPayload}.${signature.toString("base64url")}`;
}

export function verifyEntitlementJws(
  jwsToken: string,
  publicKeyPemOrJwk: string | Record<string, unknown>,
  options?: {
    expectedIssuer?: string;
    expectedProductCode?: string;
    nowUnixSeconds?: number;
    clockSkewSeconds?: number;
  }
): { header: { alg: string; typ: string; kid: string }; claims: EntitlementTokenClaims } {
  const parts = jwsToken.split(".");
  if (parts.length !== 3) {
    throw new AppError("LICENSE_INVALID", "Malformed JWS entitlement token.", 401);
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  // A-15: both JSON parses are wrapped — a malformed header/payload
  // is a LICENSE_INVALID (401), never a latent 500 oracle. (Sibling
  // readEntitlementJwsKid already wrapped its parse; this function did
  // not, and no route calls it yet — fix before wiring it to a route.)
  let header: { alg: string; typ: string; kid: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
      alg: string;
      typ: string;
      kid: string;
    };
  } catch {
    throw new AppError("LICENSE_INVALID", "Malformed JWS entitlement token header.", 401);
  }
  if (!header || typeof header !== "object" || typeof header.alg !== "string") {
    throw new AppError("LICENSE_INVALID", "Malformed JWS entitlement token header.", 401);
  }
  if (header.alg !== "EdDSA") {
    throw new AppError("LICENSE_INVALID", `Unsupported JWS algorithm '${header.alg}'.`, 401);
  }
  const pubKey =
    typeof publicKeyPemOrJwk === "string"
      ? createPublicKey(publicKeyPemOrJwk)
      : createPublicKey({
          key: publicKeyPemOrJwk as unknown as import("node:crypto").JsonWebKey,
          format: "jwk",
        });

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const sigBytes = Buffer.from(sigB64, "base64url");
  const isValid = nodeVerify(null, signingInput, pubKey, sigBytes);
  if (!isValid) {
    throw new AppError("LICENSE_INVALID", "Entitlement JWS signature verification failed.", 401);
  }

  let claims: EntitlementTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as EntitlementTokenClaims;
  } catch {
    throw new AppError("LICENSE_INVALID", "Malformed JWS entitlement token payload.", 401);
  }
  if (!claims || typeof claims !== "object" || typeof claims.exp !== "number" || typeof claims.nbf !== "number") {
    throw new AppError("LICENSE_INVALID", "Malformed JWS entitlement token payload.", 401);
  }

  const now = options?.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options?.clockSkewSeconds ?? 60;
  if (claims.exp + skew < now) {
    throw new AppError("LICENSE_EXPIRED", "Entitlement token has expired.", 401);
  }
  if (claims.nbf - skew > now) {
    throw new AppError("LICENSE_NOT_YET_VALID", "Entitlement token is not yet valid.", 401);
  }
  if (options?.expectedIssuer && claims.iss !== options.expectedIssuer) {
    throw new AppError("LICENSE_INVALID", "Entitlement token issuer mismatch.", 401);
  }
  if (options?.expectedProductCode) {
    const expectedAud = `stackmate-product:${options.expectedProductCode}`;
    if (claims.aud !== expectedAud || claims.product_code !== options.expectedProductCode) {
      throw new AppError("PRODUCT_MISMATCH", "Entitlement token product audience mismatch.", 403);
    }
  }
  return { header, claims };
}

/**
 * STACKMATE-HMAC-SHA256-V1 Canonical Server Request Signing (API Spec §7.1–§7.3).
 */
export interface CanonicalServerRequestInput {
  keyId: string;
  timestampUnixSeconds: number | string;
  nonce: string;
  method: string;
  host: string;
  rawPathAndQuery: string;
  rawBody: string | Buffer | Uint8Array;
}

export function buildCanonicalServerRequestString(input: CanonicalServerRequestInput): {
  canonicalString: string;
  bodySha256Hex: string;
} {
  const bodySha256Hex = sha256Hex(input.rawBody);
  const normalizedHost = input.host
    .trim()
    .toLowerCase()
    .replace(/:(80|443)$/, "");
  const lines = [
    "STACKMATE-HMAC-SHA256-V1",
    input.keyId.trim(),
    String(input.timestampUnixSeconds).trim(),
    input.nonce.trim(),
    input.method.trim().toUpperCase(),
    normalizedHost,
    input.rawPathAndQuery,
    bodySha256Hex,
  ];
  return {
    canonicalString: lines.join("\n"),
    bodySha256Hex,
  };
}

export function signCanonicalServerRequest(
  input: CanonicalServerRequestInput,
  sharedSecret: string
): {
  signatureHeader: string;
  contentSha256Header: string;
  canonicalString: string;
} {
  const { canonicalString, bodySha256Hex } = buildCanonicalServerRequestString(input);
  const hmacB64Url = createHmac("sha256", Buffer.from(sharedSecret, "utf8"))
    .update(canonicalString, "utf8")
    .digest("base64url");
  return {
    signatureHeader: `v1=${hmacB64Url}`,
    contentSha256Header: bodySha256Hex,
    canonicalString,
  };
}

export function verifyCanonicalServerRequest(
  input: CanonicalServerRequestInput & {
    presentedContentSha256: string;
    presentedSignatureHeader: string;
  },
  sharedSecret: string,
  options?: {
    nowUnixSeconds?: number;
    maxSkewSeconds?: number;
  }
): void {
  const now = options?.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const maxSkew = options?.maxSkewSeconds ?? 300;
  const ts = Number(input.timestampUnixSeconds);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > maxSkew) {
    throw new AppError(
      "TIMESTAMP_EXPIRED",
      `Request timestamp is outside the allowed ${maxSkew}s freshness window.`,
      401
    );
  }
  if (!input.nonce || input.nonce.trim().length < 8) {
    throw new AppError("SIGNATURE_INVALID", "Request nonce must be at least 8 characters.", 401);
  }

  const { canonicalString, bodySha256Hex } = buildCanonicalServerRequestString(input);
  if (input.presentedContentSha256.trim().toLowerCase() !== bodySha256Hex) {
    throw new AppError(
      "SIGNATURE_INVALID",
      "X-StackMate-Content-SHA256 does not match raw request body digest.",
      401
    );
  }

  const sigHeader = input.presentedSignatureHeader.trim();
  if (!sigHeader.startsWith("v1=")) {
    throw new AppError("SIGNATURE_INVALID", "Unsupported or missing v1 signature prefix.", 401);
  }
  const presentedBytes = Buffer.from(sigHeader.slice(3), "base64url");
  const expectedBytes = createHmac("sha256", Buffer.from(sharedSecret, "utf8"))
    .update(canonicalString, "utf8")
    .digest();

  if (
    presentedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(presentedBytes, expectedBytes)
  ) {
    throw new AppError("SIGNATURE_INVALID", "HMAC request signature verification failed.", 401);
  }
}

/**
 * STACKMATE-WEBHOOK-V1 Outbound Webhook Signing & Verification (API Spec §18.3).
 */
export function signOutboundWebhookPayload(
  timestampUnixSeconds: number,
  deliveryId: string,
  rawBody: string,
  endpointSecret: string
): {
  signatureHeader: string;
  canonicalString: string;
} {
  const bodyHex = sha256Hex(rawBody);
  const canonicalString = [
    "STACKMATE-WEBHOOK-V1",
    String(timestampUnixSeconds),
    deliveryId,
    bodyHex,
  ].join("\n");
  const hmac = createHmac("sha256", Buffer.from(endpointSecret, "utf8"))
    .update(canonicalString, "utf8")
    .digest("base64url");
  return {
    signatureHeader: `v1=${hmac}`,
    canonicalString,
  };
}

export function verifyOutboundWebhookSignature(
  timestampUnixSeconds: number,
  deliveryId: string,
  rawBody: string,
  presentedSignatureHeader: string,
  endpointSecret: string,
  nowUnixSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (Math.abs(nowUnixSeconds - timestampUnixSeconds) > 300) {
    return false;
  }
  if (!presentedSignatureHeader.startsWith("v1=")) {
    return false;
  }
  const { signatureHeader } = signOutboundWebhookPayload(
    timestampUnixSeconds,
    deliveryId,
    rawBody,
    endpointSecret
  );
  const a = Buffer.from(presentedSignatureHeader.slice(3), "base64url");
  const b = Buffer.from(signatureHeader.slice(3), "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * SSRF Protection for Webhook & External Destination URLs (Security & Threat Model §4.6).
 *
 * The WHATWG URL parser already normalizes dotted-quad IPv4 literals
 * (`0x7f000001`, `0177.0.0.1`, `2130706433`, `127.1` all become
 * `127.0.0.1`), but the checks below canonicalize explicitly anyway:
 * the validator must not depend on one parser's normalization to stay
 * safe, and IPv6 literals are NOT normalized into their embedded IPv4
 * (`[::ffff:127.0.0.1]` parses to `[::ffff:7f00:1]`, so a naive
 * `startsWith("::ffff:127.")` string check misses it).
 */

/**
 * Parse an IPv4 literal in inet_aton form: 1–4 parts, each hex (`0x`),
 * octal (leading `0`), or decimal; a short form's last part holds the
 * remaining bytes (`127.1` → `127.0.0.1`, `2130706433` → `127.0.0.1`).
 * Returns the dotted-quad octets, or null when the host is not an IPv4
 * literal at all (e.g. a hostname that merely contains digits).
 */
export function canonicalizeIpv4Literal(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    let value: number;
    if (/^0x[0-9a-fA-F]+$/.test(part)) value = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8);
    else if (/^[0-9]+$/.test(part)) value = parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values.push(value);
  }
  const nums = values as number[];
  if (nums.length === 1) {
    const v = nums[0]!;
    if (v > 0xffffffff) return null;
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  }
  if (nums.length === 2) {
    const [a, b] = nums as [number, number];
    if (a > 255 || b > 0xffffff) return null;
    return [a, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff];
  }
  if (nums.length === 3) {
    const [a, b, c] = nums as [number, number, number];
    if (a > 255 || b > 255 || c > 0xffff) return null;
    return [a, b, (c >>> 8) & 0xff, c & 0xff];
  }
  const [a, b, c, d] = nums as [number, number, number, number];
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  return [a, b, c, d];
}

/**
 * Expand an IPv6 literal (no brackets) to its 8 hextets: `::`
 * compression, plus an embedded dotted-quad IPv4 tail (`::ffff:127.0.0.1`
 * → `[0,0,0,0,0,0xffff,0x7f00,0x0001]`). Returns null when the host is
 * not a valid IPv6 literal.
 */
export function parseIpv6Literal(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let tail16: [number, number] | null = null;
  let head = host;
  const lastColon = host.lastIndexOf(":");
  const afterLast = host.slice(lastColon + 1);
  if (afterLast.includes(".")) {
    const v4 = canonicalizeIpv4Literal(afterLast);
    if (!v4) return null;
    tail16 = [v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!];
    head = host.slice(0, lastColon);
  }
  const parseGroup = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const split = head.split("::");
  if (split.length > 2) return null;
  let groups: number[];
  if (split.length === 2) {
    const left = parseGroup(split[0]!);
    const right = parseGroup(split[1]!);
    if (!left || !right) return null;
    const total = left.length + right.length + (tail16 ? 2 : 0);
    if (total > 7) return null; // "::" must compress at least one group
    groups = [...left, ...new Array<number>(8 - total).fill(0), ...right];
  } else {
    const g = parseGroup(split[0]!);
    if (!g) return null;
    groups = g;
  }
  if (tail16) groups.push(tail16[0], tail16[1]);
  if (groups.length !== 8) return null;
  return groups;
}

/** Shared IPv4 private / loopback / link-local / metadata / reserved rules. */
function assertPublicIpv4Octets(octets: [number, number, number, number], host: string): void {
  const [a, b] = octets;
  const isPrivateOrReserved =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // Link-local & cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918 172.16.0.0/12
    (a === 192 && b === 168) || // RFC 1918 192.168.0.0/16
    a >= 224; // Multicast / reserved
  if (isPrivateOrReserved) {
    throw new AppError(
      "SSRF_BLOCKED",
      `Private, loopback, or metadata IP '${host}' is blocked by SSRF policy.`,
      400
    );
  }
}

/** Shared IPv6 loopback / unique-local / link-local rules, incl. IPv4 embedded in IPv6. */
function assertPublicIpv6Hextets(groups: number[], host: string): void {
  const blocked = (reason: string): never => {
    throw new AppError(
      "SSRF_BLOCKED",
      `IPv6 ${reason} address '${host}' is blocked by SSRF policy.`,
      400
    );
  };
  const embeddedV4 = (hi: number, lo: number): [number, number, number, number] => [
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  ];
  if (groups.every((g) => g === 0)) blocked("unspecified");
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) blocked("loopback");
  const g0 = groups[0]!;
  if (g0 >= 0xfc00 && g0 <= 0xfdff) blocked("unique-local"); // fc00::/7
  if (g0 >= 0xfe80 && g0 <= 0xfebf) blocked("link-local"); // fe80::/10
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): the
  // embedded IPv4 decides. This catches the hex form the old string
  // check missed (`::ffff:7f00:1` is `127.0.0.1`).
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    assertPublicIpv4Octets(embeddedV4(groups[6]!, groups[7]!), host);
  } else if (groups.slice(0, 6).every((g) => g === 0)) {
    assertPublicIpv4Octets(embeddedV4(groups[6]!, groups[7]!), host);
  }
  // 6to4 (2002::/16) embeds the IPv4 in hextets 2–3.
  if (g0 === 0x2002) {
    assertPublicIpv4Octets(embeddedV4(groups[1]!, groups[2]!), host);
  }
  // NOTE: Teredo (2001::/32) embeds its IPv4 XOR-obfuscated, so a plain
  // hextet check cannot see it — the delivery-time re-check + DNS
  // re-resolution is the backstop for that form.
}

export function validateSafeExternalUrl(rawUrl: string, allowHttpLocal = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError("SSRF_BLOCKED", "Malformed destination URL.", 400);
  }

  if (parsed.username || parsed.password) {
    throw new AppError("SSRF_BLOCKED", "Credentials are not permitted in destination URLs.", 400);
  }

  if (parsed.protocol !== "https:" && !(allowHttpLocal && parsed.protocol === "http:")) {
    throw new AppError("SSRF_BLOCKED", "Destination URL must use HTTPS.", 400);
  }

  if (parsed.port && parsed.port !== "443" && !(allowHttpLocal && parsed.port === "80")) {
    throw new AppError("SSRF_BLOCKED", `Port '${parsed.port}' is not permitted for webhook delivery.`, 400);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const blockedHostnames = new Set([
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata",
    "instance-data",
  ]);
  if (blockedHostnames.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new AppError("SSRF_BLOCKED", `Destination host '${host}' is prohibited by SSRF policy.`, 400);
  }

  // IP literals are canonicalized first (inet_aton forms + IPv6
  // expansion), then checked — never matched as raw strings. The
  // `fc`/`fd` check applies ONLY to IPv6 literals (a hostname like
  // `fc.example.com` is not a unique-local address).
  const v4 = canonicalizeIpv4Literal(host);
  if (v4) {
    assertPublicIpv4Octets(v4, host);
  } else if (host.includes(":")) {
    const groups = parseIpv6Literal(host);
    if (groups) {
      assertPublicIpv6Hextets(groups, host);
    } else {
      throw new AppError("SSRF_BLOCKED", "Invalid IPv6 destination address.", 400);
    }
  }

  return parsed;
}

/**
 * Async SSRF validation: the sync string-level checks above, PLUS DNS
 * resolution of hostnames with a re-check of every resolved address
 * (a name that resolves to a private IP is blocked even though the
 * name itself looks public). IP literals skip DNS — they were already
 * checked synchronously. With allowHttpLocal (local/test envs only)
 * the DNS re-check is skipped — a local receiver is intentional
 * there; the sync checks still apply.
 *
 * Resolution uses the system resolver under Node and DNS-over-HTTPS
 * (Cloudflare DNS JSON API) as the fallback — the only resolver
 * available on Workers. A host that cannot be resolved at all fails
 * CLOSED: an unresolvable destination is never delivered to.
 *
 * Callers should use this at endpoint create/update time; the
 * delivery-time redirect re-check in webhooks/service.ts is the second
 * layer (it re-validates the final URL after redirects).
 */
export async function validateSafeExternalUrlAsync(
  rawUrl: string,
  allowHttpLocal = false
): Promise<URL> {
  const parsed = validateSafeExternalUrl(rawUrl, allowHttpLocal);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (canonicalizeIpv4Literal(host) || host.includes(":")) return parsed;
  // Local/test envs run local receivers on purpose: skip the DNS
  // re-check there, exactly like assertHostnameResolvesToPublicIp
  // does. The sync checks above (no credentials, protocol/port rules,
  // blocked hostnames, private IP literals) still apply.
  if (allowHttpLocal) return parsed;

  const addresses = await resolveHostAddresses(host);
  for (const address of addresses) {
    const resolvedV4 = canonicalizeIpv4Literal(address);
    if (resolvedV4) {
      assertPublicIpv4Octets(resolvedV4, `${host} → ${address}`);
      continue;
    }
    if (address.includes(":")) {
      const groups = parseIpv6Literal(address);
      if (groups) assertPublicIpv6Hextets(groups, `${host} → ${address}`);
    }
  }
  return parsed;
}

async function resolveHostAddresses(host: string): Promise<string[]> {
  try {
    const dns = await import("node:dns/promises");
    const found = await dns.lookup(host, { all: true });
    const addresses = found.map((r) => r.address);
    if (addresses.length > 0) return addresses;
  } catch {
    // No system resolver (Workers) or a resolver error — fall through
    // to DNS-over-HTTPS below.
  }
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { Accept: "application/dns-json" } }
      );
      if (!res.ok) continue;
      const body = (await res.json()) as { Answer?: Array<{ data: string }> };
      for (const answer of body.Answer ?? []) out.push(answer.data);
    } catch {
      // A single DoH query failing must not mask the other type.
    }
  }
  if (out.length === 0) {
    throw new AppError(
      "SSRF_BLOCKED",
      `Destination host '${host}' could not be resolved.`,
      400
    );
  }
  return out;
}
