# External Website, Checkout & Server-to-Server Integration Guide

## 1. Architectural Boundary: Technology-Agnostic External Websites

StackMate is **not** a landing-page builder or CMS. External product landing pages, marketing sites, and customer portals may be built with **any** technology stack:
- Astro
- Next.js / Remix / SvelteKit
- React / Vue SPAs
- WordPress marketing sites
- Static HTML or custom backend applications

All external websites integrate with StackMate through two explicit versioned contract surfaces:
1. **Public Browser / Checkout Endpoints** (`/api/v1/public/sites/:siteKey/*` and `/api/v1/public/orders/:orderId/*`)
2. **Signed Server-to-Server Endpoints** (`/api/v1/integrations/sites/:siteKey/*`)

## 2. Public Checkout & Manual Payment Submission Flow

### Step 1: Fetch Published Catalog (`GET /api/v1/public/sites/:siteKey/catalog`)
Served via the read-cached Hyperdrive binding (`HYPERDRIVE_CACHED`) with strict origin validation against `external_site_domains`. Returns active products, plans, and minor-unit prices mapped to the site.

### Step 2: Create Order & Checkout Session (`POST /api/v1/public/sites/:siteKey/checkout`)
- Requires `Idempotency-Key` header.
- Captures UTM parameters, click IDs (`fbclid`, `gclid`), and Meta CAPI browser identifiers (`_fbp`, `_fbc`) in `order_attribution_contexts`.
- Snapshots commercial terms on `order_items` (`product_type_snapshot`, `entitlement_policy_snapshot`, `unit_price_minor`, `total_minor` in integer minor units).
- Returns `order_id`, `order_number`, `checkout_token`, and active manual payment method instructions (bKash, Nagad, Rocket, Upay, Bank Transfer).

### Step 3: Submit Manual Payment Proof (`POST /api/v1/public/orders/:orderId/payment-submissions`)
- Requires `X-StackMate-Checkout-Token` and `Idempotency-Key`.
- Validates that `submitted_amount_minor === order.total_minor` (partial payments are rejected per `D-03`).
- Validates optional proof upload against magic bytes (`PNG`, `JPEG`, `WEBP`, `PDF`), stores object privately in Cloudflare R2, and records SHA-256 checksum.
- Enforces normalized `transaction_id` duplicate detection per provider.

## 3. Canonical Server-to-Server Request Signing (`STACKMATE-HMAC-SHA256-V1`)

Server-to-server requests to `/api/v1/integrations/sites/:siteKey/*` must include:
- `X-StackMate-Client-Id`: Credential client ID (`sm_live_...`)
- `X-StackMate-Timestamp`: Unix epoch seconds (must be within ±300 seconds of server clock)
- `X-StackMate-Nonce`: Unique random nonce (minimum 16 chars; stored in `site_request_nonces` to prevent replay within TTL window)
- `X-StackMate-Signature`: Hex-encoded `HMAC-SHA256` signature

### Canonical String Format

```text
STACKMATE-HMAC-SHA256-V1
{HTTP_METHOD_UPPERCASE}
{REQUEST_PATH_WITHOUT_QUERY}
{CANONICAL_SORTED_QUERY_STRING}
{TIMESTAMP_UNIX_SECONDS}
{NONCE}
{SHA256_HEX_OF_RAW_REQUEST_BODY}
```
