/**
 * Transactional Domain Store & Unit of Work.
 * Supports ACID transactions with serialized row-level lock semantics (`withTransaction`),
 * automatic rollback on error, idempotency record enforcement, and Hyperdrive session tracking.
 *
 * TEST-ONLY: StackMateDataStore is the IN-MEMORY implementation of the store
 * contract. It must NEVER be instantiated in production paths — production
 * must use DrizzleStore (apps/api/src/platform/db/drizzle-store.ts), the
 * PostgreSQL-backed subclass with the same public surface. This class is
 * kept for unit tests and for local development without a database.
 * Production wiring (app.ts) is responsible for constructing DrizzleStore
 * from the Hyperdrive connection string and the real R2 bucket binding.
 */
import { randomUUID } from "node:crypto";
import type { R2BucketBinding } from "../../env.ts";
import {
  SEED_CURRENCIES,
  SEED_PAYMENT_PROVIDERS,
  SEED_PERMISSIONS,
  SEED_ROLES,
} from "../../../../../db/seeds/seed-reference.ts";
import {
  type Ed25519KeyMaterial,
  generateEd25519KeyMaterial,
  readEntitlementJwsKid,
  sha256Hex,
  verifyEntitlementJws as verifyEntitlementJwsWithKey,
} from "../crypto/index.ts";
import { InMemoryR2Bucket } from "../storage/r2.ts";
import { AppError } from "../../shared/errors.ts";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  email_verified: boolean;
  password_hash: string;
  // Better Auth two-factor plugin state (migration 0007): the plugin
  // sets this on the first successful TOTP verification. Readers treat
  // a missing value as false only in test fixtures — the DrizzleStore
  // always loads the column.
  two_factor_enabled: boolean;
  status: "active" | "suspended";
  // Custom avatar (audit M-23): R2 object key of the uploaded avatar
  // image, or null for Gravatar/initials. Optional (not required) so
  // existing user constructors keep compiling — readers treat a
  // missing value as null. The column lives in migration 0014
  // (DB agent) + the users SyncSpec; until then the DrizzleStore
  // load/persist ignore it and the in-memory store is the only place
  // it round-trips.
  avatar_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TwoFactorPolicyRecord {
  id: string;
  // `global` = default for every role; otherwise a role key.
  scope: string;
  mode: "off" | "optional" | "required";
  updated_at: string;
}

export interface SessionRecord {
  id: string;
  token: string;
  user_id: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
}

export interface RoleRecord {
  id: string;
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  permission_keys: string[];
  created_at: string;
}

