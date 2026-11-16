# API & Integration Specification
# StackMate — Centralized Product, Licensing, Subscription & Commerce Platform

**Document Version:** 1.0  
**Date:** 15 November 2026  
**Status:** Implementation contract baseline — validate marked gates before production  
**Related Documents:** [PRD](./Product%20Requirements%20Document%20(PRD).md) · [TAD](./Technical%20Architecture%20Document%20(TAD).md) · [Database Design](./Database%20Design%20%26%20Data%20Model%20Specification.md)  
**Repository:** https://github.com/MahmudulHasanRiaz/StackMate

---

## 1. Purpose and Authority

This document defines the HTTP API contracts and external integration behavior for StackMate. It is the reference for implementing the Hono API, React Admin SPA client, external Astro landing pages, WordPress/PHP clients, dedicated product deployments, and outbound webhook consumers.

The PRD remains authoritative for product scope. The TAD remains authoritative for system boundaries and runtime architecture. The Database Design document remains authoritative for persisted entities and data invariants. If an API proposal conflicts with one of those documents, record the discrepancy and resolve it before implementation rather than silently changing the data model.

### 1.1 Goals

1. Define predictable, versioned API contracts.
2. Separate staff-session, public-browser, server-to-server, customer checkout, license-client, and provider-webhook trust models.
3. Ensure the server—not the browser—calculates order prices and controls payment, subscription, and license state.
4. Make retryable write operations idempotent.
5. Keep external product integrations independent of StackMate's internal database schema.
6. Provide a consistent error, pagination, validation, and observability contract.
7. Keep provider-specific APIs behind adapters.

### 1.2 Non-goals

- This document does not define the React page layouts or visual design system.
- It does not define a customer self-service portal.
- It does not make manual payments automated or instantly verifiable.
- It does not define a full affiliate, promotion, tax, or metered-billing API.
- It does not require an external SDK to expose every server endpoint.

---

## 2. API Topology and Base Paths

All StackMate-owned JSON APIs use the same base path and major version.

