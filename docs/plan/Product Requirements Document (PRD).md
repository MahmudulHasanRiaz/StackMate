# Product Requirements Document (PRD)
# Centralized Product, Licensing, Subscription & Commerce Management Platform

**Document Version:** 1.0  
**Date:** 15 November 2026  
**Product Type:** Centralized Multi-Product Software Management Platform  
**Initial Market:** Bangladesh  
**Deployment Infrastructure:** Cloudflare Workers  
**Primary Database:** Neon PostgreSQL  
**Backend Framework:** Hono  
**Frontend Framework:** React + Vite + TanStack Router  
**ORM:** Drizzle ORM  
**Authentication:** Better Auth  
**Object Storage:** Cloudflare R2  
**Primary Payment Method:** Manual MFS & Bank Transfer  
**External Landing Page Technology:** Astro (independently developed and deployed)

---

# 1. Product Overview

## 1.1 Product Vision

Build a centralized platform that manages multiple independent software products, WordPress plugins, SaaS applications, dedicated client deployments, product licensing, subscription billing, orders, payment processing, product features, packages, pricing, and marketing integrations through one unified administration system.

The platform will act as a central control plane for all current and future software products.

Every product will have its own identity, features, packages, pricing, licenses, and integrations, but the underlying business operations will be managed centrally.

The platform must support adding new software products without requiring modifications to the core architecture or the creation of separate administration systems.

## 1.2 Core Concept

The system will follow a centralized management architecture:

- One central Admin Panel.
- One central Backend API.
- One primary PostgreSQL database.
- Multiple independently developed product websites and landing pages.
- Multiple WordPress plugins.
- Multiple dedicated SaaS deployments.
- One unified product, customer, order, subscription, payment, and licensing system.

External applications will communicate with the central platform through documented REST APIs and appropriate SDKs.

They will not require their own product-management database or independent order-management system.

## 1.3 Primary Objectives

1. Manage unlimited products through a centralized catalog.
2. Define product-specific features and feature entitlements.
3. Create reusable packages using selected product features.
4. Support multiple pricing models for each package.
5. Generate standard and custom licenses.
6. Manage customers, orders, subscriptions, and renewals.
7. Support manual payments through Bangladesh-focused MFS and bank transfers.
8. Integrate future automated payment gateways without restructuring the billing engine.
9. Connect external landing pages and websites using secure API integration.
10. Centralize marketing tracking and Meta Conversions API delivery.
11. Support WordPress plugin and dedicated SaaS license validation.
12. Provide a clean, modern, fast, and maintainable administrative experience.

---

# 2. Technology Stack & Architectural Decisions

The following technology choices are accepted architectural decisions for the initial implementation.

| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Language | TypeScript |
| Routing | TanStack Router |
| API State | TanStack Query |
| Backend | Hono |
| Runtime | Cloudflare Workers |
| Database | Neon PostgreSQL |
| ORM | Drizzle ORM |
| Authentication | Better Auth |
| Validation | Zod |
| Object Storage | Cloudflare R2 |
| API Documentation | OpenAPI |
| Background Processing | Initially request/scheduled processing; Cloudflare Queues when justified |
| External Landing Pages | Astro |
| WordPress Integration | PHP SDK |
| TypeScript Integration | JavaScript/TypeScript SDK |

## 2.1 Frontend Architecture

The Admin Panel must be a React SPA built using Vite and TanStack Router.

Requirements:

- File-based or well-organized route definitions.
- Fully typed route parameters and search parameters.
- Nested layouts.
- Lazy-loaded routes and modules.
- Route-level code splitting.
- TanStack Query for remote server state.
- TanStack Table for advanced data tables.
- A consistent form and validation system.
- Reusable design-system components.

The Admin Panel does not require SEO-oriented server rendering.

Do not introduce Next.js or TanStack Start solely for this project.

## 2.2 Backend Architecture

Hono will be the central backend framework.

The backend must initially follow a Modular Monolith architecture.

Each business domain must have its own isolated module, including:

- Authentication & Authorization
- Users & Customers
- Products
- Features & Entitlements
- Packages & Pricing
- Orders
- Payments
- Subscriptions
- Licensing
- Integrations
- Tracking
- Webhooks
- Notifications
- Audit Logs

Modules must not directly depend on unrelated modules' internal implementation details.

Use explicit service interfaces and controlled module dependencies.

Do not create multiple independent Workers unnecessarily. Separate Workers may be introduced when operational requirements, traffic, security isolation, or independent scaling justify them.

## 2.3 Database Architecture

Neon PostgreSQL will be the initial primary database.

Drizzle ORM will be used for:

- Schema definitions.
- Queries.
- Relations.
- Migrations.
- Transactions.
- Type-safe database access.

Database configuration must remain provider-independent.

The application must use environment-based database configuration so that another PostgreSQL provider can be introduced later without rewriting business logic.

Potential future providers:

- Supabase PostgreSQL.
- Self-hosted PostgreSQL.
- Other PostgreSQL-compatible managed providers.

Do not depend on Neon-specific database features in core business logic unless explicitly isolated behind an adapter.

### Cloudflare Database Connectivity

Do not assume that Hyperdrive is mandatory.

Evaluate the following:

1. Neon-supported Cloudflare Workers connection methods.
2. Drizzle driver compatibility.
3. Better Auth database adapter compatibility.
4. Transaction requirements.
5. Connection lifecycle and pooling.
6. Actual latency and concurrency under representative workloads.

Select the simplest production-safe configuration.

Hyperdrive may be introduced if connection pooling or measured database connectivity requirements justify it.

The Better Auth database integration must be validated independently. Avoid unsafe global connection pools or request lifecycle assumptions that are incompatible with Workers.

## 2.4 Cloudflare Services Policy

Cloudflare Workers and R2 are required.

Other Cloudflare services are optional and must be introduced only when justified.

| Service | Initial decision |
|---|---|
| Workers | Required |
| R2 | Required |
| KV | Optional; not required initially |
| Hyperdrive | Evaluate; not mandatory |
| Queues | Introduce when asynchronous workloads justify them |
| Durable Objects | Not required initially |
| D1 | Do not use |
| Workers Analytics Engine | Optional future consideration |
| Cron Triggers | Use for scheduled renewal and maintenance tasks when required |

Avoid unnecessary infrastructure costs and premature distributed-system complexity.

---

# 3. System Architecture

## 3.1 High-Level Architecture

The platform will contain the following independent interfaces:

### A. Central Admin Panel

React + Vite SPA.

Used by platform administrators and authorized staff to manage the entire business.

