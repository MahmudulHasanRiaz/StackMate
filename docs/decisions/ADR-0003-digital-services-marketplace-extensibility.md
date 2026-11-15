# ADR-0003: Extensibility for a Digital Services Marketplace

- **Status:** Accepted as an architectural constraint; detailed product scope deferred
- **Date:** 15 November 2026
- **Decision owners:** StackMate product and engineering

## Context

The first release focuses on software products, subscriptions, licenses, and related commerce. A later release may allow independent digital-service providers (for example, website development agencies/freelancers) to publish service listings and sell work through StackMate.

## Decision

Design the core catalog and commerce boundaries so they can support both software entitlements and service fulfillment without treating every purchase as a license.

Keep these concerns separable:

- **Catalog:** sellable item identity, category, media, visibility, seller/provider ownership, and publication state.
- **Commercial terms:** versioned price, currency, tax/fee configuration, optional package/variants, and immutable order-line snapshot.
- **Checkout and payments:** buyer, authoritative server-side pricing, payment attempts, verification, refunds, and ledger/audit records.
- **Fulfillment:** strategy selected by item type. Software fulfillment may grant entitlements/licenses; service fulfillment may create a service job with scope, quote, milestones, deliverables, revisions, and acceptance.
- **Provider marketplace (future):** provider profile/onboarding, service listing ownership, quote/proposal, provider workspaces, platform commission, payout accounting, reviews, dispute handling, and provider permissions.

The core order/payment model must not assume that every order produces a subscription or license. Use explicit fulfillment types/handlers and typed relationships rather than nullable fields overloaded across unrelated workflows.

Preserve seller/provider identity on catalog items and orders from the beginning where this can be done without compromising the initial single-operator workflow. Keep tenant/seller isolation and authorization server-side. Do not assume a provider is trusted merely because they created a listing.

## Explicitly deferred

This ADR does not authorize building a multi-vendor marketplace in the first release. Provider verification, tax/legal obligations, dispute/refund policy, payout rails, commission rules, service-level agreements, and seller onboarding require separate product and compliance decisions before implementation.

## Consequences

- Product licensing remains a dedicated fulfillment module, not a universal order side effect.
- Future service orders can share checkout, payment, customer, notification, and audit infrastructure while owning a separate delivery lifecycle.
- Avoid implementing marketplace tables prematurely. Add detailed schema and API contracts only when the marketplace scope is approved.
- New catalog/order changes must preserve the distinction between product fulfillment and service fulfillment.
