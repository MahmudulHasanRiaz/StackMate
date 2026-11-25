/**
 * GraphQL schema — admin complex reads ONLY (Hono migration, Phase 2).
 *
 * Additive: every REST read endpoint stays. Queries only in v1; all
 * mutations stay REST. Resolvers call the SAME service helpers and the
 * SAME Drizzle store reads as the REST handlers in `../app.ts` — no
 * second data layer.
 *
 * Three query roots, mirroring the three REST shapes:
 *   - customerDetail  <-> GET /api/v1/admin/customers/:id
 *   - orderDetail     <-> GET /api/v1/admin/orders/:id
 *   - dashboardKpis   <-> GET /api/v1/admin/analytics/overview
 *
 * Security notes:
 *   - License rows NEVER expose `license_key_hash` / `issued_raw_key_once`
 *     (the REST overview panels strip them too; the customer/order REST
 *     detail spreads the full row — GraphQL is stricter by design).
 *   - Revenue / order-count KPIs are null (not 0) when the caller lacks
 *     `payments.read`, exactly like the REST overview (M-8 / F-02).
 */
export const typeDefs = /* GraphQL */ `
  """Arbitrary JSON (attribution, entitlement snapshots, periods)."""
  scalar JSON
  type Query {
    """Customer + financials + orders + payments (REST: GET /admin/customers/:id)."""
    customerDetail(id: ID!): CustomerDetail
    """Order + items + licenses + payments (REST: GET /admin/orders/:id)."""
    orderDetail(id: ID!): OrderDetail
    """Dashboard KPIs (REST: GET /admin/analytics/overview)."""
    dashboardKpis(from: String, to: String): DashboardKpis
  }
  # ------------------------------------------------------------------
  # Shared scalar shapes
  # ------------------------------------------------------------------
  type Customer {
    id: ID!
    customer_number: String!
    customer_type: String!
    name: String!
    email: String
    normalized_email: String
    phone: String
    normalized_phone: String
    whatsapp: String
    credit_balance_minor: Int!
    company_name: String
    website: String
    country_code: String!
    status: String!
    registration_source: String!
    notes: String
    created_at: String!
    updated_at: String!
  }
  type CustomerFinancials {
    total_billed_minor: Int!
    total_paid_minor: Int!
    total_due_minor: Int!
    credit_balance_minor: Int!
  }
  type CustomerContact {
    id: ID!
    customer_id: ID!
    kind: String!
    value: String!
    normalized_value: String!
    created_at: String!
  }
  type CustomerAddress {
    id: ID!
    customer_id: ID!
    label: String
    line1: String!
    line2: String
    city: String!
    state: String
    postal_code: String
    country_code: String!
    is_default: Boolean!
    created_at: String!
    updated_at: String!
  }
  type CustomerReport {
    id: ID!
    customer_id: ID!
    author_user_id: ID!
    author_name: String
    type: String!
    detail: String!
    created_at: String!
  }
  type Subscription {
    id: ID!
    subscription_number: String!
    customer_id: ID!
    product_id: ID!
    source_order_item_id: ID
    source_package_version_id: ID
    status: String!
    billing_kind: String!
    interval_unit: String
    interval_count: Int
    currency_code: String!
    unit_amount_minor: Int!
    grace_days: Int!
    current_period_start: String
    current_period_end: String
    next_renewal_at: String
    cancel_at_period_end: Boolean!
    cancelled_at: String
    periods: JSON
    created_at: String!
    updated_at: String!
  }
  type LicenseEntitlementItem {
    feature_key_snapshot: String!
    value_type_snapshot: String!
    entitlement_value: JSON
    unit_snapshot: String
  }
  type LicenseEntitlementSnapshot {
    id: ID!
    license_id: ID!
    version_number: Int!
    source_type: String!
    effective_at: String!
    reason: String
    snapshot_hash: String!
    items: [LicenseEntitlementItem!]!
    created_by_user_id: ID
    created_at: String!
  }
  type LicenseActivation {
    id: ID!
    license_id: ID!
    installation_id_hash: String!
    domain_normalized: String
    environment: String!
    status: String!
    activated_at: String!
    last_seen_at: String!
    deactivated_at: String
    metadata: JSON
    created_at: String!
  }
  """License WITHOUT any key material (no license_key_hash, no raw key)."""
  type License {
    id: ID!
    license_number: String!
    product_id: ID!
    customer_id: ID!
    source_order_item_id: ID
    subscription_id: ID
    license_key_hint: String!
    status: String!
    activation_limit: Int!
    valid_from: String!
    expires_at: String
    grace_until: String
    current_entitlement_snapshot_id: ID!
    snapshots: [LicenseEntitlementSnapshot!]!
    activations: [LicenseActivation!]!
    issued_at: String!
    created_at: String!
    updated_at: String!
  }
  type LicenseInstallation {
    id: ID!
    license_id: ID!
    installation_id_hash: String!
    domain_normalized: String
    environment: String!
    status: String!
    activated_at: String!
    last_seen_at: String!
    deactivated_at: String
    metadata: JSON
    created_at: String!
    license_number: String!
    product_id: ID!
  }
  type SupportTicket {
    id: ID!
    ticket_number: String!
    customer_id: ID
    order_id: ID
    subscription_id: ID
    license_id: ID
    product_id: ID
    title: String!
    description: String!
    status: String!
    priority: String!
    category: String!
    reporter_user_id: ID!
    source_note: String
    assignee_user_id: ID
    created_at: String!
    updated_at: String!
    resolved_at: String
    closed_at: String
  }
  type PaymentSubmission {
    id: ID!
    order_id: ID!
    customer_id: ID!
    payment_method_id: ID!
    installment_id: ID
    amount_minor: Int!
    currency_code: String!
    sender_name: String
    sender_phone: String
    sender_bank_name: String
    sender_account_reference: String
    transfer_rail_key: String
    transaction_reference: String
    normalized_transaction_reference: String
    payment_date: String
    proof_asset_id: ID
    duplicate_risk_Warning: Boolean!
    status: String!
    customer_note: String
    submitted_at: String!
    reviewed_at: String
    reviewed_by_user_id: ID
  }
  type PaymentTransaction {
    id: ID!
    order_id: ID!
    payment_method_id: ID
    payment_submission_id: ID
    provider_id: ID!
    provider_transaction_id: String
    amount_minor: Int!
    currency_code: String!
    status: String!
    paid_at: String!
    verified_by_user_id: ID
    verification_source: String!
    created_at: String!
  }
  type Payments {
    submissions: [PaymentSubmission!]!
    transactions: [PaymentTransaction!]!
  }
  type OrderItem {
    id: ID!
    order_id: ID!
    product_id: ID!
    package_id: ID
    package_version_id: ID
    package_price_id: ID
    item_kind: String!
    fulfillment_type_snapshot: String!
    product_name_snapshot: String!
    package_name_snapshot: String
    package_version_snapshot: Int
    price_kind_snapshot: String!
    interval_unit_snapshot: String
    interval_count_snapshot: Int
    activation_limit_snapshot: Int!
    quantity: Int!
    unit_amount_minor: Int!
    line_subtotal_minor: Int!
    line_discount_minor: Int!
    line_tax_minor: Int!
    line_total_minor: Int!
    currency_code: String!
    entitlement_snapshot: JSON
    created_at: String!
  }
  type OrderInstallment {
    id: ID!
    order_id: ID!
    installment_number: Int!
    amount_minor: Int!
    due_date: String!
    due_date_display: String!
    status: String!
    paid_amount_minor: Int!
    paid_at: String
    notes: String
    created_at: String!
    updated_at: String!
  }
  type Invoice {
    id: ID!
    invoice_number: String!
    customer_id: ID!
    order_id: ID
    subscription_id: ID
    invoice_type: String!
    status: String!
    currency_code: String!
    subtotal_minor: Int!
    discount_minor: Int!
    tax_minor: Int!
    total_minor: Int!
    amount_paid_minor: Int!
    amount_due_minor: Int!
    issued_at: String!
    paid_at: String
    items: JSON
    created_at: String!
  }
  # ------------------------------------------------------------------
  # customerDetail
  # ------------------------------------------------------------------
  """One order row of a customer, with its own billed/paid/due (REST parity)."""
  type CustomerOrder {
    id: ID!
    order_number: String!
    public_reference: String!
    customer_id: ID!
    source: String!
    integrated_site_id: ID
    status: String!
    payment_status: String!
    currency_code: String!
    subtotal_minor: Int!
    discount_minor: Int!
    tax_minor: Int!
    total_minor: Int!
    customer_note: String
    internal_note: String
    items: [OrderItem!]!
    attribution: JSON
    created_by_user_id: ID
    activation_mode: String!
    activation_percent: Int
    activation_date: String
    suspend_on_missed_schedule: Boolean!
    grace_days: Int!
    payment_method_id: ID
    lead_id: ID
    created_at: String!
    updated_at: String!
    completed_at: String
    cancelled_at: String
    paid_amount_minor: Int!
    remaining_minor: Int!
  }
  type CustomerDetail {
    id: ID!
    customer_number: String!
    customer_type: String!
    name: String!
    email: String
    normalized_email: String
    phone: String
    normalized_phone: String
    whatsapp: String
    credit_balance_minor: Int!
    company_name: String
    website: String
    country_code: String!
    status: String!
    registration_source: String!
    notes: String
    created_at: String!
    updated_at: String!
    financials: CustomerFinancials!
    contacts: [CustomerContact!]!
    addresses: [CustomerAddress!]!
    reports: [CustomerReport!]!
    orders: [CustomerOrder!]!
    subscriptions: [Subscription!]!
    licenses: [License!]!
    payments: Payments!
    installations: [LicenseInstallation!]!
    tickets: [SupportTicket!]!
  }
  # ------------------------------------------------------------------
  # orderDetail
  # ------------------------------------------------------------------
  type OrderDetail {
    id: ID!
    order_number: String!
    public_reference: String!
    customer_id: ID!
    source: String!
    integrated_site_id: ID
    status: String!
    payment_status: String!
    currency_code: String!
    subtotal_minor: Int!
    discount_minor: Int!
    tax_minor: Int!
    total_minor: Int!
    customer_note: String
    internal_note: String
    items: [OrderItem!]!
    attribution: JSON
    created_by_user_id: ID
    activation_mode: String!
    activation_percent: Int
    activation_date: String
    suspend_on_missed_schedule: Boolean!
    grace_days: Int!
    payment_method_id: ID
    lead_id: ID
    created_at: String!
    updated_at: String!
    completed_at: String
    cancelled_at: String
    entitlement_snapshot: JSON
    site_name: String
    customer: Customer
    paid_amount_minor: Int!
    remaining_minor: Int!
    installments: [OrderInstallment!]!
    invoices: [Invoice!]!
    licenses: [License!]!
    payments: Payments!
    payment_submissions: [PaymentSubmission!]!
  }
  # ------------------------------------------------------------------
  # dashboardKpis
  # ------------------------------------------------------------------
  type OverviewRange {
    from: String!
    to: String!
  }
  type DashboardOrderRow {
    id: ID!
    order_number: String!
    public_reference: String!
    customer_id: ID!
    source: String!
    status: String!
    payment_status: String!
    currency_code: String!
    total_minor: Int!
    created_at: String!
    customer: Customer
    paid_amount_minor: Int!
    remaining_minor: Int!
    created_date_display: String!
  }
  type DashboardPendingSubmissionRow {
    id: ID!
    order_id: ID!
    customer_id: ID!
    amount_minor: Int!
    currency_code: String!
    status: String!
    submitted_at: String!
    customer: Customer
    order_number: String
  }
  type DashboardExpiringLicenseRow {
    id: ID!
    license_number: String!
    product_id: ID!
    customer_id: ID!
    status: String!
    expires_at: String
    customer_name: String
    product_code: String
    product_name: String
    active_activations_count: Int!
    expires_date_display: String!
  }
  type DashboardPanels {
    recent_orders: [DashboardOrderRow!]!
    pending_submissions: [DashboardPendingSubmissionRow!]!
    expiring_licenses: [DashboardExpiringLicenseRow!]!
  }
  type DashboardKpis {
    currency_code: String!
    total_products: Int!
    active_products: Int!
    total_customers: Int!
    total_orders: Int
    paid_orders: Int
    pending_payment_submissions: Int
    upcoming_renewals: Int!
    panels: DashboardPanels!
    active_subscriptions: Int!
    active_licenses: Int!
    expired_or_revoked_licenses: Int!
    verified_revenue_minor: Int
    pending_outbox_events: Int!
    range: OverviewRange
  }
`;