### B. External Product Websites

Independently developed websites.

Examples:

- Product marketing websites.
- Sales landing pages.
- Product documentation websites.
- Product checkout interfaces.

Astro is the preferred technology for external marketing and sales websites.

These websites are not part of the central Admin Panel repository.

### C. WordPress Plugins

Independent WordPress plugins that communicate with the central API through a PHP SDK or documented API integration.

### D. Dedicated SaaS Deployments

Independently deployed client applications that retrieve their authorized product entitlements from the central licensing platform.

### E. Central Backend API

One Hono-based backend providing the business APIs for all connected applications.

### F. Central Database

Neon PostgreSQL containing authoritative platform data.

## 3.2 Integration Principle

All external applications must communicate through the central API.

No external landing page or connected product website should require its own order-management database.

External applications may maintain their own application-specific data when necessary, but central commercial records must remain authoritative in the central platform.

---

# 4. Authentication, Authorization & User Management

## 4.1 Authentication

Use Better Auth.

Initial authentication requirements:

- Email and password.
- Secure password hashing.
- Session management.
- Email verification.
- Password reset.
- Session expiration.
- Session revocation.
- Login protection.
- Optional MFA support in a future phase.

Authentication must be compatible with Cloudflare Workers.

## 4.2 Role-Based Access Control

Implement granular RBAC.

Initial roles:

| Role | Description |
|---|---|
| Super Admin | Full platform control |
| Admin | Administrative access according to permissions |
| Finance Manager | Orders, payments, invoices, subscriptions |
| License Manager | License and activation management |
| Product Manager | Product catalog, features, packages |
| Support Staff | Customer and support operations |
| Marketing Manager | Integrations and tracking |
| Read Only | Authorized read-only access |

Permissions must be independently configurable.

Examples:

- `products.create`
- `products.update`
- `features.manage`
- `packages.publish`
- `orders.create`
- `payments.approve`
- `payments.reject`
- `licenses.revoke`
- `subscriptions.manage`
- `integrations.manage`
- `tracking.manage`
- `users.manage`

Sensitive operations must require appropriate permissions.

All important administrative changes must be recorded in audit logs.

---

# 5. Product Management

## 5.1 Product Catalog

Create a centralized Product Management module.

Administrators can add, edit, archive, publish, and manage products.

### Product Fields

| Field | Type |
|---|---|
| Product ID | UUID |
| Product Name | String |
| Slug | Unique string |
| Product Code | Unique string |
| Description | Text |
| Product Type | Enum |
| Distribution Type | Enum/Relations |
| Logo | R2 object reference |
| Website URL | URL |
| Documentation URL | URL |
| Status | Draft / Active / Archived |
| Created At | Timestamp |
| Updated At | Timestamp |

### Product Types

Initial supported categories:

1. WordPress Plugin.
2. SaaS Application.
3. Dedicated SaaS Deployment.
4. Software / API Product.
5. Other.

The product architecture must be extensible.

A product may support more than one distribution channel.

For example, a software product may have both a hosted SaaS offering and a self-hosted dedicated deployment offering.

Do not assume that product type and distribution method are interchangeable.

## 5.2 Product Management UI

Product list requirements:

- Product logo.
- Product name.
- Product code.
- Product type.
- Distribution channels.
- Status.
- Number of features.
- Number of packages.
- Quick actions.

Actions:

- View.
- Edit.
- Manage Features.
- Manage Packages.
- View Orders.
- Archive.

Use a product details page with contextual tabs rather than putting every management function inside one excessively large form.

---

# 6. Feature Management & Entitlement System

This is a core platform module.

## 6.1 Product-Specific Feature Catalog

Every product must have its own feature catalog.

Features must not accidentally be shared across products.

A feature belongs to one product.

Example:

**Product: WooMate Pro**

| Feature Name | Feature Key | Type |
|---|---|---|
| Fraud Detection | fraud_detection | Boolean |
| Phone Validation | phone_validation | Boolean |
| Courier Tracking | courier_tracking | Boolean |
| Bulk Export | bulk_export | Boolean |
| Maximum Websites | max_websites | Limit |
| Monthly Orders | monthly_orders | Quota |
| API Requests | api_requests | Metered |
| Advanced Analytics | advanced_analytics | Boolean |

## 6.2 Feature Types

Support at least four feature types.

### Boolean

Example:

`advanced_analytics = true`

### Limit

Example:

`max_websites = 5`

### Quota

Example:

`monthly_orders = 10000`

### Metered

Example:

`api_requests = 100000`

Feature values must be validated according to feature type.

For Boolean features, only valid Boolean values are accepted.

For numeric limits and quotas, negative values must be rejected unless a documented special convention exists.

Unlimited values must use an explicit representation, not arbitrary large numbers.

## 6.3 Feature Metadata

Each feature should contain:

- Name.
- Stable unique key.
- Description.
- Type.
- Unit.
- Default value.
- Status.
- Product reference.
- Created and updated timestamps.

Feature keys must remain stable after external SDKs begin using them.

Do not automatically rename published feature keys.

## 6.4 Entitlements vs Internal Feature Flags

These are separate concepts.

### Customer Entitlements

Define what a customer has purchased or is authorized to use.

Examples:

- Advanced Analytics enabled.
- Maximum five websites.
- Monthly order quota of 10,000.

### Internal Feature Flags

Control application-level functionality rollout.

Examples:

- Enable a new experimental dashboard.
- Gradually release a feature.
- Disable a problematic internal functionality.

Do not use customer entitlements as a replacement for internal feature rollout controls.

## 6.5 Feature Management UI

The Features menu must contain:

1. Product selector.
2. Product-specific feature list.
3. Add Feature action.
4. Edit Feature action.
5. Archive Feature action.
6. Feature type indicators.
7. Search and filtering.
8. Feature usage and package association information where available.

Feature creation must use a concise form.

Feature type selection should dynamically show only relevant configuration fields.

---

# 7. Package & Plan Management

## 7.1 Package Builder

Packages are product-specific collections of features and entitlement values.

An administrator must be able to create unlimited packages for each product.

Examples:

- Free.
- Starter.
- Business.
- Professional.
- Enterprise.
- Custom.

These names are examples, not fixed system-defined plans.

## 7.2 Package Creation Flow

1. Select Product.
2. Enter Package Name.
3. Enter Package Description.
4. Select Features.
5. Configure entitlement values.
6. Configure availability.
7. Review configuration.
8. Save as Draft or Publish.

## 7.3 Feature Selection

The package builder must retrieve features from the selected product only.

