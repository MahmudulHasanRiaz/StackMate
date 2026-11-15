# WordPress Plugin & Theme Licensing Integration Guide

## 1. Overview

While external marketing websites are technology-agnostic, **WordPress plugins (`wordpress_plugin`) and WordPress themes (`wordpress_theme`)** are first-class sellable product types in StackMate alongside `licensed_software`, `saas_application`, `dedicated_deployment`, and `digital_service`.

When a manual payment submission for an order containing a `wordpress_plugin`, `wordpress_theme`, or `licensed_software` item is approved by an administrator:
1. StackMate provisions the `subscription` and generates a high-entropy license key (`SM-XXXX-XXXX-XXXX-XXXX`).
2. Only the keyed `HMAC-SHA256` digest (`key_hash`) and display prefix (`key_prefix`) are persisted in PostgreSQL.
3. The raw license key is returned once in the fulfillment payload (`one_time_issued_license_keys`) for customer delivery.

## 2. Licensing Endpoints (`/api/v1/licenses/*`)

### 2.1 Activate Installation (`POST /api/v1/licenses/activate`)
Activates a WordPress site or software instance against the license seat policy:
- Normalizes `instance_identifier` (e.g., `https://ClientSite.com:443/` -> `clientsite.com`).
- Checks if the `environment` (`production`, `staging`, `local`, `development`) is permitted and whether staging/local activations count toward `max_activations` (`count_staging_activations` policy flag).
- Enforces `max_activations` inside a serializable/locked transaction (`withTransaction`) to prevent concurrent race conditions from exceeding seat limits.
- Returns an `Ed25519` (`EdDSA`) signed JWS compact entitlement token (`entitlement_token`) containing `sub` (license ID), `prd` (product slug), `ins` (normalized instance), `status`, `exp`, and `grace_until`.

### 2.2 Heartbeat Validation (`POST /api/v1/licenses/validate`)
Called periodically (e.g., every 12–24 hours via `wp_cron`) by the WordPress plugin or theme:
- Verifies that the license is `active`, not expired, and not revoked/suspended.
- Updates `last_seen_at`, `client_version`, `wp_version`, and `php_version` on `license_activations`.
- Issues a fresh `Ed25519` signed `entitlement_token` with an updated `grace_until` timestamp (default 7 days).

### 2.3 Deactivate Installation (`POST /api/v1/licenses/deactivate`)
Marks the `license_activations` row as `deactivated` and decrements `activations_count` so the customer can move their license to a new domain.

### 2.4 Public Signing Key Discovery (`GET /api/v1/licenses/signing-keys`)
Returns active and verify-only `Ed25519` public keys (`kid`, `public_key_spki_base64`) so WordPress plugins can verify cached `entitlement_token` signatures locally during temporary network outages up to `grace_until`.