export interface StaffInvitationRecord {
  id: string;
  email: string;
  name: string;
  role_keys: string[];
  token_hash: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  invited_by_user_id: string | null;
  accepted_user_id: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadedAssetRecord {
  id: string;
  object_key: string;
  bucket_name: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  checksum_sha256: string;
  visibility: "private" | "public";
  uploaded_by_user_id: string | null;
  owner_customer_id: string | null;
  created_at: string;
}

/** Media library asset (PLAN §31 / ADR-0011). The `driver` is stored per row — reads always use the row's driver. */
export interface MediaAssetRecord {
  id: string;
  object_key: string;
  driver: "r2" | "local";
  original_filename: string;
  mime_type: string;
  byte_size: number;
  checksum_sha256: string;
  width: number | null;
  height: number | null;
  folder: string;
  tags: string[];
  uploaded_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductRecord {
  id: string;
  code: string;
  slug: string;
  name: string;
  description: string | null;
  product_type: string;
  fulfillment_type: string;
  distribution_channels: string[];
  default_activation_limit: number;
  offline_grace_hours: number;
  status: "draft" | "active" | "archived";
  website_url: string | null;
  documentation_url: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductFeatureRecord {
  id: string;
  product_id: string;
  feature_key: string;
  name: string;
  description: string | null;
  value_type: "boolean" | "limit" | "quota" | "metered";
  unit: string | null;
  default_value: unknown;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export interface ProductPackageRecord {
  id: string;
  product_id: string;
  package_key: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PackageVersionFeatureGrant {
  id: string;
  package_version_id: string;
  product_id: string;
  product_feature_id: string;
  feature_key_snapshot: string;
  value_type_snapshot: "boolean" | "limit" | "quota" | "metered";
  entitlement_value: unknown;
  unit_snapshot: string | null;
}

export interface PackageVersionRecord {
  id: string;
  package_id: string;
  product_id: string;
  version_number: number;
  status: "draft" | "published" | "retired";
  change_summary: string | null;
  features: PackageVersionFeatureGrant[];
  published_at: string | null;
  created_at: string;
}

export interface PackagePriceRecord {
  id: string;
  package_version_id: string;
  price_key: string;
  price_kind: "free" | "one_time" | "recurring" | "lifetime";
  amount_minor: number;
  currency_code: string;
  interval_unit: "day" | "week" | "month" | "year" | null;
  interval_count: number | null;
  trial_days: number;
  setup_fee_minor: number;
  status: "active" | "inactive" | "retired";
  used_in_orders: boolean;
  created_at: string;
}

export interface CustomerRecord {
  id: string;
  customer_number: string;
  customer_type: "person" | "business";
  name: string;
  email: string | null;
  normalized_email: string | null;
  phone: string | null;
  normalized_phone: string | null;
  // Migration 0009: WhatsApp number + overpayment credit balance (minor units).
  whatsapp: string | null;
  credit_balance_minor: number;
  company_name: string | null;
  // Migration 0011: website (ADR-0009 decision 11).
  website: string | null;
  country_code: string;
  status: "active" | "inactive" | "blocked";
  registration_source: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Secondary email/phone of a customer (migration 0009, dedupe — ADR-0009). */
export interface CustomerContactRecord {
  id: string;
  customer_id: string;
  kind: "email" | "phone";
  value: string;
  normalized_value: string;
  created_at: string;
}

/** Billing/shipping address (table since 0000; wired up in 0009). */
export interface CustomerAddressRecord {
  id: string;
  customer_id: string;
  address_type: "billing" | "shipping" | "other";
  contact_name: string | null;
  phone: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state_or_region: string | null;
  postal_code: string | null;
  country_code: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/** Staff report filed on a customer (migration 0009). */
export interface CustomerReportRecord {
  id: string;
  customer_id: string;
  author_user_id: string;
  type: "note" | "concern";
  detail: string;
  created_at: string;
}

/** One installment of an order's payment plan (migration 0009). */
export interface OrderInstallmentRecord {
  id: string;
  order_id: string;
  installment_number: number;
  amount_minor: number;
  /** Calendar date, ISO YYYY-MM-DD. */
  due_date: string;
  status: "pending" | "partially_paid" | "paid" | "overdue";
  paid_amount_minor: number;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItemSnapshotRecord {
  id: string;
  order_item_id: string;
  source_type: "package_version" | "custom_offer" | "complimentary" | "manual_adjustment";
  source_package_version_id: string | null;
  schema_version: number;
  snapshot_hash: string;
  items: Array<{
    feature_key_snapshot: string;
    value_type_snapshot: "boolean" | "limit" | "quota" | "metered";
    entitlement_value: unknown;
    unit_snapshot: string | null;
  }>;
  created_at: string;
}

export interface OrderItemRecord {
  id: string;
  order_id: string;
  product_id: string;
  package_id: string | null;
  package_version_id: string | null;
  package_price_id: string | null;
  item_kind: "package" | "custom" | "one_time_product" | "other";
  fulfillment_type_snapshot: string;
  product_name_snapshot: string;
  package_name_snapshot: string | null;
  package_version_snapshot: number | null;
  price_kind_snapshot: "free" | "one_time" | "recurring" | "lifetime";
  interval_unit_snapshot: "day" | "week" | "month" | "year" | null;
  interval_count_snapshot: number | null;
  activation_limit_snapshot: number;
  quantity: number;
  unit_amount_minor: number;
  line_subtotal_minor: number;
  line_discount_minor: number;
  line_tax_minor: number;
  line_total_minor: number;
  currency_code: string;
  entitlement_snapshot: OrderItemSnapshotRecord;
  created_at: string;
}

export interface OrderRecord {
  id: string;
  order_number: string;
  public_reference: string;
  customer_id: string;
  source: "admin" | "website" | "api" | "import";
  integrated_site_id: string | null;
  status: "draft" | "awaiting_payment" | "processing" | "completed" | "cancelled" | "failed";
  payment_status: "unpaid" | "pending_verification" | "partially_paid" | "paid" | "partially_refunded" | "refunded";
  currency_code: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  customer_note: string | null;
  internal_note: string | null;
  items: OrderItemRecord[];
  // Null-tolerant (ADR-0009 decision 11): the checkout schema accepts
  // JSON null for attribution values; null ≡ absent. Stored as JSON.
  attribution: Record<string, string | null | undefined> | null;
  created_by_user_id: string | null;
  // Migration 0009: license activation policy + renewal grace + payment
  // method + lead link (ADR-0009).
  activation_mode: "on_full_payment" | "on_percent" | "on_date";
  activation_percent: number | null;
  /** Calendar date, ISO YYYY-MM-DD, or null. */
  activation_date: string | null;
  suspend_on_missed_schedule: boolean;
  grace_days: number;
  payment_method_id: string | null;
  lead_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface InvoiceRecord {
  id: string;
  invoice_number: string;
  customer_id: string;
  order_id: string | null;
  subscription_id: string | null;
  invoice_type: "initial" | "renewal" | "adjustment" | "credit_note";
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | "partially_paid";
  currency_code: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  amount_paid_minor: number;
  amount_due_minor: number;
  issued_at: string;
  paid_at: string | null;
  items: Array<{
    id: string;
    description_snapshot: string;
    quantity: number;
    unit_amount_minor: number;
    line_amount_minor: number;
    currency_code: string;
  }>;
  created_at: string;
}

export interface PaymentProviderRecord {
  id: string;
  provider_key: string;
  display_name: string;
  provider_type: "manual_mfs" | "manual_bank" | "automated";
  adapter_key: string;
  status: "enabled" | "disabled";
}

export interface PaymentMethodRecord {
  id: string;
  provider_id: string;
  method_key: string;
  display_name: string;
  method_kind: "mfs_account" | "bank_account" | "automated_checkout";
  account_type: "personal" | "merchant" | "agent" | null;
  account_label: string | null;
  instructions: string | null;
  configuration: {
    account_number: string;
    account_holder_name?: string;
    bank_name?: string;
    branch_name?: string;
    routing_number?: string;
    transaction_id_requirement: "required" | "optional" | "disabled";
  };
  transfer_rails: Array<"npsb" | "beftn" | "rtgs">;
  is_enabled: boolean;
  sort_order: number;
  created_at: string;
}

export interface PaymentSubmissionRecord {
  id: string;
  order_id: string;
  customer_id: string;
  payment_method_id: string;
  installment_id: string | null;
  amount_minor: number;
  currency_code: string;
  sender_name: string | null;
  sender_phone: string | null;
  sender_bank_name: string | null;
  sender_account_reference: string | null;
  transfer_rail_key: string | null;
  transaction_reference: string | null;
  normalized_transaction_reference: string | null;
  payment_date: string | null; // ISO YYYY-MM-DD
  proof_asset_id: string | null;
  duplicate_risk_Warning: boolean;
  status: "submitted" | "under_review" | "approved" | "rejected" | "cancelled";
  customer_note: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
}

export interface PaymentTransactionRecord {
  id: string;
  order_id: string;
  payment_method_id: string | null;
  payment_submission_id: string | null;
  provider_id: string;
  provider_transaction_id: string | null;
  amount_minor: number;
  currency_code: string;
  status: "succeeded" | "pending" | "failed" | "partially_refunded" | "refunded";
  paid_at: string;
  verified_by_user_id: string | null;
  verification_source: "manual_staff" | "provider_webhook" | "provider_query" | "import";
  created_at: string;
}

export interface PaymentVerificationLogRecord {
  id: string;
  payment_submission_id: string;
  actor_user_id: string;
  decision: "approved" | "rejected" | "requested_information" | "reopened";
  reason_code: string | null;
  customer_message: string | null;
  notes: string | null;
  created_at: string;
}

// F-03: manual refunds (DB spec §13.8, table `payment_refunds` since
// migration 0000). The payments service previously defined this record
// locally and failed closed without the collection; it lives here now
// so the store can load/persist it. (The service's local definition
// should be replaced by an import + re-export from here — domain
// agent's file, not this one.)
export interface PaymentRefundRecord {
  id: string;
  payment_transaction_id: string;
  amount_minor: number;
  currency_code: string;
  status: "requested" | "pending" | "succeeded" | "failed" | "cancelled";
  reason: string;
  provider_refund_id: string | null;
  requested_by_user_id: string | null;
  processed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionPeriodRecord {
  id: string;
  subscription_id: string;
  period_number: number;
  period_start: string;
  period_end: string;
  status: "pending" | "active" | "completed" | "void" | "failed";
  renewal_order_id: string | null;
  invoice_id: string | null;
  payment_transaction_id: string | null;
  activated_at: string | null;
  created_at: string;
}

export interface SubscriptionRecord {
  id: string;
  subscription_number: string;
  customer_id: string;
  product_id: string;
  source_order_item_id: string | null;
  source_package_version_id: string | null;
  status: "trialing" | "pending" | "active" | "past_due" | "paused" | "cancelled" | "expired";
  billing_kind: "one_time" | "recurring" | "lifetime" | "custom";
  interval_unit: "day" | "week" | "month" | "year" | null;
  interval_count: number | null;
  currency_code: string;
  unit_amount_minor: number;
  // Migration 0009: renewal grace in days (ADR-0009).
  grace_days: number;
  current_period_start: string | null;
  current_period_end: string | null;
  next_renewal_at: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  periods: SubscriptionPeriodRecord[];
  created_at: string;
  updated_at: string;
}

export interface LicenseEntitlementSnapshotRecord {
  id: string;
  license_id: string;
  version_number: number;
  source_type: "order_item" | "subscription_period" | "manual_grant" | "admin_adjustment";
  effective_at: string;
  reason: string | null;
  snapshot_hash: string;
  items: Array<{
    feature_key_snapshot: string;
    value_type_snapshot: "boolean" | "limit" | "quota" | "metered";
    entitlement_value: unknown;
    unit_snapshot: string | null;
  }>;
  created_by_user_id: string | null;
  created_at: string;
}

export interface LicenseActivationRecord {
  id: string;
  license_id: string;
  installation_id_hash: string;
  domain_normalized: string | null;
  environment: "production" | "staging" | "development" | "other";
  status: "active" | "deactivated" | "blocked";
  activated_at: string;
  last_seen_at: string;
  deactivated_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface LicenseRecord {
  id: string;
  license_number: string;
  product_id: string;
  customer_id: string;
  source_order_item_id: string | null;
  subscription_id: string | null;
  license_key_hash: string;
  license_key_hint: string;
  issued_raw_key_once?: string; // Available only in issuance transaction response, never persisted in DB table
  status: "pending" | "active" | "expired" | "suspended" | "revoked";
  activation_limit: number;
  valid_from: string;
  expires_at: string | null;
  grace_until: string | null;
  current_entitlement_snapshot_id: string;
  snapshots: LicenseEntitlementSnapshotRecord[];
  activations: LicenseActivationRecord[];
  issued_at: string;
  created_at: string;
  updated_at: string;
}

export interface IntegratedSiteRecord {
  id: string;
  site_key: string;
  name: string;
  environment: "production" | "staging" | "development";
  status: "pending_verification" | "active" | "suspended" | "revoked";
  api_version: string;
  allowed_capabilities: string[];
  product_ids: string[];
  domains: Array<{
    id: string;
    domain: string;
    verification_method: "dns_txt" | "http_file" | "manual_review";
    verification_challenge: string;
    verification_status: "pending" | "verified" | "failed";
    verified_at: string | null;
    is_primary: boolean;
  }>;
  created_at: string;
  updated_at: string;
}

export interface SiteCredentialRecord {
  id: string;
  integrated_site_id: string;
  key_id: string;
  credential_type: "public_key" | "bearer_secret" | "hmac_shared_secret" | "public_signing_key";
  secret_hash: string | null;
  secret_ciphertext: string | null;
  encryption_key_version: string | null;
  scopes: string[];
  status: "active" | "rotated" | "revoked" | "expired";
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface TrackingConfigRecord {
  id: string;
  integrated_site_id: string;
  provider: "meta" | "tiktok";
  // Human group label (migration 0006). NULL for groups created before
  // the label existed — the UI falls back to the pixel ID.
  label: string | null;
  pixel_id: string;
  access_token_ciphertext: string;
  encryption_key_version: string;
  test_event_code: string | null;
  enabled_events: string[];
  status: "enabled" | "disabled";
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
}

export interface TrackingEventRecord {
  id: string;
  integrated_site_id: string;
  event_name: string;
  event_id: string;
  event_time: string;
  event_source_url: string | null;
  order_id: string | null;
  consent_state: "granted" | "denied";
  consent_policy_version: string;
  sanitized_payload: Record<string, unknown>;
  // C-2/D-6: "simulated" — the event was recorded but never sent to
  // any receiver (no transport configured / Meta CAPI stub). It must
  // never be mistaken for "processed"/"delivered".
  status: "received" | "queued" | "processed" | "rejected" | "simulated";
  delivery_attempts: number;
  delivered_at: string | null;
  created_at: string;
}

export interface WebhookEndpointRecord {
  id: string;
  integrated_site_id: string | null;
  url: string;
  description: string;
  subscribed_events: string[];
  status: "active" | "disabled" | "revoked";
  secret_key_id: string;
  secret_ciphertext: string;
  key_version: string;
  created_at: string;
}

export interface OutboxEventRecord {
  id: string;
  event_key: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  // C-2/D-6: "simulated" — the outbox row was recorded but never
  // delivered to any receiver (no transport configured). It must
  // never be mistaken for "delivered".
  status: "pending" | "processing" | "delivered" | "dead_letter" | "simulated";
  attempt_count: number;
  available_at: string;
  locked_until: string | null;
  locked_by: string | null;
  last_error_code: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface IdempotencyRecord {
  id: string;
  scope_key: string;
  idempotency_key: string;
  request_hash: string;
  status: "processing" | "completed" | "failed";
  response_status: number;
  response_body: unknown;
  expires_at: string;
  created_at: string;
}

export interface AuditLogRecord {
  id: string;
  actor_type: "staff" | "system" | "integration";
  actor_user_id: string | null;
  integrated_site_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: "success" | "denied" | "failed";
  request_id: string;
  changes: Record<string, unknown>;
  created_at: string;
}

/** License lifecycle event (table since 0000; wired up in 0009 — ADR-0009). */
export interface LicenseEventRecord {
  id: string;
  license_id: string;
  event_type: string;
  actor_type: "system" | "staff" | "client";
  actor_user_id: string | null;
  activation_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Reminder rules singleton (migration 0009; load-only in state). */
export interface ReminderSettingsRecord {
  id: string;
  due_offsets_days: number[];
  overdue_offsets_days: number[];
  overdue_enabled: boolean;
  updated_at: string;
}

/** One reminder actually sent (migration 0009; sweep idempotency). */
export interface SentReminderRecord {
  id: string;
  kind: SentReminderKind;
  reference_id: string;
  offset_days: number;
  sent_at: string;
}

export type SentReminderKind =
  | "installment_due"
  | "installment_overdue"
  | "subscription_renewal"
  | "subscription_overdue";

/** Support ticket (migration 0009). */
export interface SupportTicketRecord {
  id: string;
  ticket_number: string;
  customer_id: string | null;
  order_id: string | null;
  subscription_id: string | null;
  license_id: string | null;
  product_id: string | null;
  title: string;
  description: string;
  status: "open" | "in_progress" | "waiting_on_customer" | "resolved" | "closed";
  priority: "low" | "medium" | "high" | "urgent";
  category: "billing" | "technical" | "license" | "order" | "other";
  reporter_user_id: string;
  source_note: string | null;
  assignee_user_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
}

export interface TicketCommentRecord {
  id: string;
  ticket_id: string;
  author_user_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
}

/** Lead (migration 0009). */
export interface LeadRecord {
  id: string;
  lead_number: string;
  name: string;
  email: string | null;
  normalized_email: string | null;
  phone: string | null;
  normalized_phone: string | null;
  whatsapp: string | null;
  source_site_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  interest: string | null;
  product_id: string | null;
  message: string | null;
  notes: string | null;
  status: "new" | "contacted" | "qualified" | "converted" | "lost";
  assignee_user_id: string | null;
  created_at: string;
  updated_at: string;
  converted_at: string | null;
  converted_customer_id: string | null;
  converted_order_id: string | null;
}

export interface DatabaseState {
  users: UserRecord[];
  sessions: SessionRecord[];
  roles: RoleRecord[];
  staff_invitations: StaffInvitationRecord[];
  user_roles: Array<{ user_id: string; role_id: string; assigned_at: string }>;
  uploaded_assets: UploadedAssetRecord[];
  media_assets: MediaAssetRecord[];
  products: ProductRecord[];
  product_features: ProductFeatureRecord[];
  product_packages: ProductPackageRecord[];
  package_versions: PackageVersionRecord[];
  package_prices: PackagePriceRecord[];
  customers: CustomerRecord[];
  customer_contacts: CustomerContactRecord[];
  customer_addresses: CustomerAddressRecord[];
  customer_reports: CustomerReportRecord[];
  orders: OrderRecord[];
  order_installments: OrderInstallmentRecord[];
  invoices: InvoiceRecord[];
  payment_providers: PaymentProviderRecord[];
  payment_methods: PaymentMethodRecord[];
  payment_submissions: PaymentSubmissionRecord[];
  payment_transactions: PaymentTransactionRecord[];
  payment_verification_logs: PaymentVerificationLogRecord[];
  payment_refunds: PaymentRefundRecord[];
  subscriptions: SubscriptionRecord[];
  licenses: LicenseRecord[];
  license_events: LicenseEventRecord[];
  reminder_settings: ReminderSettingsRecord[];
  sent_reminders: SentReminderRecord[];
  support_tickets: SupportTicketRecord[];
  ticket_comments: TicketCommentRecord[];
  leads: LeadRecord[];
  integrated_sites: IntegratedSiteRecord[];
  site_credentials: SiteCredentialRecord[];
  request_nonces: Array<{ credential_id: string; nonce: string; expires_at: string }>;
  tracking_configurations: TrackingConfigRecord[];
  tracking_events: TrackingEventRecord[];
  webhook_endpoints: WebhookEndpointRecord[];
  webhook_deliveries: Array<{
    id: string;
    webhook_endpoint_id: string;
    event_id: string;
    delivery_id: string;
    // C-2/D-6: "simulated" — the delivery was recorded but never sent
    // to any receiver (no transport configured). Never "delivered".
    status: "pending" | "delivered" | "retrying" | "failed" | "simulated";
    attempt_count: number;
    last_http_status: number | null;
    delivered_at: string | null;
  }>;
  outbox_events: OutboxEventRecord[];
  idempotency_records: IdempotencyRecord[];
  audit_logs: AuditLogRecord[];
  // 2FA policy rows (migration 0007). Loaded read-only in the combined
  // state query; written ONLY through the auth-config service's direct
  // Drizzle calls (never via withTransaction — there is no SyncSpec for
  // this collection, so persistStateDiff ignores it).
  two_factor_policy: TwoFactorPolicyRecord[];
  sequence_counters: {
    customer: number;
    order: number;
    invoice: number;
    subscription: number;
    license: number;
    ticket: number;
    lead: number;
  };
}

export class StackMateDataStore {
  public state: DatabaseState;
  /**
   * Object-storage bucket for private payment evidence. Typed as the
   * R2BucketBinding interface (not the in-memory implementation) so a real
   * Cloudflare R2 binding can be substituted by DrizzleStore in production.
   * The base class still constructs an InMemoryR2Bucket by default — see
   * DrizzleStore.usesInMemoryBucket / requireRealBucket().
   */
  public r2Bucket: R2BucketBinding;
  public readonly signingKeys: Map<string, Ed25519KeyMaterial>;
  public activeSigningKeyId: string;
  private txMutex: Promise<void> = Promise.resolve();
  /**
   * C-1 rate-limit buckets (in-memory implementation). The base store
   * keeps them per instance; DrizzleStore overrides checkRateLimit /
   * resetRateLimit with DB-backed buckets (table rate_limit_buckets)
   * and falls back to this map only when the table is missing.
   */
  private rateLimitBuckets = new Map<string, { count: number; resetAtMs: number }>();
  public queryMetrics = {
    uncachedQueries: 0,
    cachedQueries: 0,
    transactionsCommitted: 0,
    transactionsRolledBack: 0,
  };

  constructor(initialSigningKeyId = "sm-ed25519-2026-11") {
    this.r2Bucket = new InMemoryR2Bucket();
    this.signingKeys = new Map();
    const keyMat = generateEd25519KeyMaterial(initialSigningKeyId);
    this.signingKeys.set(initialSigningKeyId, keyMat);
    this.activeSigningKeyId = initialSigningKeyId;

    this.state = {
      users: [],
      sessions: [],
      roles: SEED_ROLES.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        is_system: r.is_system,
        permission_keys: [...r.permissions],
        created_at: new Date().toISOString(),
      })),
      user_roles: [],
      staff_invitations: [],
      uploaded_assets: [],
      media_assets: [],
      products: [],
      product_features: [],
      product_packages: [],
      package_versions: [],
      package_prices: [],
      customers: [],
      customer_contacts: [],
      customer_addresses: [],
      customer_reports: [],
      orders: [],
      order_installments: [],
      invoices: [],
      payment_providers: SEED_PAYMENT_PROVIDERS.map((p) => ({ ...p })),
      payment_methods: [],
      payment_submissions: [],
      payment_transactions: [],
      payment_verification_logs: [],
      payment_refunds: [],
      subscriptions: [],
      licenses: [],
      license_events: [],
      reminder_settings: [],
      sent_reminders: [],
      support_tickets: [],
      ticket_comments: [],
      leads: [],
      integrated_sites: [],
      site_credentials: [],
      request_nonces: [],
      tracking_configurations: [],
      tracking_events: [],
      webhook_endpoints: [],
      webhook_deliveries: [],
      outbox_events: [],
      idempotency_records: [],
      audit_logs: [],
      two_factor_policy: [],
      sequence_counters: {
        customer: 1000,
        order: 10000,
        invoice: 20000,
        subscription: 30000,
        license: 40000,
        ticket: 50000,
        lead: 60000,
      },
    };
  }

  public get allPermissions() {
    return SEED_PERMISSIONS;
  }

  public get allCurrencies() {
    return SEED_CURRENCIES;
  }

  public getActiveSigningKey(): Ed25519KeyMaterial {
    const k = this.signingKeys.get(this.activeSigningKeyId);
    if (!k) throw new Error("Active Ed25519 signing key not found.");
    return k;
  }

  /**
   * Public JWKs of every key this store will verify with — active first,
   * then retired keys by key id. Revoked keys are NOT in `signingKeys`
   * (DrizzleStore never loads them; the in-memory store deletes them on
   * revoke), so they never appear here. This is what
   * GET /api/v1/licenses/signing-keys publishes.
   */
  public listPublicSigningKeys(): Array<Record<string, unknown>> {
    const keys = [...this.signingKeys.values()];
    keys.sort((a, b) => {
      if (a.keyId === this.activeSigningKeyId && b.keyId !== this.activeSigningKeyId) return -1;
      if (b.keyId === this.activeSigningKeyId && a.keyId !== this.activeSigningKeyId) return 1;
      return a.keyId.localeCompare(b.keyId);
    });
    return keys.map((k) => k.publicKeyJwk);
  }

  /**
   * Verify an entitlement JWS against the key its header `kid` names.
   * Retired keys still verify (they stay in `signingKeys`); revoked or
   * unknown kids throw LICENSE_INVALID because no such key is loaded.
   * Expiry / issuer / product checks are the same as verifyEntitlementJws.
   */
  public verifyEntitlementJws(
    jwsToken: string,
    options?: Parameters<typeof verifyEntitlementJwsWithKey>[2]
  ): ReturnType<typeof verifyEntitlementJwsWithKey> {
    const kid = readEntitlementJwsKid(jwsToken);
    const material = this.signingKeys.get(kid);
    if (!material) {
      throw new AppError(
        "LICENSE_INVALID",
        `Entitlement JWS was signed with unknown or revoked key '${kid}'.`,
        401
      );
    }
    return verifyEntitlementJwsWithKey(jwsToken, material.publicKeyJwk, options);
  }

  /**
   * Rotate the active signing key (IN-MEMORY ONLY in this base class:
   * the new key is generated, kept in `signingKeys`, and made active;
   * the old key stays loaded so its tokens keep verifying).
   * DrizzleStore overrides this with the durable version, which persists
   * the new key encrypted in signing_keys and retires the old row in the
   * same transaction. Async so the override can do database work.
   */
  public async rotateSigningKey(newKeyId: string): Promise<Ed25519KeyMaterial> {
    if (this.signingKeys.has(newKeyId)) {
      throw new AppError("CONFLICT", `Signing key ID '${newKeyId}' already exists.`, 409);
    }
    const nextKey = generateEd25519KeyMaterial(newKeyId);
    this.signingKeys.set(newKeyId, nextKey);
    this.activeSigningKeyId = newKeyId;
    return nextKey;
  }

  /**
   * Revoke a NON-ACTIVE signing key (IN-MEMORY ONLY in this base class:
   * the key is dropped from `signingKeys`, so its tokens stop verifying
   * and its public JWK leaves listPublicSigningKeys()).
   * DrizzleStore overrides this with the durable version, which marks
   * the row 'revoked' in signing_keys and syncs signing_key_metadata.
   * The active key can never be revoked — rotate first, then revoke the
   * retired key — so there is always exactly one active key.
   */
  public async revokeSigningKey(keyId: string): Promise<void> {
    if (keyId === this.activeSigningKeyId) {
      throw new AppError(
        "CONFLICT",
        `Cannot revoke the active signing key '${keyId}': rotate to a new key first, then revoke the retired key.`,
        409
      );
    }
    if (!this.signingKeys.has(keyId)) {
      throw new AppError("NOT_FOUND", `Signing key '${keyId}' not found.`, 404);
    }
    this.signingKeys.delete(keyId);
  }

  /**
   * Executes an atomic, serialized transaction with snapshot rollback on error.
   * Simulates PostgreSQL transaction isolation & row-level `SELECT ... FOR UPDATE` locking.
   */
  public async withTransaction<T>(fn: (state: DatabaseState) => Promise<T> | T): Promise<T> {
    let releaseLock!: () => void;
    const prevMutex = this.txMutex;
    this.txMutex = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await prevMutex;
    this.queryMetrics.uncachedQueries += 1;
    const snapshotJson = JSON.stringify(this.state);
    try {
      const result = await fn(this.state);
      this.queryMetrics.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.state = JSON.parse(snapshotJson) as DatabaseState;
      this.queryMetrics.transactionsRolledBack += 1;
      throw error;
    } finally {
      releaseLock();
    }
  }

  /**
   * C-1: rate limiting. Atomically increments the bucket for
   * `bucketKey` and throws 429 RATE_LIMIT_EXCEEDED once the count
   * passes `maxRequests` inside the `windowMs` window. A bucket with
   * an expired window restarts at 1. Callers count only the events
   * that should trip the limit (e.g. failed sign-ins for the lockout
   * bucket) and call resetRateLimit on the success path.
   *
   * The base (in-memory) implementation is per store instance — it is
   * the test adapter and the fallback when the DB table is missing.
   * DrizzleStore overrides this with a single-statement Postgres
   * upsert on `rate_limit_buckets`, which is what makes the limit
   * survive across requests on Workers (the pre-fix in-app Map was
   * recreated on every fetch() and never tripped).
   */
  public async checkRateLimit(
    bucketKey: string,
    maxRequests: number,
    windowMs = 60_000
  ): Promise<void> {
    const now = Date.now();
    const entry = this.rateLimitBuckets.get(bucketKey);
    if (!entry || now >= entry.resetAtMs) {
      this.rateLimitBuckets.set(bucketKey, { count: 1, resetAtMs: now + windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > maxRequests) {
      throw new AppError(
        "RATE_LIMIT_EXCEEDED",
        "Too many requests. Please retry after the rate-limit window resets.",
        429
      );
    }
  }

  /**
   * C-1: clears one rate-limit bucket (e.g. a successful sign-in
   * clears the per-account failure bucket, so typos never lock a
   * legitimate user out).
   */
  public async resetRateLimit(bucketKey: string): Promise<void> {
    this.rateLimitBuckets.delete(bucketKey);
  }

  /**
   * C-1: non-incrementing lockout probe — true when the bucket is
   * already at/over `maxRequests` inside its window. Lets a caller
   * refuse a locked account BEFORE doing expensive work (e.g. a
   * bcrypt check on sign-in) without counting the refused attempt.
   */
  public async isRateLimited(
    bucketKey: string,
    maxRequests: number,
    windowMs = 60_000
  ): Promise<boolean> {
    const entry = this.rateLimitBuckets.get(bucketKey);
    if (!entry) return false;
    if (Date.now() >= entry.resetAtMs) return false;
    return entry.count >= maxRequests;
  }

  /**
   * M-23: sets (or clears, with null) a staff user's custom avatar.
   * The value is the storage object key; serving is the
   * GET /api/v1/admin/me/avatar route. Runs inside a transaction so a
   * DrizzleStore persists it with the next diff once the DB agent
   * adds avatar_url to the users SyncSpec.
   */
  public async setStaffAvatarUrl(
    userId: string,
    avatarUrl: string | null
  ): Promise<{ user_id: string; avatar_url: string | null }> {
    return this.withTransaction((state) => {
      const user = state.users.find((u) => u.id === userId);
      if (!user) throw new AppError("NOT_FOUND", "Staff user not found.", 404);
      user.avatar_url = avatarUrl;
      user.updated_at = new Date().toISOString();
      return { user_id: user.id, avatar_url: user.avatar_url ?? null };
    });
  }

  /**
   * Executes a deterministic idempotent command (Database Design §18.5, API Spec §20).
   */
  public async executeIdempotent<T>(
    scopeKey: string,
    idempotencyKey: string,
    requestPayload: unknown,
    statusCode: number,
    fn: (state: DatabaseState) => Promise<T> | T
  ): Promise<{ status: number; body: T; replayed: boolean }> {
    const trimmedKey = idempotencyKey.trim();
    if (trimmedKey.length < 8 || trimmedKey.length > 128) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Idempotency-Key header must be between 8 and 128 characters.",
        400
      );
    }
    const requestHash = sha256Hex(JSON.stringify(requestPayload ?? {}));

    return this.withTransaction(async (state) => {
      const existing = state.idempotency_records.find(
        (r) => r.scope_key === scopeKey && r.idempotency_key === trimmedKey
      );
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new AppError(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency-Key was already used with a different request payload.",
            409
          );
        }
        if (existing.status === "processing") {
          throw new AppError(
            "IDEMPOTENCY_IN_PROGRESS",
            "A request with this Idempotency-Key is currently processing.",
            409
          );
        }
        return {
          status: existing.response_status,
          body: existing.response_body as T,
          replayed: true,
        };
      }

      const body = await fn(state);
      state.idempotency_records.push({
        id: randomUUID(),
        scope_key: scopeKey,
        idempotency_key: trimmedKey,
        request_hash: requestHash,
        status: "completed",
        response_status: statusCode,
        response_body: body,
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      });

      return { status: statusCode, body, replayed: false };
    });
  }
}