Each selected feature must expose its relevant configuration.

Example:

| Feature | Enabled | Value |
|---|---|---|
| Fraud Detection | Yes | — |
| Courier Tracking | Yes | — |
| Advanced Analytics | Yes | — |
| Maximum Websites | Yes | 5 |
| Monthly Orders | Yes | 10,000 |
| API Requests | No | — |

The package must not accept features belonging to another product.

## 7.4 Package and Pricing Separation

Package and Price must be separate database entities.

One package can have multiple price options.

Example:

**Business Package**

- Monthly: ৳499.
- Yearly: ৳4,999.
- Lifetime: ৳9,999.

These are illustrative values.

Supported pricing models:

- Free.
- One-time.
- Monthly.
- Quarterly.
- Half-yearly.
- Yearly.
- Custom recurring interval.
- Lifetime.

Pricing configuration must support:

- Currency.
- Amount.
- Billing interval.
- Trial period.
- Setup fee.
- Tax treatment.
- Active/inactive status.
- Effective date.
- Price version.

Do not modify existing order or subscription pricing history when a price is updated.

## 7.5 Package Versioning

Published package configurations must be versioned.

When a package changes:

- Create a new version.
- Preserve previous versions.
- Preserve historical order snapshots.
- Preserve active subscription entitlement snapshots unless an explicit migration is approved.

---

# 8. Custom Package Builder

The platform must support custom packages that are not based on an existing published package.

This feature is essential for manually negotiated client deals.

## 8.1 Custom Package Flow

1. Select Customer.
2. Select Product.
3. Choose Existing Package or Custom Package.
4. Select individual features.
5. Configure feature limits and quotas.
6. Configure custom price.
7. Select billing type.
8. Set validity and billing terms.
9. Review.
10. Create Order.

## 8.2 Custom Entitlement Snapshot

Every custom order must preserve its own entitlement configuration.

The system must not rely on the current state of a reusable package to reconstruct a historical custom order.

Custom configurations must be saved as immutable snapshots associated with the order and resulting license/subscription.

Administrators may optionally save a custom configuration as a reusable package.

## 8.3 Custom Package UI

Use a dedicated visual package builder.

The interface must provide:

- Feature selection.
- Dynamic configuration fields.
- Selected feature summary.
- Pricing editor.
- Billing interval selector.
- Final review.

Do not create a separate database product or duplicate the entire feature catalog for every custom package.

---

# 9. Customer Management

Create a centralized customer directory.

Customer fields:

- Customer ID.
- Name.
- Email.
- Phone.
- Company name.
- Billing address.
- Country.
- Customer status.
- Registration source.
- Created date.

Customer detail page should contain tabs:

1. Overview.
2. Orders.
3. Payments.
4. Subscriptions.
5. Licenses.
6. Connected Installations.
7. Activity History.

Customer records must be reusable across different products.

One customer may purchase multiple products.

Do not create duplicate customers for each product unless there is an explicit reason.

---

# 10. Order Management

## 10.1 Central Order Engine

All orders must be managed centrally.

Order sources:

- External landing pages.
- Product websites.
- Manual Admin Panel creation.
- Future third-party integrations.

## 10.2 Order Fields

- Order ID.
- Order Number.
- Customer ID.
- Product ID.
- Package ID, nullable for custom packages.
- Price ID, where applicable.
- Order source.
- Amount.
- Currency.
- Discount.
- Tax.
- Total.
- Payment status.
- Order status.
- Entitlement snapshot.
- Created date.

## 10.3 Order Status

Suggested statuses:

- Pending.
- Awaiting Payment.
- Processing.
- Completed.
- Cancelled.
- Failed.
- Refunded.
- Partially Refunded.

Payment status must be maintained separately.

## 10.4 Manual Order Creation

Admin users with appropriate permissions must be able to:

- Select existing customers.
- Create new customers.
- Select products.
- Select published packages.
- Create custom packages.
- Configure billing.
- Apply discounts.
- Select payment method.
- Create unpaid or paid orders according to authorized workflow.

Creating an order must not automatically mark payment as received.

Only verified payment or an explicitly authorized and audited manual payment confirmation can move an order into a paid state.

---

# 11. Payment Gateway Architecture

## 11.1 Payment System Overview

The platform will initially use a manually verified payment system designed for the Bangladesh market.

The payment architecture must be gateway-independent.

Create a Payment Gateway module that supports multiple payment gateway types.

Initial gateway type:

`MANUAL`

Future gateway types:

- bKash API.
- Nagad API.
- Other MFS integrations.
- Automated bank/payment gateway integrations.
- International payment gateways.

The order and subscription systems must not contain payment-provider-specific business logic.

Payment providers must communicate with a common payment interface.

## 11.2 Payment Gateway Management

Admin navigation:

**Payments → Payment Gateways**

An administrator can:

- Add Gateway.
- Edit Gateway.
- Enable Gateway.
- Disable Gateway.
- Delete/archive Gateway.
- Change display order.
- Configure instructions.
- Configure payment verification requirements.

A gateway must have:

- Gateway ID.
- Gateway Name.
- Gateway Type.
- Provider.
- Display Name.
- Logo.
- Description.
- Status.
- Configuration.
- Display Order.

## 11.3 Manual MFS Gateway

MFS is the first payment method category.

Examples:

- bKash.
- Nagad.
- Other supported MFS providers.

Each gateway can contain multiple payment accounts.

### MFS Account Fields

- Account Name / Internal Label.
- MFS Provider.
- Account Type.
- Account Number.
- Logo.
- Payment Instructions.
- Transaction ID Requirement.
- Status.
- Display Order.

### Account Types

Initial supported types:

1. Personal.
2. Merchant.
3. Agent.

The payment instructions must depend on account type and the selected provider's actual rules.

Examples:

- Personal: Send Money.
- Merchant: Merchant Payment.
- Agent: Cash-out, where supported by the provider's applicable process.

Do not assume that every MFS provider supports identical account types or transaction methods.

The administrator must be able to configure each account independently.

### Multiple Accounts

The platform must support:

- Multiple bKash accounts.
- Multiple Nagad accounts.
- Multiple accounts from other MFS providers.
- Individual activation/deactivation.
- Custom ordering.
- Account-specific instructions.

The system must not require a single account per provider.

## 11.4 MFS Customer Payment Flow

After placing an order, the customer must see a clean payment modal or dedicated checkout payment step.

The UI should be visually polished and comparable in interaction quality to a modern hosted checkout experience.

It must not copy another payment provider's branding.

### Step 1: Payment Method Selection

