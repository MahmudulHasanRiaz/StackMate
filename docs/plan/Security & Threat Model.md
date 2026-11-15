# Security & Threat Model

**Version:** 1.0 | **Status:** Foundation baseline | **Project:** StackMate

This document defines trust boundaries, threats, mandatory controls, and production security gates. It must be read with the PRD, TAD, Database Design, and API Specification. It is a design baseline, not a claim of completed security or legal compliance.

## 1. Security objectives

- Protect staff/customer identities, commercial records, payment evidence, integration credentials, Meta tokens, and signing keys.
- Preserve integrity of prices, orders, payment verification, subscriptions, entitlements, and licenses.
- Enforce authorization server-side and make sensitive state transitions transactional, idempotent, and auditable.
- Limit the impact of compromised browsers, staff accounts, landing pages, product clients, and third-party providers.
- Minimize personal data collection, exposure, and retention.

## 2. Assets and classification

| Asset | Classification | Handling |
|---|---|---|
| Sessions, passwords, database credentials | Critical secret | Secure session handling; runtime secret storage; never log |
| Server integration secrets | Critical secret | Rotation; verifier/hash where protocol permits, otherwise encrypted at rest |
| License signing private keys | Critical secret | Server-side only; protected secret storage and recovery procedure |
| Meta CAPI tokens | Critical secret | Encrypted/managed secret storage; never expose to browser |
| Customer data and attribution | Confidential | Purpose limitation, least privilege, retention policy |
| Payment submissions and evidence | Confidential | Private R2 objects; scoped access and audit |
| Orders, invoices, payment and entitlement snapshots | High integrity | Database constraints, transactions, immutable snapshots |
| Public site keys | Public identifier | Browser-visible only for explicitly public operations |

## 3. Trust boundaries

Treat staff browsers, customer browsers, landing-page browser code, landing-page server runtimes, StackMate API, PostgreSQL, R2, Meta, email/payment providers, webhook destinations, and product clients as separate trust zones.

CORS, Origin/Referer checks, domain allowlists, and unguessable IDs are not authentication. Never trust browser-supplied prices, totals, discounts, payment success, roles, customer ownership, license status, or entitlement values.

## 4. Threats and mandatory controls

### 4.1 Identity, sessions, and privilege escalation
- Use Better Auth only after the documented Worker/Drizzle compatibility spike.
- Enforce default-deny RBAC on every protected application use case.
- Client-side route guards are UX only, never security.
- Use secure HttpOnly cookies, explicit trusted origins, and CSRF protection appropriate to the selected SPA/API topology.
- Rate-limit login, recovery, invitation, and verification endpoints.
- Revoke sessions after password changes, role changes, account disablement, and security-sensitive events.
- Bootstrap the first Super Admin through a documented one-time process; never ship default credentials.
- Require MFA for privileged staff when the selected auth setup supports it; make the production policy explicit.

### 4.2 Broken object-level authorization
- Scope reads and mutations by principal, permission, and resource ownership.
- Test cross-customer, cross-site, cross-product, and cross-role access.
- Opaque IDs do not replace authorization.
- Do not return internal notes, credentials, or unrelated personal data in public DTOs.

### 4.3 Checkout and price manipulation
- Browser submits identifiers and allowed choices only.
- API resolves active product/package/price versions and calculates totals.
- Persist immutable order and entitlement snapshots.
- Validate product/site eligibility, discounts, quantity, currency, and availability server-side.
- Use idempotency for order creation.
- A client assertion must never mark an order paid.

### 4.4 Manual payment fraud and race conditions
- Customer payment claims remain unverified until authorized staff checks actual receipt in the receiving account statement/provider portal.
- Transaction ID or uploaded proof never automatically marks an order paid.
- Verify amount, currency, receiving account, provider/rail, reference, timestamp, and order association.
- Separate submission, verified transaction, and order/payment state.
- Approval must be atomic, concurrency-safe, permission-gated, and audited.
- Rejection requires a reason.
- Duplicate detection uses provider/account/reference/amount/time signals; uncertain matches go to review rather than silent rejection.
- Private evidence is served only after authorization.
- Consider maker-checker approval for high-value payments as an operational policy.

### 4.5 Integration credentials and signed requests
- Public site key and privileged server credential are separate.
- Public keys never authorize payment approval, license administration, credential management, or privileged order mutation.
- Server requests use the canonical signing contract in the API specification, including method, path, timestamp, and body digest.
- Enforce timestamp freshness and replay protection using durable state/unique constraints.
- Compare signatures in constant time where supported.
- Support controlled credential rotation with overlap, expiry, and audit.
- Never log authorization headers, secrets, signatures, or raw credentials.

### 4.6 SSRF, CORS, and domain validation
- CORS is not authentication.
- Validate customer-configured webhook URLs at configuration and delivery time.
- Require HTTPS in production; reject URL credentials and disallowed ports.
- Block loopback, private, link-local, metadata, and prohibited IP ranges after DNS resolution; re-check redirects and resolved destinations.
- Bound redirects, response size, and delivery time.
- Verify the chosen SSRF protections against Cloudflare Worker networking capabilities before enabling customer-defined webhook URLs.

