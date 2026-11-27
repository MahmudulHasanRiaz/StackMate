/**
 * Integration Guide — the receiver requirements every product connected
 * to StackMate must fulfil (ADR-0009 §7, owner requirement 2026-11-17).
 *
 * A real page in the admin SPA (Settings → Integration Guide), not a
 * code comment. Every fact below is verified against the live code:
 *  - License endpoints: apps/api/src/app.ts:1064-1090
 *    (POST /api/v1/licenses/activate|validate|deactivate)
 *  - Validate contract: packages/contracts/src/domains/subscriptions-licensing.ts
 *    (ValidateLicenseRequestSchema) + modules/licensing/service.ts
 *    (validateLicenseInstallation, assertLicenseIsUsable, buildSignedEntitlementToken)
 *  - Webhook signing: apps/api/src/platform/crypto/index.ts
 *    (signOutboundWebhookPayload / verifyOutboundWebhookSignature,
 *    STACKMATE-WEBHOOK-V1, 300s timestamp tolerance)
 *  - Push events: modules/activation/service.ts
 *    (license.activated / license.suspended / license.reactivated /
 *    license.expired, delivered through the existing outbox)
 */
import { PageHeader } from "../lib/section-kit";

function GuideCard({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sm-card" id={id} style={{ marginBottom: 16 }}>
      <div className="sm-card-head">
        <h2 className="sm-card-title">{title}</h2>
      </div>
      <div>{children}</div>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="sm-mono">{children}</pre>;
}

export function IntegrationGuideSection() {
  return (
    <section aria-labelledby="integration-guide-heading">
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "Integration Guide" }]}
        title="Integration Guide"
        help="What every product connected to StackMate must implement"
      />
      <p className="sm-hint">
        This page is the contract between StackMate and the products it
        licenses. A product that follows it shows the right state at the
        right time — active, suspended, or expired — and prompts the
        customer to renew instead of failing silently.
      </p>

      <GuideCard id="overview" title="1. Overview">
        <p>
          StackMate is the source of truth for who may use a product. The
          product never decides entitlement itself: it asks StackMate
          (license validate), caches the signed answer for at most 12
          hours, and listens for push events (webhooks) in between. When a
          license is suspended or expires, StackMate pushes an event; the
          product must react to it even if nobody opens the product that
          day.
        </p>
        <ul>
          <li>
            <strong>Base URL:</strong> the StackMate API this deployment
            serves — the same origin as this admin page:{" "}
            <span className="sm-mono">{window.location.origin}</span>.
          </li>
          <li>
            <strong>Auth:</strong> license calls need no staff login —
            the license key itself is the credential. Never log a license
            key; store it like a password.
          </li>
          <li>
            <strong>Rate limits:</strong> license + public endpoints are
            limited to 120 requests per minute per IP.
          </li>
        </ul>
      </GuideCard>

      <GuideCard id="validate" title="2. License validate flow">
        <p>
          On startup — and at least once every 6 hours while running —
          call validate. A successful call returns a signed entitlement
          token (see §3); a failed call returns an error code that tells
          the product exactly what to show.
        </p>
        <Code>{`POST /api/v1/licenses/validate
Content-Type: application/json

{
  "license_key": "SM-XXXX-XXXX-XXXX",
  "product_code": "MY-PRODUCT",
  "integration_profile": "default",
  "installation_id": "<stable per-install id, min 6 chars>",
  "site_url": "https://example.com",
  "environment": "production",
  "product_version": "1.4.0"
}`}</Code>
        <p>Success (200):</p>
        <Code>{`{
  "valid": true,
  "license_number": "LIC-000123",
  "license_status": "active",
  "entitlement_version": 3,
  "entitlement_token": "<EdDSA JWS, 12h TTL>",
  "entitlement_expires_at": "2026-11-17T18:00:00.000Z",
  "next_validation_after": "2026-11-17T12:00:00.000Z"
}`}</Code>
        <p>
          Validate also refreshes the installation heartbeat: every
          successful call updates <span className="sm-mono">last_seen_at</span> for
          that installation.
        </p>
        <p>Error codes (the HTTP status is part of the contract):</p>
        <ul>
          <li>
            <strong>401 LICENSE_INVALID</strong> — the key does not exist.
            Treat as “no license”: show the activation screen.
          </li>
          <li>
            <strong>403 PRODUCT_MISMATCH</strong> — the key belongs to a
            different product. Never use one product’s key in another.
          </li>
          <li>
            <strong>403 LICENSE_REVOKED</strong> — permanently revoked.
            Show the activation screen; renewal cannot fix this — the
            customer must contact support.
          </li>
          <li>
            <strong>403 LICENSE_SUSPENDED</strong> — suspended (missed
            payment schedule or renewal grace exhausted). Show the
            renewal prompt (§6); do not grant access.
          </li>
          <li>
            <strong>403 LICENSE_NOT_YET_VALID</strong> — the license
            starts in the future (date-based activation not reached).
          </li>
          <li>
            <strong>403 LICENSE_EXPIRED</strong> — past{" "}
            <span className="sm-mono">expires_at</span> and past the
            grace window (<span className="sm-mono">grace_until</span>).
            Show the renewal prompt (§6). Note: validating an expired
            license marks it expired in StackMate.
          </li>
          <li>
            <strong>403 INSTALLATION_NOT_ACTIVE</strong> — this
            installation was never activated. Call activate first.
          </li>
          <li>
            <strong>403 SUBSCRIPTION_NOT_ACTIVE</strong> — the underlying
            subscription is cancelled or expired and the grace window has
            passed.
          </li>
        </ul>
        <p>
          Activation is a separate call,{" "}
          <span className="sm-mono">POST /api/v1/licenses/activate</span>{" "}
          (same body shape), and deactivation is{" "}
          <span className="sm-mono">POST /api/v1/licenses/deactivate</span>.
          Activating the same <span className="sm-mono">installation_id</span>{" "}
          twice is safe — it refreshes the heartbeat instead of consuming
          a second seat. Exceeding the seat limit returns{" "}
          <strong>403 ACTIVATION_LIMIT_REACHED</strong>.
        </p>
      </GuideCard>

      <GuideCard id="entitlement-token" title="3. Entitlement token (EdDSA JWS, 12h TTL)">
        <p>
          A successful validate returns a compact Ed25519 (
          <span className="sm-mono">EdDSA</span>) JWS. It contains{" "}
          <strong>zero PII</strong> — only what the product needs to gate
          features locally until the next validate.
        </p>
        <Code>{`{
  "iss": "<stackmate api url>",
  "aud": "stackmate-product:<product_code>",
  "sub": "<license_number>",
  "iat": 1763366400, "nbf": 1763366400, "exp": 1763409600,
  "jti": "ent_<uuid>",
  "entitlement_version": 3,
  "product_code": "MY-PRODUCT",
  "license_status": "active",
  "grace_until": "2026-11-20T00:00:00.000Z",
  "activation_usage": { "active_count": 1, "activation_limit": 3 },
  "entitlements": { "projects": 10, "team_seats": true }
}`}</Code>
        <ul>
          <li>
            <strong>TTL is 12 hours.</strong> Re-validate at{" "}
            <span className="sm-mono">next_validation_after</span> (6
            hours in) — never wait for expiry.
          </li>
          <li>
            <strong>Verify the signature</strong> with StackMate’s public
            signing key before trusting the claims. A token whose
            signature fails verification must be treated as no license.
          </li>
          <li>
            <strong>Check the audience</strong> (
            <span className="sm-mono">aud</span>) matches your product
            code and the subject (<span className="sm-mono">sub</span>)
            matches the license you validated.
          </li>
          <li>
            <strong>Feature flags live in </strong>
            <span className="sm-mono">entitlements</span> — a map of
            feature key → value (boolean / limit / quota / metered), taken
            from the package the customer bought. Gate features from this
            map, never from a hardcoded list.
          </li>
          <li>
            <strong>Activation usage</strong> tells the product how many
            seats are in use; show it on the product’s license screen so
            the customer can free a seat before hitting the limit.
          </li>
        </ul>
      </GuideCard>

      <GuideCard id="activation-limits" title="4. Activation limits">
        <ul>
          <li>
            Each license has an activation limit (seats). One{" "}
            <span className="sm-mono">installation_id</span> = one seat.
            Use a stable id per install (device id / site id) — a random
            id per launch burns seats.
          </li>
          <li>
            Re-activating the same installation id never consumes a new
            seat.
          </li>
          <li>
            Deactivate when the product is uninstalled or moved, so the
            seat is freed immediately.
          </li>
          <li>
            When activation returns{" "}
            <strong>403 ACTIVATION_LIMIT_REACHED</strong>, show the
            customer which installations are active and offer to
            deactivate one — do not silently overwrite an existing seat.
          </li>
        </ul>
      </GuideCard>

      <GuideCard id="webhooks" title="5. Webhook receiver spec">
        <p>
          StackMate pushes license lifecycle events to every webhook
          endpoint registered for the site (Settings → Webhooks). The
          events are:{" "}
          <span className="sm-mono">license.activated</span>,{" "}
          <span className="sm-mono">license.suspended</span>,{" "}
          <span className="sm-mono">license.reactivated</span>,{" "}
          <span className="sm-mono">license.expired</span>. The payload
          is:
        </p>
        <Code>{`{
  "license_number": "LIC-000123",
  "product": { "id": "<uuid>", "name": "My Product" },
  "status": "suspended",
  "expires_at": "2026-11-17T00:00:00.000Z",
  "grace_until": "2026-11-20T00:00:00.000Z",
  "reason": "missed_schedule"
}`}</Code>
        <p>Delivery rules the receiver must follow:</p>
        <ul>
          <li>
            <strong>Respond 2xx within 10 seconds.</strong> Anything else
            is a failed delivery and will be retried.
          </li>
          <li>
            <strong>Verify the signature</strong> on every request.
            Headers:{" "}
            <span className="sm-mono">X-StackMate-Event</span>,{" "}
            <span className="sm-mono">X-StackMate-Delivery</span>,{" "}
            <span className="sm-mono">X-StackMate-Timestamp</span>,{" "}
            <span className="sm-mono">X-StackMate-Key-Id</span>,{" "}
            <span className="sm-mono">X-StackMate-Signature</span>. The
            signature is <span className="sm-mono">v1=&lt;hmac&gt;</span>{" "}
            where the HMAC-SHA256 is computed over the canonical string:
          </li>
        </ul>
        <Code>{`STACKMATE-WEBHOOK-V1\n<timestamp>\n<delivery_id>\n<sha256_hex(raw_body)>`}</Code>
        <ul>
          <li>
            <strong>Reject stale timestamps</strong> — the signature is
            only valid within 300 seconds of{" "}
            <span className="sm-mono">X-StackMate-Timestamp</span>.
          </li>
          <li>
            <strong>Idempotency:</strong>{" "}
            <span className="sm-mono">X-StackMate-Delivery</span> is
            unique per delivery attempt. Store it and ignore a delivery
            you have already processed — retries and duplicates are
            normal.
          </li>
          <li>
            <strong>React immediately:</strong> on{" "}
            <span className="sm-mono">license.suspended</span> or{" "}
            <span className="sm-mono">license.expired</span>, stop
            granting access on the next request — do not wait for the
            next validate. On{" "}
            <span className="sm-mono">license.reactivated</span>, restore
            access and re-validate to fetch a fresh entitlement token.
          </li>
          <li>
            <strong>Test endpoint:</strong> use “Send test event” on the
            webhook endpoint in Settings → Webhooks; it delivers a{" "}
            <span className="sm-mono">webhook.test</span> event with the
            same signing.
          </li>
        </ul>
      </GuideCard>

      <GuideCard id="renewal-ux" title="6. Renewal prompt UX">
        <p>
          When validate returns <strong>LICENSE_EXPIRED</strong> or{" "}
          <strong>LICENSE_SUSPENDED</strong>, the product must show a
          renewal prompt — not a blank error. The prompt must:
        </p>
        <ul>
          <li>
            Say plainly what happened (“Your license expired on
            17/11/2026” / “Your license is suspended — a scheduled
            payment was missed”) and what fixes it (“Renew to restore
            access”).
          </li>
          <li>
            Link the customer to the renewal / contact channel the
            business provides (the renewal invoice is created by
            StackMate; the product links to it, it never creates payment
            state itself).
          </li>
          <li>
            Keep working in a read-only / limited mode where the product
            can — never delete the customer’s data because a license
            lapsed.
          </li>
          <li>
            During the subscription grace window (before suspension),
            show a non-blocking warning (“Renewal due in 3 days — renew
            to avoid interruption”) and keep full access.
          </li>
          <li>
            After a renewal payment is verified, StackMate reactivates
            the license and pushes{" "}
            <span className="sm-mono">license.reactivated</span> — the
            product restores access on that event (and on the next
            validate).
          </li>
        </ul>
      </GuideCard>
    </section>
  );
}