Display only active payment gateways.

Example:

- bKash.
- Nagad.
- Other enabled MFS options.
- Bank Transfer.

Each method should show its logo and concise display name.

### Step 2: Account Selection

If multiple accounts are configured for a selected provider, show available accounts or select an eligible account according to the gateway configuration.

Display:

- Provider.
- Account type.
- Receiving number.
- Required payment method.
- Amount payable.

### Step 3: Payment Instructions

Show concise instructions.

Example:

- Send the exact order amount.
- Use the displayed receiving number.
- Select the appropriate transaction method.
- Submit the sender information after completing the transfer.

The receiving number must be copyable.

Do not display unnecessary paragraphs or repeated instructional text.

### Step 4: Payment Submission

After making the payment, the customer submits:

- Sender's MFS number.
- Transaction ID, according to configuration.
- Payment amount.
- Selected receiving account.
- Optional payment reference or supporting information, if enabled.

### Transaction ID Configuration

Each MFS account must support three modes:

1. Required.
2. Optional.
3. Disabled.

Behavior:

| Configuration | Customer UI |
|---|---|
| Required | Must enter Transaction ID |
| Optional | May enter Transaction ID |
| Disabled | Transaction ID field hidden |

### Step 5: Submission Confirmation

After submission:

- Create a payment submission record.
- Associate it with the order.
- Set status to Pending Verification.
- Show confirmation to the customer.
- Do not activate the license yet.

A submitted transaction ID or screenshot is not proof of successful payment.

## 11.5 Manual Bank Transfer Gateway

Bank Transfer is a separate manual payment method category.

Each configured bank account must support:

- Bank Name.
- Account Holder Name.
- Account Number.
- Branch Name.
- Routing Number, where applicable.
- Bank Logo.
- Address or additional account information.
- Supported transfer methods.
- Payment Instructions.
- Status.
- Display Order.

### Transfer Methods

The system must support configurable transfer rails.

Possible methods include:

- NPSB.
- BEFTN.
- RTGS.

The term `NBFT` must not be treated as an assumed standard bank-transfer rail. The implementation must use verified terminology and the actual supported methods of the selected bank.

The available methods must be configurable per bank account.

Do not display an unsupported transfer method to customers.

### Customer Bank Transfer Flow

1. Select Bank Transfer.
2. Select an available receiving bank account.
3. View account information.
4. View supported transfer methods.
5. Select the available transfer method.
6. Complete the transfer externally.
7. Enter sender information.
8. Submit payment details.

Required submission fields should be configurable.

Potential fields:

- Sender Bank.
- Sender Account Holder.
- Sender Account Number.
- Transfer Method.
- Transfer Date.
- Amount.
- Reference Number.
- Transaction Reference, if applicable.

Bank transfer submission must follow the same manual verification workflow as MFS.

## 11.6 Payment Management

Admin navigation:

**Payments → All Payments**

Payment list columns:

- Payment Reference.
- Order Number.
- Customer.
- Product.
- Gateway.
- Payment Method.
- Amount.
- Sender Information.
- Transaction Reference.
- Submission Date.
- Status.

### Payment Status

- Pending Verification.
- Approved.
- Rejected.
- Cancelled.
- Refunded, where applicable.

### Payment Details

When an administrator opens a payment, show:

- Order details.
- Customer details.
- Payment gateway.
- Receiving account.
- Sender details.
- Transaction information.
- Amount.
- Submission date.
- Previous verification attempts.
- Administrative history.

### Approve Action

When approved:

1. Record the verifying administrator.
2. Record the approval timestamp.
3. Record the verification reference or note.
4. Mark the payment as approved.
5. Trigger the corresponding order payment transition.
6. Activate the subscription when appropriate.
7. Issue the license when appropriate.
8. Record the audit event.
9. Send customer notification.

Payment approval must only happen after the actual receipt is verified through the relevant account or bank records.

### Reject Action

When rejected:

1. Require an appropriate rejection reason.
2. Record the administrator.
3. Record timestamp.
4. Preserve the original submission.
5. Notify the customer.
6. Keep the order unpaid.
7. Do not issue a paid license.

A customer may be allowed to submit a new payment attempt according to order policy.

Do not overwrite rejected payment attempts.

### Duplicate Submission Protection

Implement safeguards against:

- Repeated form submission.
- Duplicate transaction references.
- Repeated approval requests.
- Duplicate payment-to-order association.

Transaction reference uniqueness should be scoped appropriately. Do not assume all providers produce globally unique identifiers.

## 11.7 Payment Abstraction for Future Automated Gateways

The payment module must use a provider abstraction.

Suggested interface:

```ts
interface PaymentGatewayAdapter {
  createPayment(input: CreatePaymentInput): Promise<PaymentResult>;

  verifyPayment(input: VerifyPaymentInput): Promise<VerificationResult>;

  refundPayment?(
    input: RefundPaymentInput
  ): Promise<RefundResult>;

  handleWebhook?(
    request: Request
  ): Promise<NormalizedPaymentEvent>;
}
```

Manual payments will implement the same normalized payment lifecycle through administrator verification rather than an automated provider API.

Adding bKash API or Nagad API later must not require rewriting Order, Subscription, or License modules.

---

# 12. Subscription Management

Subscriptions represent ongoing commercial agreements.

They must remain separate from licenses and payments.

## 12.1 Subscription Types

- Free.
- One-time purchase.
- Monthly recurring.
- Quarterly recurring.
- Half-yearly recurring.
- Yearly recurring.
- Custom recurring.
- Lifetime.

## 12.2 Subscription Fields

- Subscription ID.
- Customer ID.
- Product ID.
- Package ID, if applicable.
- Price ID.
- Billing interval.
- Amount.
- Currency.
- Start date.
- Current period start.
- Current period end.
- Next renewal date.
- Status.
- Entitlement snapshot.

## 12.3 Subscription Status

- Trialing.
- Active.
- Past Due.
- Paused.
- Cancelled.
- Expired.

## 12.4 Manual Payment Renewals

Since the initial payment gateway is manual, recurring payments must not be represented as automatic bank debits.

The initial renewal process will be:

1. Detect upcoming renewal.
2. Generate renewal invoice/order.
3. Notify customer.
4. Customer manually transfers the amount.
5. Customer submits payment information.
6. Administrator verifies payment.
7. Subscription period is extended.
8. Entitlement and license validity are updated.

Failed or unverified renewal submissions must not extend subscription validity.

Support configurable reminder intervals.

Automatic gateway-based renewal can be introduced when a compatible payment provider is integrated.

