# Key Rotation, Cryptography & Security Runbook

## 1. Cryptographic Primitives Overview

| Secret / Credential | Storage Mechanism | Algorithm | Rotation Cadence |
| :--- | :--- | :--- | :--- |
| User Passwords | `accounts.password_hash` | `scrypt` (`N=16384, r=8, p=1, dkLen=64`) + 16-byte random salt | On user reset / compromise |
| License Lookup & Storage | `licenses.key_hash` + `key_prefix` | Keyed `HMAC-SHA256(LICENSE_HMAC_PEPPER, normalized_key)` | Dual-pepper transition supported |
| License Offline Entitlement Token | `license_signing_keys` (`kid`) | `Ed25519` (`EdDSA` JWS compact serialization) | 180 days (overlapping active/verify-only window) |
| External Site Server Credentials | `external_site_api_credentials.secret_hash` | `STACKMATE-HMAC-SHA256-V1` + replay nonce (`site_request_nonces`) | 90 days (dual active credentials supported) |
| Meta CAPI & Webhook Secrets | `encrypted_secrets` table | `AES-256-GCM` envelope encryption with `MASTER_ENCRYPTION_KEY_BASE64` + `key_version` | 365 days (key version re-wrap) |
| Payment Proof Attachments | Private Cloudflare R2 (`R2_BUCKET`) | Magic-byte (`PNG`/`JPEG`/`WEBP`/`PDF`) + SHA-256 checksum + HMAC-signed short-lived view URL | Ephemeral signed token (10 min TTL) |

## 2. Rotating Ed25519 License Signing Keys (`kid`)

WordPress plugins and external software verify offline grace entitlement tokens using the public JWKS endpoint (`GET /api/v1/licenses/signing-keys`).

1. Generate a new Ed25519 keypair and insert the encrypted private key into `license_signing_keys` with `status = 'active'` and a new `kid` (e.g., `ed25519-2027-01`).
2. Transition the previous signing key to `status = 'verify_only'`. It remains published in `GET /api/v1/licenses/signing-keys` so existing cached tokens on client sites continue to verify during their offline grace window (default 7 days).
3. After 14 days (2x offline grace period), update the old key to `status = 'retired'`.

## 3. Rotating External Website API Credentials

1. In the Admin Dashboard (`Integrations & Tracking`), issue a new `client_id` / `client_secret` pair for the `external_site`.
2. Deploy the new credentials to the external website (Astro, Next.js, WordPress, etc.).
3. Verify incoming requests are authenticating under the new `client_id`.
4. Revoke the old credential record (`status = 'revoked'`).

## 4. Rotating the Master Envelope Encryption Key (`MASTER_ENCRYPTION_KEY_BASE64`)

1. Provision a new 32-byte base64 key under the next `key_version` (e.g., `v2`).
2. Run the secret re-encryption job to decrypt `encrypted_secrets` rows with `key_version = 1` and re-encrypt with `key_version = 2` using the row `id:purpose` as Additional Authenticated Data (AAD).
3. Remove the retired `v1` key from Worker secrets once zero rows remain on `key_version = 1`.
