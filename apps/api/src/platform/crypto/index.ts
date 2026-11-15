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
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  timingSafeEqual,
} from "node:crypto";
import type { EntitlementTokenClaims } from "../../../../../packages/contracts/src/index.ts";
import { AppError } from "../../shared/errors.ts";

function derive32ByteKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomOpaqueToken(prefix: string, byteLength = 24): string {
  return `${prefix}_${randomBytes(byteLength).toString("base64url")}`;
}

/**
 * Encrypts a secret using AES-256-GCM bound to AAD (e.g., "site_credentials:<id>").
 * Format: v1:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>
 */
export function encryptSecretAtRest(
  plaintext: string,
  masterSecret: string,
  keyVersion = "v1",
  aadContext = "stackmate"
): string {
  const key = derive32ByteKey(masterSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${keyVersion}:${aadContext}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${keyVersion}:${iv.toString("base64url")}:${authTag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecretAtRest(
  encodedCiphertext: string,
  masterSecret: string,
  aadContext = "stackmate"
): string {
  const parts = encodedCiphertext.split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted secret format.");
  }
  const [keyVersion, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const key = derive32ByteKey(masterSecret);
  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(dataB64, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(`${keyVersion}:${aadContext}`, "utf8"));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
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
  const sigB64 = createHmac("sha256", derive32ByteKey(secret))
    .update(`sm-checkout-v1.${bodyB64}`, "utf8")
    .digest("base64url");
  return `smc_v1.${bodyB64}.${sigB64}`;
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
  const expectedSig = createHmac("sha256", derive32ByteKey(secret))
    .update(`sm-checkout-v1.${bodyB64}`, "utf8")
    .digest();

  if (
    presentedSig.length !== expectedSig.length ||
    !timingSafeEqual(presentedSig, expectedSig)
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
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
    alg: string;
    typ: string;
    kid: string;
  };
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

  const claims = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8")
  ) as EntitlementTokenClaims;

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
 */
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

  // IPv4 private / loopback / link-local / metadata CIDR check
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    const octets = [
      Number(ipv4Match[1]),
      Number(ipv4Match[2]),
      Number(ipv4Match[3]),
      Number(ipv4Match[4]),
    ] as [number, number, number, number];
    if (octets.some((o) => o < 0 || o > 255)) {
      throw new AppError("SSRF_BLOCKED", "Invalid IPv4 destination address.", 400);
    }
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

  // IPv6 loopback / unique-local / link-local check
  if (
    host === "::1" ||
    host === "::" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:169.254.") ||
    host.startsWith("::ffff:192.168.")
  ) {
    throw new AppError(
      "SSRF_BLOCKED",
      `IPv6 loopback or local address '${host}' is blocked by SSRF policy.`,
      400
    );
  }

  return parsed;
}