## 12.5 Renewal Management UI

Display:

- Upcoming renewals.
- Due renewals.
- Overdue subscriptions.
- Recently renewed subscriptions.
- Failed renewal attempts.
- Cancelled subscriptions.

---

# 13. License Management Engine

Licensing is a core system capability.

The platform must support different software distribution types without requiring separate licensing systems.

## 13.1 License Types

Initial supported integration categories:

### WordPress Plugin License

Supports:

- Domain activation.
- Website activation limit.
- Plugin identity.
- Product version.
- License validity.
- Update authorization.
- Feature entitlements.

### Dedicated SaaS License

Supports:

- Client identity.
- Deployment identity.
- Deployment URL.
- Environment.
- Product identity.
- Authorized entitlements.
- Validity.
- Deployment count or instance limits.

## 13.2 License Fields

- License ID.
- License Key or public identifier.
- Customer ID.
- Product ID.
- Subscription ID.
- Order ID.
- Distribution Type.
- Status.
- Valid From.
- Valid Until.
- Activation Limit.
- Entitlement Snapshot.
- Created Date.

License secrets must be stored securely. Do not store reusable plaintext license secrets unnecessarily.

## 13.3 License Lifecycle

1. Order created.
2. Payment verified.
3. Subscription created or activated.
4. License generated.
5. License activated by connected software.
6. Entitlements retrieved.
7. Periodic validation.
8. Renewal, suspension, expiry, or revocation.

## 13.4 License Validation API

Initial endpoint proposal:

```text
POST /v1/licenses/activate
POST /v1/licenses/validate
POST /v1/licenses/deactivate
GET  /v1/licenses/entitlements
```

The API must support product-specific validation policies.

## 13.5 Signed Entitlement Documents

The platform should support cryptographically signed entitlement responses.

Recommended design:

- Ed25519 signing.
- Private signing key kept only on the backend.
- Public verification key distributed to authorized SDKs.
- Expiry timestamp.
- Product identifier.
- License identifier.
- Entitlement values.
- Activation context.

External applications must not receive signing secrets.

SDKs must verify signatures locally.

Support a configurable validation refresh interval and a limited grace period for temporary connectivity problems.

Do not treat a cached entitlement as permanently valid.

## 13.6 License Activation Security

Activation must validate:

- License authenticity.
- Product identity.
- Subscription status.
- License status.
- Activation limits.
- Authorized domain/deployment policy.
- Entitlement validity.

Domain restrictions are an additional policy, not a replacement for cryptographic authentication.

---

# 14. Website & Landing Page Integration

This module is responsible for registering external websites and landing pages.

The websites are independently developed and deployed.

Astro is the preferred external landing page technology.

They are not part of the Central Admin Panel's initial codebase.

## 14.1 Integration Concept

The Admin Panel must allow administrators to register external websites.

Example:

```text
Integrations
    └── Websites
          ├── Add Website
          ├── Manage Websites
          └── Website Details
```

## 14.2 Add Website Flow

Required fields:

- Website Name.
- Website URL.
- Primary Domain.
- Associated Product.
- Website Type.
- Status.

Website types:

- Landing Page.
- Product Website.
- Documentation Website.
- Checkout Website.
- Other.

After successful registration, generate:

- Site ID.
- Public Site Identifier.
- Public Integration Token.
- Optional server-side secret, when required.

The administrator must be able to regenerate and revoke credentials.

## 14.3 Domain Verification

The registered domain must be validated.

Recommended controls:

- Normalize domain names.
- Enforce HTTPS in production.
- Configure allowed origins.
- Support multiple explicitly authorized domains if needed.
- Verify domain ownership for sensitive integrations.

CORS and Origin validation are useful browser security controls, but they are not sufficient authentication mechanisms.

A public browser token must never authorize privileged server operations.

## 14.4 Public and Private Credentials

Use separate credential categories.

### Public Site Credential

Used by browser-based landing pages.

Allowed operations:

- Read public product information.
- Read public package information.
- Create restricted checkout sessions.
- Submit permitted tracking events.

### Server-side Secret

Used only by trusted server applications.

Allowed operations according to permissions:

- Server-to-server order operations.
- Protected webhook operations.
- Privileged integrations.
- Restricted administrative workflows.

Secrets must be hashed or encrypted appropriately, shown only when initially generated, and revocable.

Never expose server-side secrets in JavaScript bundles.

## 14.5 External Landing Page SDK

Provide a documented JavaScript/TypeScript SDK.

Suggested package name:

`@platform/landing-sdk`

Core capabilities:

- Initialize site integration.
- Retrieve product data.
- Retrieve packages and prices.
- Create checkout sessions.
- Submit tracking events.
- Capture campaign attribution.
- Handle checkout results.

The SDK must use versioned APIs.

## 14.6 Website Integration Documentation

Create a dedicated developer documentation area.

It should include:

1. Integration overview.
2. Website registration.
3. Domain verification.
4. Public credential setup.
5. SDK installation.
6. Product data retrieval.
7. Checkout integration.
8. Tracking integration.
9. Error handling.
10. Security requirements.
11. Webhook integration.
12. API reference.

A developer must be able to integrate an independently deployed Astro website by following the documentation without needing to access the central Admin Panel's source code.

## 14.7 Checkout Integration

The external landing page must never calculate authoritative payment amounts.

The central backend must validate:

- Product ID.
- Package ID.
- Price ID.
- Current price.
- Customer identity or checkout customer information.
- Currency.
- Availability.

The backend creates the authoritative order or checkout session.

---

# 15. Meta Pixel & Conversions API Integration

Build a centralized tracking module.

It must support multiple products and multiple registered websites.

## 15.1 Tracking Configuration

Each website integration can have its own tracking configuration.

Fields:

- Tracking Provider.
- Meta Pixel ID.
- Meta CAPI Access Token.
- Test Event Code.
- Enabled Events.
- Event Mapping.
- Allowed Domains.
- Status.

Credentials must be encrypted at rest.

## 15.2 Browser Events

Support standard events where applicable:

- PageView.
- ViewContent.
- Lead.
- InitiateCheckout.
- AddPaymentInfo.
- Purchase.

## 15.3 Server Events

Server-side tracking must be processed centrally.

Architecture:

```text
External Website
      |
      | Browser Event / API Event
      v
Central Tracking API
      |
      | Validation
      | Event Normalization
      | Event ID
      | Attribution
      v
Event Processing
      |
      v
Meta Conversions API
```

## 15.4 Event Deduplication

Use matching event identifiers for corresponding browser and server events.

Store:

- Event ID.
- Event Name.
- Event Source.
- Site ID.
- Product ID.
- Order ID, when applicable.
- Event Time.
- Processing Status.

For Purchase events, use verified backend payment events rather than untrusted browser claims.

## 15.5 Attribution

Capture relevant attribution parameters:

- UTM Source.
- UTM Medium.
- UTM Campaign.
- UTM Content.
- UTM Term.
- Landing Page.
- Referrer.
- Facebook Click ID, where available.
- Browser identifiers, where consent and applicable policy permit.

Do not expose customer personal data unnecessarily.

Implement appropriate consent and privacy controls for tracking.

## 15.6 Tracking Reliability

The system must support:

- Event validation.
- Duplicate detection.
- Delivery status.
- Retry policy.
- Failure logs.
- Test events.
- Event delivery history.

Background processing should be introduced when event volume and delivery requirements justify it.

---

# 16. Integrations & Webhooks

The central platform must support outbound and inbound integration workflows.

## 16.1 Webhook Events

Suggested event names:

```text
product.created
product.updated

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
```

## 16.2 Webhook Security

- HMAC signatures.
- Timestamp validation.
- Replay protection.
- Delivery attempts.
- Idempotency.
- Retry management.
- Delivery logs.
- Secret rotation.

## 16.3 Webhook Delivery

Webhook delivery must not block the primary order or payment response.

Use asynchronous processing when justified.

A failed external webhook must not reverse an already verified payment.

---

# 17. Admin Panel UI/UX Requirements

This section is mandatory and must be treated as a product requirement, not an optional visual preference.

## 17.1 Design Direction

The interface must be:

- Clean.
- Minimalistic.
- Modern.
- Professional.
- Consistent.
- Fast.
- Easy to understand.
- Suitable for extensive daily administrative use.

The visual quality should resemble a modern professional SaaS administration product.

Avoid unnecessarily decorative elements.

## 17.2 Strict UI Content Rule

Do not fill the interface with explanatory paragraphs.

Avoid:

- Two or three lines of explanatory text below every heading.
- Repeated descriptions of obvious functionality.
- Long instructional blocks inside forms.
- Decorative helper paragraphs.
- Excessive empty-state explanations.
- Redundant section introductions.

The interface must communicate through layout, labels, visual hierarchy, and contextual actions.

### Approved Information Patterns

Use:

1. Tooltips.
2. Small information icons.
3. Popovers.
4. Contextual help drawers.
5. Short field-level hints only when necessary.
6. Documentation links.
7. Confirmation dialogs.

Important information should remain accessible without permanently occupying screen space.

## 17.3 Visual Design System

Establish a centralized design system before implementing individual modules.

It must define:

- Color tokens.
- Typography.
- Spacing scale.
- Border radius.
- Shadows.
- Surface hierarchy.
- Icon conventions.
- Button variants.
- Form controls.
- Table styles.
- Modal sizes.
- Drawer behavior.
- Toast notifications.
- Responsive breakpoints.

Do not create inconsistent components separately in each module.

## 17.4 Layout

Recommended desktop layout:

- Fixed or collapsible sidebar.
- Top navigation bar.
- Breadcrumb navigation.
- Page title.
- Primary action.
- Main content.
- Contextual action area.

The sidebar should support grouped navigation and collapsed mode.

Avoid excessive nesting in navigation.

## 17.5 Tables

All major management modules must use a reusable data table system.

Required features:

- Search.
- Sorting.
- Filtering.
- Pagination.
- Column visibility.
- Responsive overflow.
- Row selection where useful.
- Bulk actions where appropriate.
- Loading skeleton.
- Empty state.
- Error state.

Use server-side pagination and filtering for large datasets.

Avoid loading thousands of records into the browser unnecessarily.

## 17.6 Forms

Forms must:

- Use consistent spacing.
- Group related fields logically.
- Validate inline.
- Show errors near the relevant field.
- Avoid excessive helper text.
- Support keyboard navigation.
- Prevent accidental double submission.
- Preserve appropriate unsaved form state.

For long forms, use logical sections or tabs.

## 17.7 Modals and Drawers

Use modals for:

- Short actions.
- Confirmation.
- Simple creation.
- Quick editing.

Use drawers or dedicated pages for:

- Complex details.
- Payment verification.
- License inspection.
- Multi-step configuration.
- Custom package building.

Do not put excessively complex forms into tiny modal windows.

## 17.8 Animation & Interaction

Animations must be subtle, consistent, and purposeful.

Requirements:

- Fast page transitions.
- Smooth modal and drawer opening.
- Dropdown transitions.
- Button interaction feedback.
- Skeleton loading transitions.
- Table row interaction states.
- Smooth sidebar collapse.
- Subtle hover states.

Avoid:

- Large decorative animations.
- Unnecessary bouncing.
- Slow transitions.
- Animations that block interaction.
- Excessive motion.

Respect `prefers-reduced-motion`.

Use CSS transitions and lightweight animation techniques wherever possible.

Animation must never compromise responsiveness or accessibility.

## 17.9 Performance

- Lazy-load non-critical modules.
- Split code by route.
- Avoid oversized component bundles.
- Prevent unnecessary React re-renders.
- Virtualize very large lists when necessary.
- Cache server data appropriately.
- Avoid excessive polling.
- Optimize image loading.
- Use responsive layouts.

## 17.10 Responsive Behavior

The primary target is desktop administration.

However, the interface must remain usable on:

- Desktop.
- Laptop.
- Tablet.
- Mobile.

Mobile layouts must prioritize essential operations without simply shrinking the desktop interface.

Payment verification and customer lookup should remain usable on mobile.

## 17.11 Accessibility

Support:

- Keyboard navigation.
- Visible focus indicators.
- Appropriate color contrast.
- Semantic HTML.
- Accessible labels.
- Screen-reader-friendly controls.
- Reduced motion preferences.

---

# 18. Dashboard & Analytics

The Admin Dashboard should provide a concise business overview.

## 18.1 Key Metrics

- Total Products.
- Active Products.
- Total Customers.
- Total Orders.
- Paid Orders.
- Pending Payments.
- Active Subscriptions.
- Upcoming Renewals.
- Active Licenses.
- Expired Licenses.
- Revenue.

## 18.2 Dashboard Charts

Potential charts:

- Revenue over time.
- Orders over time.
- Payment method distribution.
- Subscription growth.
- Product sales distribution.
- Renewal performance.

All metrics must use clearly defined date ranges and currency conventions.

Do not present incomplete or unverified payment submissions as revenue.