| API surface | Base path | Primary consumer |
|---|---|---|
| Authentication | /api/auth/* | Admin SPA |
| Admin API | /api/v1/admin/* | Admin SPA and approved internal tools |
| Public catalog and checkout | /api/v1/public/* | External browser / Astro pages |
| Server integration API | /api/v1/integrations/* | External trusted servers |
| License API | /api/v1/licenses/* | WordPress plugins and product deployments |
| Webhook receiver utilities | /api/v1/webhooks/* | Provider callbacks, where applicable |

Example production origins (placeholders only):

    Admin SPA: https://app.example.com
    API:       https://api.example.com

These are illustrative hostnames, not fixed domain decisions. The SPA/API topology must be finalized in the TAD technical spike because cookie, CORS, CSRF, and browser privacy behavior depend on deployment origins.

### 2.1 Versioning

- The initial public API major version is v1.
- All StackMate business routes are prefixed with /api/v1.
- Better Auth's handler remains under /api/auth/* unless the implementation records a specific compatible route choice.
- Additive, backward-compatible response fields may be added within v1.
- Do not change field meaning, requiredness, enum semantics, or state-transition behavior silently.
- Breaking changes require a new major version, migration documentation, and a deprecation window.
- Every webhook delivery includes the API/event schema version used to serialize it.

### 2.2 Content and encoding

- JSON request/response bodies use UTF-8 and application/json unless an upload endpoint explicitly specifies multipart/form-data or binary content.
- Timestamps use ISO 8601 UTC, for example 2026-11-15T08:30:00Z.
- API timestamps are never local-time strings without a timezone.
- IDs are opaque to clients. Internal PostgreSQL UUIDs may appear in authenticated admin responses, but external clients should use documented public identifiers where possible.
- Unknown request properties are rejected for privileged and financial commands unless a schema explicitly allows an extension object.

---

## 3. Common Request Contract

### 3.1 Standard headers

| Header | Required | Purpose |
|---|---|---|
| Content-Type | For JSON/body requests | application/json, except uploads |
| Accept | Recommended | application/json |
| Authorization | According to route | Bearer token for narrowly scoped checkout access or license credentials only where explicitly specified |
| Idempotency-Key | Required for designated write commands | Safely retry a command without repeating its business effect |
| X-Request-ID | Optional from caller | Caller correlation value; validate length/charset and never trust it as an identity |
| X-StackMate-Site-Key | Public integration routes | Identifies a registered site; not a secret |
| X-StackMate-Key-Id | Signed server-to-server routes | Selects the registered integration credential |
| X-StackMate-Timestamp | Signed server-to-server routes | Unix timestamp in seconds for freshness verification |
| X-StackMate-Nonce | Signed server-to-server routes | Unique request nonce for replay protection |
| X-StackMate-Content-SHA256 | Signed server-to-server routes | SHA-256 digest of exact raw request body bytes |
| X-StackMate-Signature | Signed server-to-server routes | HMAC-SHA256 signature over the canonical request |

The API returns its own request identifier in every response. If a valid caller request ID is supplied, preserve it as a separate correlation attribute; do not let callers choose an identifier that can impersonate another request in logs.

### 3.2 Request IDs

Generate a cryptographically random request ID at the API boundary when no accepted correlation ID is supplied. Include it in the response header X-Request-ID and in the JSON error envelope. Propagate it to internal logs and outbox diagnostics.

### 3.3 HTTP methods

- GET: safe retrieval; no business state mutation.
- POST: command/action or resource creation. Use Idempotency-Key where specified.
- PUT: complete replacement only when the resource contract supports it.
- PATCH: partial update for editable fields only; never bypass state-transition commands.
- DELETE: use only for resources whose deletion is permitted. Financial records, licenses, audit events, published package versions, and verified transactions are not physically deleted through general CRUD routes.

---

## 4. Response and Error Envelope

### 4.1 Success response

Single-resource example:

    {
      "data": {
        "id": "c2e1b7f2-8a2c-4b4e-b27c-9b0d1d0e0001",
        "status": "active"
      },
      "meta": {
        "request_id": "req_01J...",
        "api_version": "v1"
      }
    }

Collection response:

    {
      "data": {
        "items": [],
        "next_cursor": null
      },
      "meta": {
        "request_id": "req_01J...",
        "api_version": "v1"
      }
    }

Do not return database rows directly. Define explicit response DTOs and omit secret fields, internal notes, private metadata, and unrelated customer information.

### 4.2 Error response

    {
      "error": {
        "code": "PAYMENT_SUBMISSION_ALREADY_REVIEWED",
        "message": "This payment submission has already been reviewed.",
        "details": null,
        "request_id": "req_01J..."
      }
    }

Validation errors may include a safe field-error collection:

    {
      "error": {
        "code": "VALIDATION_ERROR",
        "message": "One or more fields are invalid.",
        "details": {
          "fields": {
            "sender_phone": ["Enter a valid sender phone number."]
          }
        },
        "request_id": "req_01J..."
      }
    }

Never return stack traces, SQL, credential values, raw provider responses, license keys, or payment evidence URLs in an error body.

### 4.3 HTTP status mapping

| Status | Meaning | Usage |
|---|---|---|
| 200 | OK | Successful retrieval or command with an existing resource |
| 201 | Created | Resource created successfully |
| 202 | Accepted | Asynchronous processing accepted; not yet completed |
| 204 | No Content | Successful operation with no response body |
| 400 | Bad Request | Malformed request or invalid request semantics |
| 401 | Unauthorized | Missing, invalid, expired, or revoked credential/session |
| 403 | Forbidden | Authenticated caller lacks required permission/scope |
| 404 | Not Found | Resource not found or deliberately concealed from unauthorized caller |
| 409 | Conflict | State conflict, duplicate key with different body, or stale transition |
| 410 | Gone | Expired one-time operation or retired resource where useful |
| 413 | Payload Too Large | Upload/request exceeds configured limit |
| 415 | Unsupported Media Type | Incorrect content type |
| 422 | Unprocessable Entity | Valid JSON but invalid business input |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Unexpected application failure |
| 502/503/504 | Upstream/temporary failure | Provider or dependent service unavailable/timeout |

Do not use 200 for a rejected payment, invalid license, or failed state transition. Return a stable error code and correct HTTP status.

---

## 5. Pagination, Filtering, Sorting, and Field Selection

### 5.1 Pagination

Admin collection endpoints use cursor pagination for large or append-heavy datasets. A simple offset/page pattern may be used for small reference lists where predictable ordering is guaranteed.

Standard query parameters:

    limit=25
    cursor=<opaque-cursor>

Rules:
- Default limit: 25.
- Maximum limit: 100 unless a route defines a smaller maximum.
- The cursor is opaque and must not encode sensitive data.
- Results use a deterministic order, normally created_at descending plus a unique ID tie-breaker.
- The next_cursor is null when there are no more results.
- Do not fetch every record and paginate in the browser.

### 5.2 Filtering

Expose allowlisted filters only. Examples:
- status
- product_id
- customer_id
- created_after
- created_before
- payment_status
- order_source
- subscription_status
- license_status

Validate dates, enum values, and filter combinations. Do not pass raw client strings into SQL column names or operators.

### 5.3 Sorting

Use documented sortable field names and a fixed direction enum: asc or desc. Reject unknown sort fields. Every paginated result needs deterministic tie-breaking.

### 5.4 Search

Search is scoped to the authorized resource and product/customer visibility. Do not expose a generic database search endpoint.

---

## 6. Authentication and Authorization Models

Every route must declare one authentication model. There is no implicit fallback from an invalid credential to public access.

### 6.1 Staff session authentication

Used by Admin SPA routes.
- Authenticate using Better Auth session cookies.
- Cookies must be configured Secure and HttpOnly in production, with deliberate SameSite/domain settings.
- Use credentials: include from the SPA when the domain topology requires cookies.
- Apply CSRF defenses to state-changing cookie-authenticated requests.
- Enforce trusted origins.
- Apply RBAC on the server for every protected operation.
- Check resource scope in addition to permission names.
- Do not use frontend navigation visibility as authorization.

### 6.2 Public site key

Used only to identify a registered website and grant explicitly limited browser capabilities.

Allowed examples:
- Read published product/package/price data for products assigned to that site.
- Start a restricted checkout order.
- Read the payment methods available for a specific customer checkout.
- Submit a bounded allowlisted browser tracking event.

Not allowed:
- Approve or verify payments.
- Set order totals, discounts, tax, or entitlements.
- Issue, suspend, transfer, or revoke licenses.
- Read customer lists or arbitrary orders.
- Create admin users or edit product catalog data.
- Read private website integration credentials.

The public site key may be visible in browser JavaScript. It is an identifier, not a password. Enforce site/product scope, verified allowed origins, rate controls, abuse detection, and narrow response DTOs.

### 6.3 Checkout access token

After an order is created through a public site integration, issue a short-lived, opaque or cryptographically signed checkout access token scoped to that single order and site.

Token policy:
- Return it only once from order creation.
- Do not put it in a URL query string, analytics event, referrer, or logs.
- Keep it in memory where practical; if browser refresh continuity is needed, use sessionStorage only after documenting the XSS exposure trade-off.
- It may read the limited public order summary, retrieve payment methods, upload payment evidence, and submit payment claims for that order.
- It cannot access other customer orders or administrative resources.
- Apply a short configurable expiry and invalidate/expire it when the checkout flow is no longer actionable.
- Do not use the customer-facing order reference as the only authorization credential.

### 6.4 Server-to-server integration credentials

Use signed requests for trusted website/application servers. Each credential has explicit site, product, environment, scope, status, and rotation metadata.

Never send a server secret to browser code. The API must reject server-only routes if called with only a public site key.

### 6.5 License client authentication

License operations require the license key plus product identity and installation context. The license key must be sent only over TLS in the request body or an explicitly documented secure credential header. Never place it in a URL, query string, or log.

### 6.6 Inbound provider webhook authentication

Provider callback routes must use each provider's documented signature and verification procedure. Never assume all providers sign callbacks the same way. Validate event authenticity, amount, currency, merchant/account, reference, and provider transaction ID before recording provider-confirmed payment.

---

## 7. Server-to-Server Request Signing

### 7.1 Required headers

    X-StackMate-Key-Id: sk_live_...
    X-StackMate-Timestamp: 1794731400
    X-StackMate-Nonce: <base64url-random-value>
    X-StackMate-Content-SHA256: <lowercase-hex-sha256>
    X-StackMate-Signature: v1=<base64url-hmac>

The key ID is an identifier, not a secret. The signing secret is stored only in the trusted server environment and encrypted at rest by StackMate where it must be recoverable for HMAC verification.

### 7.2 Canonical request string

Use UTF-8 and exact bytes. The v1 canonical string is the following lines joined by a single LF character, with no trailing LF:

    STACKMATE-HMAC-SHA256-V1
    {key_id}
    {timestamp_unix_seconds}
    {nonce}
    {HTTP_METHOD_UPPERCASE}
    {lowercase_host_without_default_port}
    {raw_path_and_query}
    {lowercase_hex_sha256_of_raw_body}

Rules:
- Method is uppercase.
- Host is the authority received by the API after the trusted edge routing decision; include a non-default port if one is part of the accepted origin.
- Path and query are the exact encoded path-and-query bytes sent by the client. Do not decode and re-encode them before verification.
- Hash the exact raw body bytes before JSON parsing. For an empty body, hash the empty byte sequence.
- Signature is HMAC-SHA256 using the integration credential secret, encoded as unpadded base64url.
- Compare signatures in constant time.
- Reject unsupported signature versions.

### 7.3 Freshness and replay protection

Initial policy:
- Timestamp must be within 300 seconds of server time. The window is configurable and may be tightened after clock behavior is tested.
- Nonce must be high-entropy and unique per request.
- Persist/check nonce uniqueness scoped to credential ID for longer than the accepted timestamp window (initially 10 minutes).
- A replayed nonce is rejected even if the signature is otherwise valid.
- Use the existing idempotency/replay storage pattern only if its uniqueness scope and retention can correctly guarantee nonce uniqueness. Otherwise add a dedicated request-nonce record before production.
- Do not use an isolate's in-memory Map as replay storage.

### 7.4 Credential rotation

- Creation returns the raw secret once.
- List/detail APIs return only key ID, type, status, scopes, created/expiry/last-used metadata, and a masked hint if appropriate.
- Rotation creates a new credential and may allow a short controlled overlap period.
- The old key is revoked after the overlap or immediately on compromise.
- Every rotation/revocation is audited.
- Staging and production credentials are separate.

### 7.5 Future asymmetric option

An Ed25519 request-signing credential can be added for clients that should hold a private signing key while StackMate stores only the public key. This is an optional later protocol version; do not mix HMAC and asymmetric verification semantics under an undocumented v1 signature.

---

## 8. Admin API — Identity and Access

Better Auth owns its documented authentication endpoints and schema. StackMate-specific staff profile and RBAC operations are exposed separately.

| Method | Endpoint | Permission / behavior |
|---|---|---|
| GET | /api/v1/admin/me | Current staff profile, session identity, effective permissions |
| GET | /api/v1/admin/users | users.read |
| POST | /api/v1/admin/users/invitations | users.invite |
| GET | /api/v1/admin/roles | roles.read |
| POST | /api/v1/admin/roles | roles.create |
| PATCH | /api/v1/admin/roles/{roleId} | roles.update; validate permission allowlist |
| GET | /api/v1/admin/permissions | Read-only permission catalogue |
| PUT | /api/v1/admin/users/{userId}/roles | users.assign_roles; audited |

Do not expose endpoints that allow arbitrary promotion to Super Admin. The bootstrap process is operator-controlled and must be disabled after provisioning.

---

## 9. Admin API — Product Catalog, Features, Packages, and Prices

### 9.1 Products

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/products | Search/list products |
| POST | /api/v1/admin/products | Create product |
| GET | /api/v1/admin/products/{productId} | Product detail |
| PATCH | /api/v1/admin/products/{productId} | Update editable metadata |
| POST | /api/v1/admin/products/{productId}/archive | Archive product; retain history |
| POST | /api/v1/admin/products/{productId}/publish | Publish/enable according to product lifecycle |

Product code and slug uniqueness are server-enforced. Product type, distribution channels, and integration profiles are separate concepts.

### 9.2 Product features

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/products/{productId}/features | List feature catalogue for one product |
| POST | /api/v1/admin/products/{productId}/features | Create feature definition |
| POST | /api/v1/admin/products/{productId}/features/bulk | Create 1–100 feature definitions in one transaction; per-row results `{created, errors: [{index, feature_key, error}]}`; 201 if ≥1 created, 422 with `details.errors` if none created; one summary audit entry `catalog.feature.bulk_created` when ≥1 created |
| GET | /api/v1/admin/products/{productId}/features/{featureId} | Feature detail |

Feature list and detail responses carry `used_by_packages[]` (real associations only — package id/key/name + the highest referencing version number + version status; empty means "Not used in any package").
| PATCH | /api/v1/admin/products/{productId}/features/{featureId} | Update allowed metadata; stable key/value type protected after usage |
| POST | /api/v1/admin/products/{productId}/features/{featureId}/archive | Archive feature |

Feature key, value type, and product ownership are integration contracts. A feature used by a published package or license snapshot must not be silently renamed or retyped.

### 9.3 Packages and versions

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/products/{productId}/packages | List packages |
| POST | /api/v1/admin/products/{productId}/packages | Create package draft |
| GET | /api/v1/admin/packages/{packageId} | Package detail and current version pointer |
| PATCH | /api/v1/admin/packages/{packageId} | Update package metadata/draft |
| POST | /api/v1/admin/packages/{packageId}/versions | Create draft version |
| GET | /api/v1/admin/package-versions/{versionId} | Retrieve exact version and feature values |
| POST | /api/v1/admin/package-versions/{versionId}/publish | Publish immutable version |
| POST | /api/v1/admin/package-versions/{versionId}/retire | Retire future sale; preserve existing orders |

Package version publishing validates that every referenced feature belongs to the same product and every entitlement value matches the feature's declared type.

### 9.4 Prices

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/package-versions/{versionId}/prices | List price options |
| POST | /api/v1/admin/package-versions/{versionId}/prices | Create price option |
| PATCH | /api/v1/admin/prices/{priceId} | Edit only if not yet used; otherwise create replacement/version |
| POST | /api/v1/admin/prices/{priceId}/disable | Disable future purchases; preserve historical transactions |

Money uses integer minor units and currency code in API contracts. For example, BDT 499.00 is represented as amount_minor 49900 when the currency scale is two decimal places. Currency scale must come from an explicit currency configuration, not a universal assumption for all currencies.

---

## 10. Admin API — Customers, Orders, and Invoices

### 10.1 Customers

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/customers | Search/list customers using authorized fields |
| POST | /api/v1/admin/customers | Create customer |
| GET | /api/v1/admin/customers/{customerId} | Customer detail |
| PATCH | /api/v1/admin/customers/{customerId} | Update allowed contact/billing data; audit sensitive changes |
| GET | /api/v1/admin/customers/{customerId}/orders | Customer order history |
| GET | /api/v1/admin/customers/{customerId}/subscriptions | Customer subscriptions |
| GET | /api/v1/admin/customers/{customerId}/licenses | Customer licenses |

Customer identity resolution must be deliberate. Email or phone matches may suggest a possible existing customer; do not automatically merge records on an unverified client claim. Customer is not the same entity as a staff login account.

### 10.2 Orders

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/orders | Filterable order list |
| POST | /api/v1/admin/orders | Create an admin-originated order; permission required |
| GET | /api/v1/admin/orders/{orderId} | Order detail with safe line-item snapshots |
| POST | /api/v1/admin/orders/{orderId}/cancel | Explicit cancellation command |
| POST | /api/v1/admin/orders/{orderId}/complete | Only for fulfillment workflow; cannot bypass payment verification |
| GET | /api/v1/admin/orders/{orderId}/invoices | Related invoices |

Order amount, discount, tax, and entitlement snapshots are computed/validated server-side. The Admin SPA must not send a trusted total as an instruction to persist.

### 10.3 Invoices

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/invoices | Invoice list |
| POST | /api/v1/admin/orders/{orderId}/invoices | Generate invoice from order |
| GET | /api/v1/admin/invoices/{invoiceId} | Invoice detail/PDF metadata if available |
| POST | /api/v1/admin/invoices/{invoiceId}/void | Void through an authorized financial workflow |

Issued invoices are immutable financial documents except for explicit status transitions and correction/credit-note workflows. Do not regenerate historical invoice items from the current package catalogue.

---

## 11. Admin API — Payment Methods and Payment Verification

### 11.1 Payment providers and methods

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/payment-providers | List configured provider identities |
| POST | /api/v1/admin/payment-providers | Create provider config |
| PATCH | /api/v1/admin/payment-providers/{providerId} | Update provider metadata/status |
| GET | /api/v1/admin/payment-methods | List MFS accounts, bank accounts, and future methods |
| POST | /api/v1/admin/payment-methods | Create customer-selectable payment method |
| GET | /api/v1/admin/payment-methods/{methodId} | Detail; redact private configuration |
| PATCH | /api/v1/admin/payment-methods/{methodId} | Update method and customer instructions |
| POST | /api/v1/admin/payment-methods/{methodId}/enable | Enable method |
| POST | /api/v1/admin/payment-methods/{methodId}/disable | Disable method |

Payment method configuration must be validated according to provider type and method kind. Public responses use a dedicated allowlist DTO; never serialize the complete configuration JSON.

### 11.2 Payment submissions

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/payment-submissions | Verification queue and filters |
| GET | /api/v1/admin/payment-submissions/{submissionId} | Submission, masked customer data, attached evidence metadata |
| POST | /api/v1/admin/payment-submissions/{submissionId}/approve | Approve after actual receipt verification |
| POST | /api/v1/admin/payment-submissions/{submissionId}/reject | Reject with mandatory reason |
| GET | /api/v1/admin/payment-submissions/{submissionId}/history | Verification and resubmission history |

Approval request example:

    {
      "verified_amount_minor": 49900,
      "currency_code": "BDT",
      "verification_reference": "statement-line-reference",
      "internal_note": "Verified against account statement."
    }

Approval rules:
- Only users with payments.approve may approve.
- The submission must still be pending/reviewable.
- Verify actual account receipt independently of the customer's claim or screenshot.
- Check amount, currency, destination account, transaction/reference, order/invoice, and duplicate indicators.
- If the verified amount differs from the outstanding amount, reject or route to an explicit partial-payment/overpayment workflow; never silently mark the full order paid.
- Approval must be one atomic database transaction.
- A second concurrent approval must receive 409 conflict.
- Insert verification log, audit event, and outbox event in the same transaction.

Reject request example:

    {
      "reason_code": "TRANSACTION_NOT_FOUND",
      "customer_message": "We could not verify this transfer. Please check the details and submit again.",
      "internal_note": "No matching account credit found during review."
    }

Rejection requires a reason. Customer-facing message and staff-only internal note are separate fields. Never expose the internal note to the customer.

### 11.3 Manual payment capability boundary

Manual provider behavior:
- Customer submits a payment claim.
- StackMate records the claim as pending verification.
- Staff checks the receiving account/statement or merchant system.
- Staff approves or rejects.
- Only approval creates a verified payment transaction and triggers fulfillment.

Manual providers do not implement automated debit, automated balance check, or provider callback verification. Future automated providers implement these capabilities only where the provider's official API supports them.

---

## 12. Admin API — Subscriptions and Licensing

### 12.1 Subscriptions

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/subscriptions | Search/filter subscriptions |
| GET | /api/v1/admin/subscriptions/{subscriptionId} | Subscription detail and periods |
| POST | /api/v1/admin/subscriptions/{subscriptionId}/renewal-invoices | Create a renewal invoice/order |
| POST | /api/v1/admin/subscriptions/{subscriptionId}/cancel | Cancel now or at period end according to policy |
| POST | /api/v1/admin/subscriptions/{subscriptionId}/pause | Pause where product/billing policy allows |
| POST | /api/v1/admin/subscriptions/{subscriptionId}/resume | Resume where policy allows |

Manual-payment renewal is a fresh invoice/order followed by a new customer payment submission and staff verification. The API must not expose an auto-debit flag for manual MFS/bank methods.

### 12.2 Licenses

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/licenses | License list and filters |
| POST | /api/v1/admin/licenses/manual-grants | Create audited complimentary/manual grant |
| GET | /api/v1/admin/licenses/{licenseId} | License detail, current snapshot and activation summary |
| POST | /api/v1/admin/licenses/{licenseId}/suspend | Suspend access |
| POST | /api/v1/admin/licenses/{licenseId}/resume | Resume if underlying grant is valid |
| POST | /api/v1/admin/licenses/{licenseId}/revoke | Revoke license irreversibly or by documented recovery procedure |
| POST | /api/v1/admin/licenses/{licenseId}/entitlement-snapshots | Create a new authorized entitlement snapshot |
| GET | /api/v1/admin/licenses/{licenseId}/activations | Activation history |
| POST | /api/v1/admin/licenses/{licenseId}/activations/{activationId}/deactivate | Staff deactivation with reason |

License issue, manual grant, suspend, resume, revoke, activation transfer, and entitlement update are audited commands, not generic PATCH fields.

### 12.3 License policy response

Admin responses may include license number, masked key hint, customer, product, status, validity, activation policy, and entitlement summary. Never return the stored license-key verifier or private signing key.

---

## 13. Admin API — Website Integrations and Credentials

### 13.1 Integrated sites

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/integrated-sites | List registered sites |
| POST | /api/v1/admin/integrated-sites | Register site |
| GET | /api/v1/admin/integrated-sites/{siteId} | Site detail, domains, products, credentials metadata |
| PATCH | /api/v1/admin/integrated-sites/{siteId} | Update name, environment, API version, allowed capability metadata |
| POST | /api/v1/admin/integrated-sites/{siteId}/suspend | Suspend integration |
| POST | /api/v1/admin/integrated-sites/{siteId}/revoke | Revoke integration |
| POST | /api/v1/admin/integrated-sites/{siteId}/products | Grant site access to a product |
| DELETE | /api/v1/admin/integrated-sites/{siteId}/products/{productId} | Revoke site-product association |

### 13.2 Domain registration and verification

| Method | Endpoint | Behavior |
|---|---|---|
| POST | /api/v1/admin/integrated-sites/{siteId}/domains | Register normalized domain |
| POST | /api/v1/admin/integrated-sites/{siteId}/domains/{domainId}/verification-challenge | Generate DNS TXT or HTTP verification challenge |
| POST | /api/v1/admin/integrated-sites/{siteId}/domains/{domainId}/verify | Verify challenge or record manual review |
| DELETE | /api/v1/admin/integrated-sites/{siteId}/domains/{domainId} | Remove domain association while preserving audit history |

Domain verification proves control/ownership under the selected verification method. It does not authenticate every server request.

### 13.3 Credentials

| Method | Endpoint | Behavior |
|---|---|---|
| POST | /api/v1/admin/integrated-sites/{siteId}/credentials | Create a credential with explicit type and scopes |
| GET | /api/v1/admin/integrated-sites/{siteId}/credentials | List metadata only; never return secret material |
| POST | /api/v1/admin/integrated-sites/{siteId}/credentials/{credentialId}/rotate | Rotate credential |
| POST | /api/v1/admin/integrated-sites/{siteId}/credentials/{credentialId}/revoke | Revoke immediately |

Credential creation/rotation returns raw secret material exactly once. If the staff user closes the dialog without copying it, the server cannot retrieve and display it later; create a replacement credential instead.

---

## 14. Public API — Product Catalog and Checkout

### 14.1 Browser capability rules

Public catalog and checkout endpoints are accessed using X-StackMate-Site-Key plus an allowed browser Origin. The server resolves the site and verifies that it is active and authorized for the requested product.

These endpoints are designed to be callable from browser JavaScript. They must not return internal IDs unnecessarily, private payment configuration, server credentials, internal notes, secret tokens, or unrestricted customer records.

### 14.2 Public product catalogue

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/v1/public/sites/{siteKey}/products | List products publicly exposed to this site |
| GET | /api/v1/public/sites/{siteKey}/products/{productSlug} | Product display information |
| GET | /api/v1/public/sites/{siteKey}/products/{productSlug}/packages | Published purchasable package versions and public prices |
| GET | /api/v1/public/sites/{siteKey}/packages/{packageVersionId} | Package detail for checkout display |

Only published, currently purchasable product/package/price data is returned. Draft and retired catalogue items are never exposed to public browser clients.

### 14.3 Create order / checkout

    POST /api/v1/public/sites/{siteKey}/checkout/orders

Headers:

    X-StackMate-Site-Key: site_public_...
    Idempotency-Key: <random-unique-value>
    Content-Type: application/json

Request example:

    {
      "items": [
        {
          "product_slug": "sample-plugin",
          "package_version_id": "f17d7cc8-3a45-49c2-a65d-5f44fcb50001",
          "price_id": "25af8d11-8a1c-4e3b-9b22-4c877b4a0001",
          "quantity": 1
        }
      ],
      "customer": {
        "name": "Example Customer",
        "email": "customer@example.com",
        "phone": "+8801XXXXXXXXX"
      },
      "billing_address": {
        "country_code": "BD",
        "address_line_1": "Optional address",
        "city": "Dhaka",
        "postal_code": "1200"
      },
      "discount_code": null,
      "customer_note": null,
      "attribution": {
        "utm_source": "example",
        "utm_medium": "landing-page",
        "utm_campaign": "launch"
      }
    }

Validation and processing:
1. Validate site status, verified domain/origin policy, site-product associations, and checkout scope.
2. Resolve each product, exact published package version, and active price.
3. Verify all package features belong to the referenced product.
4. Resolve customer identity carefully; do not merge based only on an unverified email/phone claim.
5. Calculate subtotal, discounts, tax, currency, and total on the server.
6. Apply the explicit currency scale and rounding policy.
7. Create order, items, commercial snapshots, and idempotency record transactionally.
8. Create an opaque customer-facing order reference and short-lived order-scoped checkout access token.
9. Return only the information needed to continue checkout.

Reject client-supplied authoritative totals, unit prices, tax amounts, discount amounts, entitlement values, payment status, subscription status, or license status. The request may include price IDs, but the server must resolve their current trusted values.

Response example:

    {
      "data": {
        "order": {
          "public_reference": "SMO_7N8F...HIGH_ENTROPY...",
          "status": "awaiting_payment",
          "payment_status": "unpaid",
          "currency_code": "BDT",
          "subtotal_minor": 49900,
          "discount_minor": 0,
          "tax_minor": 0,
          "total_minor": 49900,
          "items": [
            { "product_name": "Sample Plugin", "package_name": "Business", "quantity": 1 }
          ]
        },
        "checkout_access_token": "<scoped-short-lived-token>",
        "checkout_token_expires_at": "2026-11-15T10:00:00Z"
      },
      "meta": { "request_id": "req_01J...", "api_version": "v1" }
    }

The example token/reference is illustrative only. Do not use a sequential order number or database UUID as a bearer credential.

### 14.4 Customer checkout order endpoints

All following routes require both the site public key and the order-scoped checkout access token.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/v1/public/sites/{siteKey}/checkout/orders/{publicReference} | Read limited order summary and current payment state |
| GET | /api/v1/public/sites/{siteKey}/checkout/orders/{publicReference}/payment-methods | Retrieve active public payment methods and instructions |
| POST | /api/v1/public/sites/{siteKey}/checkout/orders/{publicReference}/payment-evidence | Upload optional evidence to private R2 storage |
| POST | /api/v1/public/sites/{siteKey}/checkout/orders/{publicReference}/payment-submissions | Submit a self-reported payment claim |

The checkout token is scoped to one order and the site that created it. It cannot be used to search or enumerate other orders.

### 14.5 Public payment method DTO

Return only explicitly approved fields:

    {
      "id": "payment-method-public-id",
      "provider_name": "bKash",
      "display_name": "bKash Personal",
      "method_kind": "mfs_account",
      "account_type": "personal",
      "account_label": "Main collection account",
      "account_number": "01XXXXXXXXX",
      "instructions": "Send Money using the displayed account details.",
      "transaction_id_requirement": "required",
      "logo_url": "https://assets.example.com/public/provider-logo.png",
      "transfer_rails": []
    }

Bank methods may return bank name, account holder name, masked/unmasked account number as intentionally configured for public checkout, branch, routing number, supported transfer rails, and method-specific instructions. Never return internal labels, private API credentials, verification notes, or arbitrary configuration JSON.

### 14.6 Payment evidence upload

Upload endpoint requirements:
- Require checkout access token and site scope.
- Accept only configured image/document formats.
- Enforce a strict maximum size and request timeout.
- Check MIME type and file signature where practical.
- Generate object keys server-side; ignore user-supplied paths.
- Store the object privately in R2 and create uploaded asset metadata.
- Return an opaque asset ID, not a permanent public object URL.
- Do not permit anonymous reads of payment proof.
- Attach only evidence assets belonging to the same order/customer scope.

Initial upload transport may use a bounded multipart request streamed to R2. A presigned direct-upload workflow can be added if large-file usage justifies it; do not expose broad R2 credentials.

### 14.7 Submit manual payment claim

    POST /api/v1/public/sites/{siteKey}/checkout/orders/{publicReference}/payment-submissions

Request example for MFS:

    {
      "payment_method_id": "payment-method-public-id",
      "amount_minor": 49900,
      "currency_code": "BDT",
      "sender_phone": "+8801XXXXXXXXX",
      "transaction_id": "TXN-EXAMPLE-123",
      "evidence_asset_id": "uploaded-asset-id"
    }

Request example for bank transfer:

    {
      "payment_method_id": "bank-method-public-id",
      "amount_minor": 49900,
      "currency_code": "BDT",
      "sender_bank_name": "Example Bank",
      "sender_account_name": "Example Customer",
      "sender_account_reference": "masked-or-policy-approved-reference",
      "transfer_rail": "beftn",
      "transaction_id": "BANK-REFERENCE-123",
      "evidence_asset_id": "uploaded-asset-id"
    }

Rules:
- Enforce transaction ID required/optional/disabled policy from the selected payment method.
- Reject transaction ID when the method explicitly disables it, unless its schema supports an alternate reference.
- Validate amount and currency against the outstanding order/invoice. If partial payment is not enabled, require the full outstanding amount.
- Persist the submitted amount and sender claims as unverified customer-provided data.
- Check duplicate transaction identifiers according to provider/account policy; ambiguous matches should be flagged for review rather than automatically rejecting all legitimate repeat values.
- Store payment submission as pending verification.
- Do not create a verified payment transaction or activate subscription/license here.
- Return the current submission status and customer-safe next steps.

Response example:

    {
      "data": {
        "payment_submission": {
          "id": "submission-id",
          "status": "submitted",
          "submitted_at": "2026-11-15T08:45:00Z"
        },
        "order": {
          "public_reference": "SMO_7N8F...",
          "payment_status": "pending_verification"
        }
      }
    }

The UI must state clearly that submission is not confirmation of successful payment.

---

## 15. Server Integration API

These routes are called from the registered site's trusted server/runtime and require the signed request protocol in Section 7.

| Method | Endpoint | Scope |
|---|---|---|
| GET | /api/v1/integrations/sites/{siteKey}/products | products.read |
| GET | /api/v1/integrations/sites/{siteKey}/products/{productSlug}/packages | catalog.read |
| POST | /api/v1/integrations/sites/{siteKey}/orders | orders.create |
| GET | /api/v1/integrations/sites/{siteKey}/orders/{publicReference} | orders.read:own |
| POST | /api/v1/integrations/sites/{siteKey}/orders/{publicReference}/cancel | orders.cancel:own |
| POST | /api/v1/integrations/sites/{siteKey}/tracking/events | tracking.events.write |
| POST | /api/v1/integrations/sites/{siteKey}/webhook-test | webhooks.test |

Rules:
- Resolve caller credential, site, environment, scopes, product associations, and request signature before business logic.
- Scope every object lookup by the authenticated site and permitted product.
- A site cannot read another site's orders by guessing a reference.
- Product and package reads return public catalogue DTOs.
- Order creation follows the same server-authoritative price and snapshot rules as public checkout.
- Do not expose arbitrary customer search to integration clients.
- External sites cannot directly set payment status, subscription status, license status, or entitlements.

### 15.1 Server-originated orders

Only create server-originated paid orders when the authenticated integration has an explicitly approved use case and a trusted provider event/payment record supports it. A site server cannot simply submit paid=true or a payment reference and bypass verification.

---

## 16. License API Contract

License API is intended for software clients such as WordPress plugins and dedicated product deployments. It is not a customer-facing endpoint.

### 16.1 Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/v1/licenses/activate | Activate a license for an installation |
| POST | /api/v1/licenses/validate | Validate license and activation context |
| POST | /api/v1/licenses/deactivate | Deactivate an installation |
| GET | /api/v1/licenses/signing-keys | Retrieve public verification keys (JWKS or documented equivalent) |

All license endpoints require rate limiting and product/profile-aware policy checks. Credentials and license keys must not appear in URL paths or query strings.

### 16.2 Activate

Request example:

    {
      "license_key": "<license-key>",
      "product_code": "SAMPLE-PLUGIN",
      "integration_profile": "wordpress-plugin",
      "installation_id": "<stable-random-installation-id>",
      "site_url": "https://customer.example",
      "environment": "production",
      "product_version": "2.4.0",
      "client_version": "1.0.0"
    }

Validation:
1. Resolve product and integration profile.
2. Verify license key using its stored secure verifier.
3. Verify license state, effective dates, subscription/period status, and grace policy.
4. Validate product code/profile match.
5. Normalize and validate domain/deployment identity under product policy.
6. Enforce activation limit inside a transaction.
7. Upsert the installation using a stable installation identity hash.
8. Record activation/license event and audit/diagnostic metadata.
9. Return the activation result and signed entitlement document.

Response example:

    {
      "data": {
        "valid": true,
        "license_status": "active",
        "activation": {
          "id": "activation-id",
          "status": "active"
        },
        "entitlement_token": "<compact-signed-jws>",
        "entitlement_expires_at": "2026-11-15T12:00:00Z",
        "next_validation_after": "2026-11-15T10:00:00Z"
      }
    }

### 16.3 Validate

Request example:

    {
      "license_key": "<license-key>",
      "product_code": "SAMPLE-PLUGIN",
      "integration_profile": "wordpress-plugin",
      "installation_id": "<stable-random-installation-id>",
      "site_url": "https://customer.example",
      "environment": "production",
      "product_version": "2.4.0"
    }

Validation returns current status and a renewed signed entitlement token where the policy permits. A disconnected client may use a previously signed token only within its configured offline/grace window.

### 16.4 Deactivate

Request example:

    {
      "license_key": "<license-key>",
      "product_code": "SAMPLE-PLUGIN",
      "integration_profile": "wordpress-plugin",
      "installation_id": "<stable-random-installation-id>",
      "reason": "site_migration"
    }

Deactivation is idempotent for the same license/installation state. It must not free activation capacity if the supplied identity does not match an active activation.

### 16.5 Signed entitlement document

Use a standard compact JWS/JWT signing format with EdDSA (Ed25519) after the signing-key spike is complete. Do not invent a custom signature envelope or custom cryptographic algorithm.

Recommended claims:

    {
      "iss": "https://api.example.com",
      "aud": "stackmate-product:SAMPLE-PLUGIN",
      "sub": "license-public-id",
      "iat": 1794731400,
      "nbf": 1794731400,
      "exp": 1794742200,
      "jti": "entitlement-document-id",
      "entitlement_version": 4,
      "product_code": "SAMPLE-PLUGIN",
      "license_status": "active",
      "entitlements": {
        "advanced_analytics": { "type": "boolean", "value": true },
        "max_sites": { "type": "limit", "value": 5, "unit": "site" }
      }
    }

JWT/JWS header includes algorithm EdDSA and a key ID (kid). Product clients verify the signature with the published public key and validate issuer, audience, time claims, product code, license/entitlement version, and expected installation context as applicable.

Do not include customer email, phone, billing address, payment details, internal notes, or raw license key in the signed entitlement document.

### 16.6 Signing-key publication and rotation

- Publish only public verification keys.
- Include stable key IDs and supported algorithm metadata.
- Keep old public keys published while valid tokens signed by those keys may still be used.
- Retire old keys only after the maximum token validity plus clock-skew/offline grace window, unless compromised.
- Key compromise requires an emergency revocation/update process.
- Keep private keys outside normal database/API reads.

### 16.7 License API failure semantics

Use stable machine codes such as:
- LICENSE_INVALID
- LICENSE_REVOKED
- LICENSE_SUSPENDED
- LICENSE_EXPIRED
- LICENSE_NOT_YET_VALID
- PRODUCT_MISMATCH
- ACTIVATION_LIMIT_REACHED
- INSTALLATION_NOT_ACTIVE
- DOMAIN_NOT_ALLOWED
- SUBSCRIPTION_NOT_ACTIVE
- TEMPORARY_VALIDATION_UNAVAILABLE

A client must distinguish a definitive invalid/revoked response from a temporary network failure. Do not force clients to disable a license permanently because of a transient 5xx or network timeout.

---

## 17. Meta Tracking API and Event Contract

### 17.1 Event intake

Browser-originated allowlisted events:

    POST /api/v1/public/sites/{siteKey}/tracking/events

Trusted server-originated events:

    POST /api/v1/integrations/sites/{siteKey}/tracking/events

Server-originated event intake requires signed requests. Both routes validate event schema, event permission, site state, domain/source constraints, and consent policy.

### 17.2 Event request

    {
      "event_name": "InitiateCheckout",
      "event_id": "evt_01J...",
      "event_time": "2026-11-15T08:30:00Z",
      "event_source_url": "https://sales.example.com/checkout",
      "action_source": "website",
      "order_reference": "SMO_7N8F...",
      "user_data": {
        "email": "customer@example.com",
        "phone": "+8801XXXXXXXXX",
        "fbp": "fb.1....",
        "fbc": "fb.1...."
      },
      "custom_data": {
        "content_ids": ["SAMPLE-PLUGIN"],
        "currency": "BDT"
      },
      "consent": {
        "status": "granted",
        "policy_version": "2026-01"
      }
    }

The sample is illustrative. The production schema must define exactly which fields are accepted for each event type. Do not accept arbitrary nested browser data and forward it unmodified to Meta.

### 17.3 Event policy

- event_name must be in the site configuration allowlist.
- event_id is required for events that need browser/server deduplication.
- event_time must be a valid UTC timestamp and fall within the current destination platform's accepted age/future window.
- event_source_url must use an allowed, verified domain and must not contain credentials or sensitive query parameters.
- action_source must match the actual source; web events use website where appropriate.
- Consent status and policy version must be available where required.
- PII fields are normalized and hashed server-side only according to the current Meta endpoint specification and applicable policy.
- Do not store raw PII in tracking logs unless explicitly required and retention-controlled.
- `Purchase` is generated from a verified payment/fulfillment event, not from an untrusted browser request.

### 17.4 Purchase event source of truth

Only the central payment/order domain may enqueue a Purchase event after the order/payment policy marks the relevant amount as successfully paid. The event uses a stable event ID tied to the confirmed commercial event. The thank-you page may retrieve a safe event ID/status for browser Pixel deduplication only after the server confirms the payment state.

Customer-submitted payment claims, screenshots, transaction IDs, checkout button clicks, or unverified bank/MFS transfers must never generate Purchase.

### 17.5 Meta destination delivery

StackMate maps its internal event contract to the current Meta Conversions API request format through a provider adapter.

Rules:
- Pin the Graph API version in configuration and update it through a reviewed compatibility change.
- Never expose the Meta CAPI access token to browsers or external clients.
- Store credentials using the secret-management approach defined in the TAD/database design.
- Keep destination response diagnostics bounded and sanitized.
- Retry transient errors with bounded backoff; do not retry permanent validation/authentication errors forever.
- Track delivery status separately from event acceptance.
- Deduplication policy must follow current official Meta documentation and must be verified in test events before production.

### 17.6 Admin API — tracking pixel groups

A pixel group is one (provider, pixel_id) configuration for one integrated site. A site may have several groups per provider — for example two Meta pixels on the same store. Configuration is managed from Settings in the admin panel (UI-based, never via environment variables). Multi-platform ready: `provider` is a parameter on every call, never hardcoded to `meta`.

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/integrated-sites/{siteId}/tracking | List a site's pixel groups (CAPI token never returned) |
| POST | /api/v1/admin/integrated-sites/{siteId}/tracking | Create a pixel group; 201; 409 on a duplicate (site, provider, pixel_id); 404 unknown site |
| PATCH | /api/v1/admin/integrated-sites/{siteId}/tracking/{configId} | Update a group (partial); supplying `access_token` re-encrypts the token and bumps `rotated_at`; omitting it keeps the stored token; 422 on a no-op body; 409 when the update would collide with another group's (site, provider, pixel_id) |
| DELETE | /api/v1/admin/integrated-sites/{siteId}/tracking/{configId} | Hard delete a group (stored token deleted with it); 404 unknown config |
| PUT | /api/v1/admin/integrated-sites/{siteId}/tracking | Legacy single-config upsert: matches on (site, provider, pixel_id) — a new pixel creates a group, a known pixel updates in place |

Enable/disable is `PATCH {status: "enabled" | "disabled"}` — no redundant toggle endpoint. Create body: `provider` (`meta` | `tiktok`), `label?` (human group name, max 120 chars; null falls back to the pixel ID in the UI), `pixel_id` (4–80 chars), `access_token` (write-only, encrypted at rest, min 8 chars), `test_event_code?`, `enabled_events` (≥1 of `PageView`, `ViewContent`, `Lead`, `InitiateCheckout`, `AddPaymentInfo`, `Purchase`), `status?` (default `enabled`). All calls require `tracking.manage` and are audit-logged (`tracking.configuration.created` / `.updated` / `.deleted`).

Event intake accepts an event when ANY enabled group for the site enables it — not only the first group. Meta CAPI delivery is a stub in the current API (events are recorded, no call to Meta is made — Batch 4); TikTok has no delivery at all yet, its groups only store configuration. The admin UI says so plainly and never claims a delivery reached its destination.

---

## 18. Webhook Contract

StackMate sends outbound webhooks for selected lifecycle events. Delivery is asynchronous and at least once.

### 18.1 Event catalogue

Initial event names:

    product.created
    product.updated
    package.published
    order.created
    order.paid
    order.cancelled
    payment.submitted
    payment.approved
    payment.rejected
    subscription.created
    subscription.renewed
    subscription.expired
    subscription.cancelled
    license.created
    license.activated
    license.suspended
    license.expired
    license.revoked
    entitlement.updated

Only events needed by initial integrations should be enabled in MVP. Do not publish internal-only or sensitive audit payloads.

### 18.2 Webhook envelope

    {
      "id": "evt_01J...",
      "type": "payment.approved",
      "created_at": "2026-11-15T08:45:00Z",
      "api_version": "v1",
      "delivery_id": "whd_01J...",
      "data": {
        "order_reference": "SMO_7N8F...",
        "payment_submission_id": "submission-id",
        "currency_code": "BDT",
        "amount_minor": 49900,
        "payment_status": "paid"
      }
    }

Each event payload is a versioned contract. Use public references where possible. Never include raw payment proof, secret credentials, full license keys, Meta tokens, or unnecessary customer PII.

### 18.3 Delivery headers and signature

    X-StackMate-Event: payment.approved
    X-StackMate-Delivery: whd_01J...
    X-StackMate-Timestamp: 1794732300
    X-StackMate-Key-Id: whsec_key_...
    X-StackMate-Signature: v1=<base64url-hmac>

Sign the exact raw request body using HMAC-SHA256 with the endpoint secret. Canonical string:

    STACKMATE-WEBHOOK-V1
    {timestamp_unix_seconds}
    {delivery_id}
    {lowercase_hex_sha256_of_raw_body}

Receiver requirements:
- Read the raw body bytes before JSON parsing.
- Verify key ID and signature in constant time.
- Enforce timestamp tolerance and replay/duplicate handling.
- Persist delivery ID before applying business side effects.
- Acknowledge duplicate delivery IDs safely without repeating work.

### 18.4 Delivery and retry behavior

- A 2xx response acknowledges receipt.
- A non-2xx response, connection failure, or timeout is a failed attempt.
- Do not follow redirects to arbitrary destinations.
- Use bounded exponential backoff with jitter and a maximum retry horizon.
- After the retry budget, mark dead-letter/failed for staff inspection.
- Allow authorized manual replay while preserving the same event ID and using a new delivery attempt ID according to the event-delivery model.
- Receiver must deduplicate by event ID or delivery ID.

### 18.5 Webhook endpoint URL security

Webhook URLs are user-controlled destinations. Before delivery, enforce HTTPS in production, validate host/IP resolution, deny loopback/private/link-local/metadata ranges, guard against DNS rebinding, disallow redirects or revalidate every redirect target, and use available egress protections. Do not provide an unauthenticated endpoint that fetches arbitrary URLs.

### 18.6 Secret rotation

Support overlapping active/retiring endpoint secrets for a planned rotation window. List APIs return key IDs and status only. The raw secret is shown once at creation/rotation.

### 18.7 Admin API — webhook endpoints

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/webhooks | List registered endpoints |
| POST | /api/v1/admin/webhooks | Register an endpoint; returns the signing secret once (`raw_signing_secret_once`) |
| DELETE | /api/v1/admin/webhooks/{webhookId} | Hard delete an endpoint (permission-gated, audit-logged `webhooks.endpoint.deleted`); the endpoint's deliveries are removed with it; outbox events stay as history |
| POST | /api/v1/admin/webhooks/{webhookId}/test | Real test delivery (signed, 10s timeout); the result is shown verbatim |
| GET | /api/v1/admin/webhooks/{webhookId}/deliveries | Delivery attempts for one endpoint |

There is no `GET /api/v1/admin/webhooks/{webhookId}` — the admin detail page reads the endpoint from the list. Webhook endpoints are configuration and live under Settings in the admin panel; the outbox lives under Administration as its own section.

### 18.8 Admin API — audit log

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/audit-logs | List audit events (permission `audit_logs.read`); newest first |

Each row carries `resource_display_name` (additive, nullable): a human display name for the affected resource, resolved server-side from the live state — user/site/product/feature/package names, order/subscription/license/invoice numbers, webhook endpoint URL, invitation email, credential `key_id`, tracking group label (or `"{provider} pixel {pixel_id}"`), payment submission `"{amount} · Order {order_number}"`, package version `"v{N} · {package name}"`, package price `"{amount} [/ {n} {unit}] · {package} v{N}"`, session rows the actor's name (sign-in rows carry the attempted email or a 12-char session-token prefix, so the name is resolved from those when possible). `null` means the resource no longer exists (or the type has no display name) — the admin UI then falls back to its client-side name maps and, last, the short id; a bare raw id is never the primary display. No secrets are ever returned in a display name (only names, numbers, URLs, and public ids). The field is display-only: it changes no audit behaviour, no filtering, and no contract — clients that ignore it see the same rows as before.

### 18.9 Admin API — authentication & email configuration (Auth + Email batch, 2026-11-16)

All authentication configuration lives in the database and is edited from Settings → Authentication — never via env vars, never in code. A Settings save takes effect without a redeploy (the Better Auth instance is built per request from the current DB settings, with a 30s module-level cache keyed by connection string, invalidated on save; other isolates converge within the TTL). Every config change is audit-logged (`auth.oauth.updated`, `auth.two_factor_policy.updated`, `auth.smtp.updated`, `general.settings.updated`) with actor + what changed — never secret values.

**Public config (no auth, no secrets, no user data):**

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/auth-config | `{ oauth_providers: string[] (enabled AND has a stored client id), email_configured: boolean }` — the login page renders OAuth buttons only for the listed providers. |
| GET | /api/v1/general-config | `{ app_name, app_title, app_description, support_email, favicon_url }` — the SPA applies it at boot (brand, tab title, favicon, login-page tagline + support contact). |
| GET | /api/v1/favicon | Streams the R2 favicon object (content type from storage, `Cache-Control: public, max-age=86400`); 404 when no favicon is uploaded. |

**OAuth providers (Google, GitHub only — the only providers shipped; the same mechanism adds more, never invent one):**

| Method | Endpoint | Behavior |
|---|---|---|
| PUT | /api/v1/admin/auth-config/oauth | `{ provider, enabled, client_id?, client_secret? }` (permission `users.manage`). Client secrets are encrypted at rest (AES-256-GCM, AAD `auth:oauth:<provider>`) and never returned — GET views expose only `has_client_secret`. Enabling requires a client id + secret (unless one is already stored); omitting the secret keeps the stored one. |
| POST | /api/auth/sign-in/social | Better Auth social sign-in (exempt from the `sign-in/*` block). On callback, Better Auth links the OAuth account to an EXISTING staff user only when the provider email matches a staff record with a verified email (all three staff-provisioning paths set `email_verified: true`); `user.create.before` always returns false, so a non-staff Google/GitHub login can never mint a user, and `session.create.before` returns false for suspended staff, so OAuth can never mint a session for them. |

**Two-factor authentication (TOTP, better-auth 1.7.23 `twoFactor` plugin; backup codes stored encrypted — the plugin default is plaintext JSON, so `storeBackupCodes: "encrypted"` is load-bearing):**

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/auth-config | Returns the full auth config view (OAuth providers, 2FA policy, SMTP) with secrets redacted (`users.manage`). |
| PUT | /api/v1/admin/auth-config/two-factor-policy | `{ scope, mode }` — scope `global` (default for every role) or one of the 8 role keys; mode `off` / `optional` / `required` (default OFF). Resolution is strictest-wins across global + the user's roles (required > optional > off). |
| POST | /api/auth/two-factor/enable | Password → `{ totpURI, backupCodes }` (raw plugin response, not the app envelope). |
| POST | /api/auth/two-factor/verify-totp | `{ code }` — verifies setup or a sign-in challenge. **Rotates the session** (creates a new one, deletes the old, sets the cookie): clients must use the response's `set-cookie` afterwards. |
| POST | /api/auth/two-factor/verify-backup-code | `{ code }` — one backup code, consumed on use. |
| POST | /api/auth/two-factor/disable | Password → disables 2FA. Also rotates the session. |

Sign-in with 2FA on: the plugin deletes the just-created session and returns `{ two_factor_redirect: true, twoFactorMethods: ["totp"] }` with a signed `twoFactor` verification cookie — no session exists until `/two-factor/verify-totp` succeeds. When the policy REQUIRES 2FA and the user has not set it up, the sign-in succeeds but the principal carries `two_factor_setup_required: true` and the session is restricted: every admin endpoint except `GET /api/v1/admin/me` returns 403 `TWO_FACTOR_SETUP_REQUIRED` until setup completes (the SPA shows the forced-setup wizard instead of the shell).

**SMTP + email (provider-agnostic; the Worker sends via `cloudflare:sockets` — EHLO → STARTTLS → AUTH LOGIN → MAIL/RCPT/DATA/QUIT; port 25 is blocked by the platform, so the settings UI rejects it):**

| Method | Endpoint | Behavior |
|---|---|---|
| PUT | /api/v1/admin/auth-config/smtp | `{ host, port, username?, password?, tls_mode (starttls\|ssl\|none), from_address, from_name?, enabled? }` (`users.manage`). Password encrypted at rest (AAD `auth:smtp`), never returned. Enabling requires host + from address. |
| POST | /api/v1/admin/auth-config/smtp/test | Sends a real test mail **only to the admin's own address** (never an open relay); failure returns 502 with the real error, never a fake success. |
| POST | /api/auth/forgot-password | `{ email }` — always the same generic 200 (never says whether the email exists or whether email is configured). A reset token is created + emailed only for an active user when SMTP is configured. |
| POST | /api/auth/reset-password | `{ token, password }` — 422 for an invalid/expired/used token. Password ≥10 chars. **Reset alone never disables 2FA** (email compromise must not defeat 2FA). |
| POST | /api/auth/two-factor/recover | `{ email }` — generic 200; a recovery token is emailed only when the user has 2FA on and SMTP is configured. |
| POST | /api/auth/two-factor/recover/confirm | `{ token, password }` — verifies the password, disables 2FA (sets `users.two_factor_enabled=false`, deletes the `two_factor` row), consumes the token. |

Reset/recovery tokens: raw token `smreset` + random bytes (emailed once, never persisted); only the SHA-256 hash is stored, 1-hour TTL, single-use, `purpose` separates `password_reset` from `two_factor_recovery` so a token from one flow cannot be used in the other. Staff invitations send the accept link by email when SMTP is configured (`email_sent` / `email_error` in the response); when it is not configured the current `token_once` return is kept and the UI says plainly that email is not configured.

### 18.10 Admin API — general settings (Auth + Email batch, 2026-11-16)

App-wide configuration from Settings → General (category group `General`, permission `users.manage`). Runtime-applied: a save reaches the UI immediately, no redeploy. Storage is the singleton `general_settings` row (migration 0008, id `default`); no seed writes it, so admin edits are never overwritten. Every value renders somewhere visible — no dead stored values.

| Method | Endpoint | Behavior |
|---|---|---|
| GET | /api/v1/admin/general-settings | Full view: `app_name`, `app_title`, `app_description`, `support_email`, `favicon_url`, `favicon_content_type`, `favicon_byte_size`. |
| PUT | /api/v1/admin/general-settings | Partial update (absent fields keep their value). Validation: name/title 1–120 chars, description ≤500 chars, support email empty or a valid address; `clear_favicon: true` removes the stored favicon. Audit-logged `general.settings.updated` (resource_type `general_settings`, resource_id `general-settings`). |
| POST | /api/v1/admin/general-settings/favicon | `{ filename, content_type, content_base64 }` — PNG/ICO/SVG only, ≤256 KB, magic-byte checked (SVG must not contain `<script>`). Stored in R2 under the server-side key `branding/favicon-<sha256>.<ext>` (reusing the validated-private-object pattern); returns `{ favicon_url: "/api/v1/favicon", content_type, byte_size }`. Fail-closed in staging/production without a real R2 bucket (same rule as payment evidence). |

Rendering: App Name → sidebar/topbar brand + document-title fallback; App Title → `document.title`; Favicon → the tab icon (via the public `/api/v1/favicon` endpoint); App Description → meta description + the login page tagline; Support Email → the login page contact for staff who cannot sign in (hidden when empty). Currency/timezone/language are NOT settings — BDT + Asia/Dhaka are fixed by spec and the admin is English-only.

---

## 19. Inbound Payment Provider Callbacks

This section is future-facing. The MVP uses manually verified payments and does not require automated gateway callbacks.

When a real payment provider is added:
1. Use a provider-specific callback route and official signature verification.
2. Validate merchant/account identity and environment.
3. Validate provider transaction ID, reference, amount, currency, and final payment state.
4. Fetch/confirm payment status through the provider API when its protocol requires it.
5. Map provider states to StackMate's internal payment lifecycle.
6. Enforce provider transaction ID uniqueness within the correct provider/account scope.
7. Process callbacks idempotently.
8. Persist verified transaction, order/payment summary changes, audit, and outbox event transactionally.
9. Acknowledge the provider only according to its documented callback protocol.

Never treat a redirect back from a hosted checkout page as proof of payment. Browser return URLs are for user experience; provider verification is authoritative.

---

## 20. Idempotency Contract

### 20.1 Required operations

Require Idempotency-Key for:
- Public checkout order creation.
- Server integration order creation.
- Payment submission creation.
- Payment approve/reject commands.
- Subscription renewal invoice/order creation.
- License activation where a retry may race with activation capacity.
- Credential creation/rotation when client retry ambiguity is possible.
- Other commands that create financial, entitlement, or irreversible state.

### 20.2 Key format and scope

- Client generates a random high-entropy key per intended command.
- Recommended length: 16–128 visible ASCII characters; UUIDv4/UUIDv7 or another cryptographically random value is acceptable.
- Scope the key by actor/integration identity plus operation/route.
- Store a request hash so the same key cannot be reused with different input.
- Retain records beyond the supported client retry window and according to financial audit needs.

### 20.3 Replay behavior

| Situation | Behavior |
|---|---|
| First request | Execute command and persist result reference/status |
| Same key + same request after completion | Return the same logical result; do not repeat side effect |
| Same key + different request hash | 409 IDEMPOTENCY_KEY_REUSED |
| Same key while first request is processing | Return 409/202 with retry guidance according to route contract; do not execute twice |
| Previous attempt failed before commit | Allow safe retry according to recorded failure policy |

Persist the idempotency record in the same transaction as the protected business state whenever possible. Do not store sensitive response bodies or checkout tokens in plaintext idempotency rows; regenerate only if the security design explicitly supports deterministic, safe reissuance.

### 20.4 Client retry rules

- Retry network timeouts and selected 5xx responses using the same idempotency key and exact request body.
- Do not retry 4xx validation/authorization errors unchanged.
- Use bounded exponential backoff with jitter.
- If the client does not know whether a command committed, query the resource/result using the returned reference or retry with the same key.

---

## 21. State Transitions and API Semantics

Use explicit command endpoints for state transitions. Do not expose every internal state as a writable field.

### 21.1 Payment submission

    submitted -> under_review -> approved
    submitted -> under_review -> rejected -> resubmitted -> under_review

Only finance-authorized staff can approve/reject manual claims. Approval must create a verified payment transaction. Rejected submissions remain in history.

### 21.2 Order

    draft -> awaiting_payment -> processing -> completed
    draft/awaiting_payment -> cancelled

Payment state is separate from order state. An order may not become paid merely because a payment submission exists.

### 21.3 Subscription

    pending -> active -> past_due/paused/cancelled/expired

Actual transitions depend on billing kind and manual-payment renewal policy. A successful renewal creates/activates a new period exactly once.

### 21.4 License

    pending -> active -> expired
    active -> suspended -> active
    active/suspended -> revoked

Revocation is not interchangeable with expiry. Resumption after revocation requires an explicit recovery/reissue policy.

### 21.5 Activation

    active -> deactivated
    active -> blocked
    deactivated -> active (only under policy and capacity rules)

Activation count enforcement occurs transactionally. Repeating the same activation request must not consume multiple slots.

---

## 22. Validation, Input Safety, and Data Exposure

### 22.1 Validation layers

1. Parse HTTP syntax and content type.
2. Validate body/query/path schemas.
3. Authenticate caller.
4. Authorize operation and resource scope.
5. Validate domain/business rules.
6. Enforce database constraints transactionally.

Client-side validation is for usability only. Server validation is mandatory.

### 22.2 String and URL safety

- Limit string lengths and reject control characters where inappropriate.
- Normalize phone numbers and domains with a documented library/rule set.
- Avoid accepting arbitrary URLs except where the use case requires them.
- For external URLs, prevent SSRF and validate scheme/host at use time.
- Strip or reject credentials in URLs.
- Never trust file name, extension, MIME header, or browser-provided content length alone.

### 22.3 Data minimization

Public endpoints return only fields required for the immediate flow. Admin responses are also permission-scoped. Mask sender phone, bank references, and personal data on list screens; reveal full details only to roles with a legitimate operational need.

### 22.4 Secret exclusion

Never return:
- Password hashes or auth session tokens.
- Integration server secrets or HMAC secret ciphertext.
- Meta CAPI access tokens.
- License keys or key verifiers.
- Private signing keys.
- Payment processor credentials.
- Private R2 bucket credentials or permanent payment-proof URLs.

---

## 23. Rate Limits and Abuse Controls

Define rate policies by authentication class and operation risk. Final numeric thresholds must be tuned using traffic tests; do not copy arbitrary provider defaults as StackMate capacity guarantees.

Minimum policy areas:
- Sign-in, password reset, and email verification: strict per-IP and per-account limits.
- Public catalogue: moderate per-site/IP controls and cache-safe behavior.
- Checkout order creation: per-site/IP controls, idempotency, validation, anomaly detection.
- Payment submissions: per-order/customer/site controls and duplicate review.
- License activation: per-license, product, and source controls.
- License validation: per-license/activation and abuse detection.
- Tracking ingestion: per-site event budgets and payload limits.
- Webhook delivery: concurrency and retry limits per endpoint.

Rate-limit responses use 429 with a stable error code and, where supported, Retry-After. Do not use an untrusted X-Forwarded-For header as the sole source of client IP. Only trust forwarding headers set by the configured edge/proxy path.

---

## 24. API Documentation and SDK Strategy

### 24.1 OpenAPI

- Maintain OpenAPI documentation alongside route schemas.
- Generate request/response schemas from the same validators used at runtime where tooling supports it.
- Document authentication scheme, scopes, headers, request examples, response examples, and error codes per operation.
- Publish separate sections/tags for Admin, Public Checkout, Server Integration, Licensing, Webhooks, and Provider Callbacks.
- Hide internal-only routes from external developer documentation.
- CI validates schema generation and detects unreviewed breaking changes.

Hono supports schema-based validation and OpenAPI integration through compatible packages; choose one implementation approach in the foundation phase and avoid maintaining an unrelated manual spec that drifts from route validation.

### 24.2 TypeScript SDK

Proposed package: @stackmate/client

Target capabilities:
- Typed server-side client for registered integrations.
- HMAC signing helper and safe credential loading.
- Product/package retrieval.
- Server-to-server order creation.
- Webhook signature verification helper.
- Typed error classes and retry guidance.

Do not embed server secrets in a browser-compatible bundle. If a browser SDK is introduced, it is a separate package with public site key support only.

### 24.3 Browser checkout SDK

Proposed package: @stackmate/checkout

Target capabilities:
- Initialize with public site key.
- Retrieve public product/package/price data.
- Create checkout order.
- Retain order-scoped checkout token safely for the page session.
- Load public payment methods.
- Submit manual payment claim.
- Upload evidence through the restricted upload endpoint.
- Return clear pending-verification state.

The SDK is a convenience layer, not a security boundary. The API must validate every operation independently.

### 24.4 WordPress PHP client

Provide a separate PHP integration package/plugin helper in a later implementation phase. It should:
- Store license key on the server side only.
- Call activation/validation from WordPress backend, never browser JavaScript.
- Verify signed entitlement documents locally.
- Cache only until token expiry/grace policy.
- Avoid sending repeated validation requests on every page view.
- Support safe deactivation on uninstall/deactivation according to product policy.

### 24.5 Documentation examples

External developer docs should include:
- Register a site and verify domain.
- Create/revoke/rotate credentials.
- Public checkout flow.
- Server-signed order call.
- License activation/validation.
- Webhook signature verification.
- Error-code catalogue.
- Rate limits and idempotent retry guidance.
- Versioning/deprecation policy.

---

## 25. Testing and Contract Verification

### 25.1 Contract tests

Validate:
- Every request schema and response DTO.
- Required/optional/forbidden fields.
- Authentication scheme per route.
- Scope checks.
- Status codes and error codes.
- Pagination behavior.
- Backward compatibility within v1.

### 25.2 Security tests

Test:
- Public site key attempting a privileged route.
- Site A attempting to access Site B order.
- Product mismatch in site-product association.
- Forged amount/price/discount/entitlement fields.
- HMAC signature changed by one body byte.
- Expired timestamp.
- Replayed nonce.
- Rotated/revoked credential.
- Checkout token used for another order.
- License key in query string is rejected by route design.
- License activation concurrency at activation limit.
- Webhook duplicate and invalid signature.
- SSRF attempts using private/link-local/metadata destinations.

### 25.3 Workflow tests

1. Browser requests public product/package details.
2. Browser creates order with an idempotency key.
3. API calculates trusted total and returns scoped checkout token.
4. Browser retrieves enabled payment methods.
5. Customer submits transfer claim and optional evidence.
6. Order remains unpaid/pending verification.
7. Staff verifies transfer and approves once.
8. Payment transaction, order state, subscription/license intent, audit, and outbox are committed atomically.
9. Webhook and Meta event delivery happen asynchronously.
10. Product client activates and validates a license.

### 25.4 Test isolation

- Use staging site keys and database records.
- Never use production license keys or payment accounts in automated tests.
- Use Meta test events/test configuration; never send test purchase activity into production reporting.
- Redact PII and credentials in snapshots and test logs.

---

## 26. Implementation Readiness Gates

| ID | Gate | Acceptance evidence |
|---|---|---|
| API-01 | Shared response/error contracts | Unit and contract tests |
| API-02 | Staff cookie/auth topology | Browser tests across target browsers and deployed origins |
| API-03 | RBAC route policy | Permission matrix and negative authorization tests |
| API-04 | HMAC request signing | Canonicalization test vectors, freshness, replay test |
| API-05 | Checkout order creation | Forged amount/price tests and idempotency test |
| API-06 | Checkout token | Cross-order/site scope and expiry tests |
| API-07 | Manual payment submission | Pending-only workflow and evidence access tests |
| API-08 | Payment approval | Transaction rollback and double-approval race test |
| API-09 | License protocol | Signature, audience, expiry, rotation and offline test |
| API-10 | Webhook delivery | Signature, SSRF, retries, duplicate receiver test |
| API-11 | Meta event flow | Consent, verified Purchase source, dedup and test events |
| API-12 | OpenAPI and SDK contracts | CI validation and generated docs |

Do not postpone security gates merely because a happy-path UI demo works.

---

## 27. Open Decisions

| Topic | Decision still required | Default for MVP |
|---|---|---|
| Admin/API origin topology | Same-site reverse proxy or separate origin | Prefer same-site deployment where practical; validate cookies and browser compatibility |
| Public site key format | Prefix/length and key lifecycle | Random opaque identifier, no privilege by itself |
| Checkout access token | Opaque stateful or signed stateless token | Short-lived, single-order scope; select based on revocation and storage requirements |
| HMAC nonce storage | Reuse idempotency storage or add dedicated nonce table | Add explicit uniqueness/TTL guarantee before enabling HMAC |
| Currency scales | Currency registry and supported decimals | Store minor units with explicit scale policy |
| Partial payment | Whether multiple verified payments may settle one invoice | Disabled for initial release unless product owner explicitly approves |
| Order contents | Single-product or multi-product checkout | Allow multiple items only when all products are assigned to the integration; test fulfillment per item |
| License token format | JWS claims, TTL, refresh policy | EdDSA compact JWS after signing spike |
| Meta Graph API version | Version used by CAPI adapter | Pin current supported version at implementation and review upgrades |
| Tracking consent | Required policy by site and jurisdiction | Tracking disabled until site policy/config is explicitly enabled |
| API rate thresholds | Per-route/site/IP limits | Establish with load and abuse testing, not guessed globally |

These decisions do not block drafting the API contracts, but they must be resolved before the affected feature is production-ready.

---

## 28. External Technical References

Use these official references during implementation. Vendor APIs evolve; verify current compatibility, supported fields, Graph API version, and package versions at the time each integration is built.

- Hono validation guide: https://hono.dev/docs/guides/validation
- Hono OpenAPI / Zod OpenAPI example: https://hono.dev/examples/zod-openapi
- Hono middleware guide: https://hono.dev/docs/guides/middleware
- Better Auth cookies: https://better-auth.com/docs/concepts/cookies
- Better Auth session management: https://better-auth.com/docs/concepts/session-management
- Better Auth rate limiting: https://better-auth.com/docs/concepts/rate-limit
- Cloudflare Workers secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare Workers environment variables: https://developers.cloudflare.com/workers/configuration/environment-variables/
- Cloudflare Workers scheduled handler: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Meta Conversions API server event parameters: https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/server-event
- Meta Conversions API deduplication: https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events/
- HTTP idempotency overview: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Idempotency-Key

---

## 29. Final API Rules

1. Every route has one explicit authentication model and a documented authorization policy.
2. Public site keys identify sites; they do not authorize privileged operations.
3. Server-to-server requests are signed, time-bounded, replay-protected, scoped, and rate-limited.
4. The browser never controls authoritative order totals, payment status, subscription state, license state, or entitlements.
5. Customer payment claims remain unverified until the manual verification workflow approves them.
6. Purchase tracking is emitted only from verified payment/order events.
7. License clients receive only the product entitlement data they need and verify signed documents locally.
8. Retryable commands use idempotency keys and transactional persistence.
9. External webhooks are at-least-once, signed, bounded in retry, and safe for receivers to deduplicate.
10. All responses use explicit DTOs; never serialize database rows or secret configuration.
11. All state transitions use explicit commands and domain policies.
12. API contracts, OpenAPI, SDKs, and integration docs must evolve together.
13. Security, replay protection, SSRF prevention, and privacy controls are production gates—not later polish.

---

**End of API & Integration Specification — Version 1.0**