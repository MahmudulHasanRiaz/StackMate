# ADR-0006: Authentication, Granular RBAC, Cryptographic Signing, and Specification Conflict Resolutions

- **Status:** Accepted
- **Date:** 15 November 2026
- **Decision owners:** StackMate product and engineering
- **Related specifications:** PRD §4, §13–§16; TAD §6, §8, §13–§15; Database Design §5, §15–§18; API Specification §2–§7, §14–§18; Security & Threat Model §4

## Context

To deliver a coherent, production-grade implementation across all StackMate modules, several cross-document conflicts (`C-01` through `C-09`) and technical security boundaries (`D-01` through `D-05`) identified during the architecture audit require authoritative resolution.

## Decisions

### 1. Authoritative Specification Conflict Resolutions (`C-01`–`C-09`)
1. **API Base Paths (`C-01` & `C-06`):** All business API routes use `/api/v1/*` partitioned by trust zone (`/api/v1/admin/*`, `/api/v1/public/*`, `/api/v1/integrations/*`, `/api/v1/licenses/*`, `/api/v1/webhooks/*`), and Better Auth uses `/api/auth/*`. Public checkout routes are mounted at `/api/v1/public/sites/:siteKey/checkout/orders/*`.
2. **Wire Format Naming (`C-02`):** All HTTP JSON request/response envelopes and DTOs use `snake_case` (`request_id`, `api_version`, `next_cursor`, `amount_minor`, `currency_code`).
3. **Order-Item Scoped Snapshots (`C-03`):** Entitlement snapshots are scoped to `order_items` (`order_item_entitlement_snapshots` and `order_item_entitlement_snapshot_items`) rather than top-level `orders` so multi-item orders and per-item fulfillment (`software_license`, `saas_provision`, `digital_service`) remain unambiguous.
4. **Payment Schema Normalization (`C-04`):** Database tables and API endpoints use `payment_providers`, `payment_methods`, and `payment_method_transfer_rails`.
5. **Better Auth Plural Schema (`C-05`):** Better Auth is configured with `drizzleAdapter(db, { provider: "pg", usePlural: true })` so auth tables (`users`, `sessions`, `accounts`, `verifications`) match StackMate's plural `snake_case` convention.
6. **External Website Agnosticism vs. WordPress Product Licensing (`Section 3 & 4`):**
   - External websites/landing pages (whether built in Astro, Next.js, React, WordPress, or plain HTML) integrate through the technology-agnostic `/api/v1/public/sites/:siteKey/*` and `/api/v1/integrations/sites/:siteKey/*` contracts. StackMate contains zero landing-page builder or Astro runtime coupling.
   - WordPress plugins and WordPress themes are first-class sellable product types (`wordpress_plugin`, `wordpress_theme`, alongside `saas_application`, `dedicated_deployment`, `licensed_software`, `digital_service`) whose installations activate, validate, and deactivate licenses through `/api/v1/licenses/*`.

### 2. Authentication, Sessions & Granular RBAC
- Better Auth (`1.7.23`) is instantiated per request using the uncached `HYPERDRIVE_NO_CACHE` Drizzle connection, reading client IP from `cf-connecting-ip`, and using `HttpOnly`, `Secure`, `SameSite=Lax` session cookies.
- Staff authorization enforces default-deny RBAC (`roles`, `permissions`, `user_roles`, `role_permissions`, `staff_profiles`) on every `/api/v1/admin/*` route via `requirePermission(permissionKey)`. Built-in roles (`super_admin`, `admin`, `finance_manager`, `license_manager`, `product_manager`, `support_staff`, `marketing_manager`, `read_only`) are seeded deterministically, while Super Admin provisioning is restricted to an operator-controlled bootstrap command.

### 3. Cryptographic Signing & Secret Storage
- **License Keys:** Generated with 160+ bits of cryptographic entropy (`SM-<PRODUCT>-<XXXX>-<XXXX>-<XXXX>-<XXXX>`), displayed once at issuance, and persisted only as a keyed `HMAC-SHA256` verifier (`license_key_hash`) plus non-secret `license_key_hint`.
- **Signed Entitlement Documents (`entitlement_token`):** Signed as standard compact JWS (`EdDSA` / `Ed25519`) via Web Crypto (`crypto.subtle`) with `kid` header, `iss`, `aud`, `sub`, `iat`, `nbf`, `exp` (default 12h TTL), `jti`, `entitlement_version`, `product_code`, `license_status`, `grace_until`, and typed `entitlements` (zero customer PII). Public verification keys are served at `GET /api/v1/licenses/signing-keys` (JWKS).
- **Server-to-Server Request Signing (`STACKMATE-HMAC-SHA256-V1`):** Verifies `X-StackMate-Key-Id`, `X-StackMate-Timestamp` (`±300s`), `X-StackMate-Nonce` (persisted in `request_nonces` to block replay), `X-StackMate-Content-SHA256` over raw request bytes, and `X-StackMate-Signature` (`v1=<base64url-hmac>`) using constant-time byte comparison (`crypto.subtle.verify` / `timingSafeEqual`).
- **Checkout Access Token:** Short-lived (2h TTL) HMAC-SHA256 signed token bound to `(order_id, public_reference, integrated_site_id, exp)` verified alongside authoritative order state.
- **At-Rest Secret Encryption:** Recoverable secrets (`site_credentials.secret_ciphertext`, `tracking_configurations.access_token_ciphertext`, `webhook_endpoint_secrets.secret_ciphertext`) are encrypted using Web Crypto `AES-256-GCM` with versioned master keys (`ENCRYPTION_KEY_V1`) and authenticated `AAD` (`table:id`).