## 18.3 Dashboard Filters

- Date range.
- Product.
- Payment status.
- Subscription status.
- Order source.

Avoid unnecessary chart overload.

---

# 19. Database Domain Model

The initial database design must be normalized and maintainable.

The following is a logical entity inventory, not a requirement to place every field into one large table.

## 19.1 Identity & Access

- users
- sessions
- accounts
- verifications
- roles
- permissions
- role_permissions
- user_roles

Use Better Auth's required schema and adapters appropriately.

## 19.2 Product Catalog

- products
- product_distribution_channels
- product_versions
- product_features
- feature_definitions
- product_packages
- package_versions
- package_features
- package_prices

## 19.3 Customers & Commerce

- customers
- customer_addresses
- orders
- order_items
- order_entitlement_snapshots
- invoices
- discounts
- discount_redemptions

## 19.4 Payment

- payment_gateways
- payment_gateway_accounts
- payment_submissions
- payment_verification_logs
- payment_transactions
- payment_refunds

The payment model must support both manual and future automated providers.

Use structured provider-specific configuration with validation. Avoid storing every possible provider field as an unrelated nullable column.

## 19.5 Subscriptions

- subscriptions
- subscription_items
- subscription_periods
- subscription_events
- renewal_invoices

## 19.6 Licensing

- licenses
- license_activations
- license_entitlements
- license_validation_logs
- license_events
- signing_key_metadata

Private signing keys must not be stored in ordinary database fields without an appropriate secrets-management design.

## 19.7 Website Integrations

- integrated_sites
- site_domains
- site_credentials
- site_products
- integration_events

## 19.8 Tracking

- tracking_configurations
- tracking_events
- tracking_delivery_logs
- attribution_records

## 19.9 Webhooks & System

- webhook_endpoints
- webhook_deliveries
- audit_logs
- notifications
- system_settings
- scheduled_jobs

## 19.10 Data Integrity

Requirements:

- UUID primary keys where appropriate.
- Foreign key constraints.
- Unique constraints.
- Proper indexes.
- Transactional business operations.
- UTC timestamp storage.
- Explicit currency handling.
- Soft deletion only where appropriate.
- Immutable financial and historical records.

Do not use a generic JSON field as a substitute for relational modeling.

JSONB is appropriate for genuinely variable configuration and immutable snapshots, but core searchable business relationships must remain properly modeled.

---

# 20. Security Requirements

Security is mandatory throughout the platform.

## 20.1 Administrative Security

- RBAC.
- Session security.
- CSRF protection where applicable.
- Secure cookies.
- Rate limiting.
- Login protection.
- Audit logging.
- Sensitive action confirmation.
- MFA support.

## 20.2 API Security

- Input validation.
- Authentication.
- Authorization.
- Request size limits.
- Rate limiting.
- API versioning.
- Secure error responses.
- Credential rotation.
- Idempotency keys for financial operations.

## 20.3 Payment Security

- Never trust client-submitted payment success.
- Never mark an order paid merely because a form was submitted.
- Preserve all payment attempts.
- Require authorized verification.
- Audit all approvals and rejections.
- Prevent duplicate payment processing.
- Encrypt sensitive provider credentials.

## 20.4 Secret Management

Sensitive values include:

- Meta CAPI tokens.
- Server-side website credentials.
- Webhook secrets.
- License signing keys.
- Future payment API credentials.

Never expose these values in:

- Browser bundles.
- API responses.
- Client-side logs.
- Public error messages.

## 20.5 Tenant and Product Isolation

The platform may manage multiple clients and products.

All records must have appropriate ownership and relationship constraints.

Never rely solely on frontend filtering to enforce access restrictions.

Use server-side authorization and product/customer relationship checks.

---

# 21. API Architecture

Use REST APIs with versioning.

Base path:

`/v1`

Suggested API domains:

```text
/v1/auth
/v1/users
/v1/customers

/v1/products
/v1/products/:productId/features
/v1/products/:productId/packages
/v1/packages
/v1/prices

/v1/orders
/v1/invoices

/v1/payment-gateways
/v1/payment-submissions
/v1/payments

/v1/subscriptions
/v1/subscriptions/:id/renewals

/v1/licenses
/v1/licenses/activate
/v1/licenses/validate
/v1/licenses/entitlements

/v1/integrations/sites
/v1/integrations/credentials

/v1/tracking/events
/v1/tracking/configurations

/v1/webhooks
/v1/analytics
```

The final API structure must be based on clear resource boundaries.

Do not expose unnecessary internal database structures.

Use consistent:

- Response format.
- Error format.
- Pagination.
- Filtering.
- Sorting.
- Validation.
- Authorization.
- API documentation.

OpenAPI documentation must be generated or maintained alongside the implementation.

---

# 22. Background Processing & Scheduled Operations

Initially, avoid introducing background infrastructure without a workload requirement.

However, the architecture must be ready for asynchronous operations.

Potential workloads:

- Subscription reminders.
- Renewal invoice generation.
- Meta CAPI delivery.
- Email notifications.
- Webhook delivery.
- License maintenance.
- Analytics aggregation.

Use Cloudflare Queues when durable asynchronous processing, retries, and independent execution become necessary.

Use Cron Triggers for recurring scheduled tasks.

Every financial or licensing job must be idempotent.

Implement retry limits and a way to inspect failed jobs.

Do not make background job execution a hidden dependency that can silently lose payment or subscription events.

---

# 23. Non-Functional Requirements

## 23.1 Scalability

The architecture must support horizontal expansion through Cloudflare Workers without requiring application-level server management.

Do not promise a fixed concurrent-user capacity without workload benchmarks.

Scalability must be evaluated using:

- Requests per second.
- Concurrent requests.
- Database connection behavior.
- Query latency.
- CPU time.
- Memory usage.
- Error rates.
- Queue backlog.
- External provider latency.

## 23.2 Reliability

- Payment records must be durable.
- Approved payments must not be lost.
- License issuance must be idempotent.
- Subscription transitions must be transactional.
- External service failures must not corrupt internal financial records.
- Failed integrations must be observable.

## 23.3 Maintainability

- TypeScript throughout the frontend and backend.
- Modular backend architecture.
- Shared validation contracts where appropriate.
- Consistent naming.
- Documented business logic.
- Automated migrations.
- Unit and integration tests.
- No unnecessary abstractions.

## 23.4 Performance

Performance targets must be established through actual testing.

Initial engineering goals:

- Fast initial Admin Panel load.
- Efficient route-level code splitting.
- Responsive interactions.
- Efficient server-side pagination.
- Minimal unnecessary API calls.
- Optimized database access.
- No unbounded queries.
- No synchronous third-party network dependency in the critical payment response path.

---

# 24. Testing Requirements

Testing must cover both technical and business correctness.

## 24.1 Unit Tests

- Feature validation.
- Package entitlement calculation.
- Price calculation.
- Subscription transitions.
- License generation.
- Entitlement signature verification.
- Payment status transitions.
- Authorization policies.

## 24.2 Integration Tests

- Better Auth and database integration.
- Product creation.
- Feature creation.
- Package publishing.
- Custom package creation.
- Order creation.
- Manual payment submission.
- Payment approval.
- Payment rejection.
- Subscription renewal.
- License activation.
- External website registration.
- Tracking event processing.

## 24.3 Critical Business Scenarios

The following must pass before production:

1. A new product can be created without changing application code.
2. Features can be added independently for that product.
3. A package can be created using those features.
4. Multiple prices can be attached to the package.
5. A customer can purchase the package through an external landing page.
6. The order appears in the central Admin Panel.
7. The customer can submit an MFS payment.
8. An authorized administrator can approve or reject the submission.
9. An approved payment can trigger subscription and license issuance.
10. The license can be activated by a compatible external application.
11. Entitlement changes are correctly reflected according to versioning and renewal policy.
12. A new external website can be registered and integrated without creating a separate central database.
13. The same billing engine can support future automated payment gateways.

---

# 25. Development Phases

## Phase 1 — Foundation & Product Catalog

Implement:

- Project foundation.
- Authentication.
- RBAC.
- Admin layout.
- Design system.
- Product management.
- Feature management.
- Package builder.
- Pricing.
- Database migrations.

**Milestone:** A complete product catalog with configurable features, packages, and pricing.

## Phase 2 — Customers & Commerce

Implement:

- Customer management.
- Orders.
- Invoices.
- Manual order creation.
- Custom package builder.
- Order history.
- Financial record structure.

**Milestone:** Admin users can create and manage orders centrally.

## Phase 3 — Manual Payment System

Implement:

- Payment gateway management.
- Manual MFS gateway.
- MFS account configuration.
- Manual bank transfer gateway.
- Bank account configuration.
- Transaction ID configuration.
- Customer payment UI.
- Payment submission.
- Verification queue.
- Approval and rejection.
- Payment history.

**Milestone:** Customers can pay manually through supported MFS and bank-transfer methods, and administrators can verify payments.

## Phase 4 — Subscription & Licensing

Implement:

- Subscription engine.
- Renewal management.
- License generation.
- License activation.
- Entitlement snapshots.
- Signed entitlement responses.
- WordPress integration foundations.
- Dedicated deployment integration foundations.

**Milestone:** A verified order can produce a usable product license.

## Phase 5 — External Integrations

Implement:

- Website registration.
- Domain verification.
- Credential generation.
- Public and private API credentials.
- API documentation.
- Landing Page SDK.
- Server-side SDK.
- Webhook system.

**Milestone:** An independently deployed Astro landing page can use the central product catalog and order system.

## Phase 6 — Tracking & Marketing

Implement:

- Meta Pixel configuration.
- Meta CAPI.
- Event mapping.
- Event deduplication.
- Attribution.
- Tracking logs.
- Retry handling.

**Milestone:** All registered websites can use centralized tracking infrastructure.

## Phase 7 — Production Hardening

Implement:

- Performance optimization.
- Security review.
- Database optimization.
- Backup verification.
- Monitoring.
- Load testing.
- Error reporting.
- Operational documentation.

**Milestone:** Production-ready centralized platform.

---

# 26. Explicit Out-of-Scope Items for Initial Release

The following must not unnecessarily delay the first production release:

- Automated bKash API.
- Automated Nagad API.
- Other automated payment gateway integrations.
- Full customer self-service portal.
- Advanced affiliate management.
- Complex coupon and promotion engine.
- Multi-currency tax automation.
- Advanced usage-based billing.
- Full SaaS deployment orchestration.
- Automated provisioning of dedicated servers.
- Advanced analytics warehouse.
- Multi-region database architecture.

The database and module architecture should remain extensible enough to support these later.

---

# 27. Definition of Done

The initial platform is considered functionally complete when:

- Administrators can create and manage multiple products.
- Every product can have independent feature catalogs.
- Features support Boolean, limit, quota, and metered types.
- Packages can be assembled from product features.
- Multiple prices can be configured for each package.
- Custom packages can be created for individual orders.
- Customer and order management work centrally.
- Manual MFS and bank transfer gateways work.
- Payment submissions can be approved or rejected.
- Subscription records and renewal workflows work.
- Licenses can be generated and validated.
- External websites can register and integrate through credentials and documentation.
- Meta tracking can be centrally configured.
- Sensitive operations are protected by permissions and audit logs.
- The Admin Panel follows the defined minimalistic UI requirements.
- Critical workflows have automated tests.
- Database backup and recovery have been tested.
- The system can be deployed on Cloudflare Workers with Neon PostgreSQL and Cloudflare R2.

---

# 28. Final Architectural Principles

These principles must guide all future implementation decisions.

1. **Centralized Management:** Products, customers, orders, payments, subscriptions, and licenses are managed through one central platform.

2. **Product Independence:** Adding a new product must not require modifying the central business architecture.

3. **API-First:** All external applications communicate through documented and versioned APIs.

4. **Modular Monolith First:** Maintain clean internal boundaries without premature microservices.

5. **PostgreSQL as the Source of Truth:** Financial and licensing state must remain authoritative in PostgreSQL.

6. **Provider Independence:** Database and payment integrations must use replaceable adapters.

7. **Immutable Financial History:** Never overwrite historical payment, order, subscription, or pricing information in a way that destroys the audit trail.

8. **Entitlement-Driven Licensing:** Software access is controlled through explicit feature entitlements, not hardcoded package names.

9. **External Frontend Integration:** Astro landing pages and other product websites remain independently deployable.

10. **Minimal Infrastructure:** Introduce additional Cloudflare services only when they solve a demonstrated technical requirement.

11. **Security by Design:** Never expose privileged credentials or trust unverified client-side payment claims.

12. **Minimalistic UI:** Do not fill the interface with unnecessary descriptions, explanations, or decorative content.

13. **Performance First:** Prioritize efficient rendering, optimized queries, predictable API contracts, and measurable performance.

14. **Extensibility:** New products, payment gateways, distribution channels, and integration types must be addable without rewriting the central platform.

---

**End of PRD — Version 1.0**