### 4.7 License abuse and signing keys
- Generate high-entropy license credentials; store hashed lookup material where feasible.
- Enforce activation limits atomically.
- Define product-specific instance identity; do not assume every product is domain-bound.
- Sign entitlement documents asymmetrically; private keys stay server-side and clients receive public keys only.
- Include issuer, key ID, license/product references, entitlement version, issue/expiry times, and policy claims.
- Document rotation, revocation, offline grace, and clock-skew behavior.
- Rate-limit activation/validation and avoid revealing partial key matches.
- Client-side checks are bypassable; enforce entitlements at the trusted product boundary.

### 4.8 Meta tracking and privacy
- Meta access tokens are server-only.
- Accept allowlisted event names and validated schemas.
- Purchase value/currency/order reference originate from the authoritative verified paid order, not browser payloads.
- Use event IDs for browser/server deduplication.
- Capture IP, user agent, fbp/fbc, and matching data only when available and appropriate under consent and applicable law.
- Normalize/hash identifiers according to the current Meta contract; hashing does not create lawful basis.
- Redact personal data and provider tokens from logs; define retention for raw events.

### 4.9 R2 uploads
- Payment evidence and private uploads are not public objects.
- Use server-authorized upload intents or short-lived scoped capabilities.
- Enforce size/type checks; verify content signature where practical.
- Generate object keys server-side; do not use user filenames as paths.
- Store ownership, purpose, content type, size, checksum, and key metadata in PostgreSQL.
- Serve through authorized short-lived access; define orphan cleanup and retention.

### 4.10 Webhooks and background delivery
- Verify inbound provider signatures against raw request bytes before parsing or changing state.
- Treat deliveries as at-least-once; consumers must be idempotent.
- Persist outbox events in the same transaction as the business change.
- Use bounded retry/backoff, delivery leases, failure states, and audited manual replay.
- Sign outbound payloads; include event ID and timestamp.
- Keep payloads minimal and free of secrets.

## 5. Authorization model

Every use case declares required permission(s). Routes authenticate and pass a trusted principal; application use cases enforce permission and resource scope. Sensitive transitions require explicit permissions, not generic edit access.

Permission families should cover identity, staff, roles, products, features, packages, prices, customers, orders, invoices, payment methods, payment review, subscriptions, licenses, integrations, tracking, webhooks, audit, and settings.

Customer identity is separate from staff identity. Super Admin actions remain audited.

## 6. Data protection and audit

- Collect only data needed for fulfilment, billing, support, security, and configured attribution.
- Define retention for auth logs, audit logs, payment evidence, tracking events, validation logs, and webhook payloads before production.
- Use HTTPS and provider-managed encryption at rest; apply application-level encryption to recoverable high-risk secrets.
- Use least-privilege database credentials and restrict production access.
- Redact tokens, passwords, cookies, evidence URLs, and unnecessary PII from logs.
- Audit role changes, catalogue/pricing publication, order adjustments, payment method changes, payment approvals/rejections, subscription/license overrides, credential lifecycle, tracking config, webhooks, exports, and security settings.
- Audit entries include actor, action, resource, timestamp, request ID, outcome, and safe before/after metadata—never raw secrets.

## 7. Monitoring

Structured logs must carry request/correlation IDs. Monitor authentication failures, authorization denials, rate-limit events, signature failures, replay attempts, payment duplicate signals, activation spikes, credential rotations, webhook failures, and outbox backlog. Do not log full request bodies by default.

## 8. Required security tests

- RBAC and resource-scope matrix, including negative tests.
- Checkout price tampering and disabled-product tests.
- Idempotent order creation and duplicate payment submission.
- Concurrent payment approval and license activation.
- HMAC canonicalization, invalid signature, stale timestamp, replay, and rotation.
- Inbound/outbound webhook signature and idempotency.
- R2 unauthorized access, invalid content, and oversize upload.
- Meta token non-exposure and Purchase value source.
- CSRF/CORS/trusted-origin tests for the selected topology.
- Webhook SSRF validation.

## 9. Production release gates

Do not release if authorization exists only in the frontend; public keys can perform privileged actions; browser totals or payment success are trusted; payment approval or activation is race-prone; private evidence is publicly accessible; secrets appear in logs/responses; webhook delivery lacks signing/idempotency; critical changes are unaudited; or backup/key recovery is unknown.

Before production, perform dependency/secret scanning, threat review of public endpoints, backup restore drill, signing-key recovery exercise, and security review of auth, RBAC, payment approval, licensing, and integrations. External penetration testing is recommended before broad commercial launch.

## 10. Open security decisions

| Decision | Evidence required |
|---|---|
| Better Auth cookie/session topology | Worker + SPA proof and CSRF tests |
| MFA and recovery policy | Auth capability and operations policy |
| Server secret storage | HMAC verifier vs encrypted secret decision |
| Replay persistence | PostgreSQL transaction/uniqueness proof |
| Signing-key storage/rotation | Runtime secret proof and recovery runbook |
| Webhook SSRF controls | Worker networking tests |
| PII retention | Business and jurisdiction-specific review |
| Maker-checker policy | Payment risk and volume assessment |

---

**End of Security & Threat Model — Version 1.0**
