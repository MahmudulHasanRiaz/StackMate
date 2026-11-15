-- StackMate Migration 0000: Initial Authoritative PostgreSQL Schema
-- Generated for Drizzle ORM + PostgreSQL (Neon / Cloudflare Hyperdrive compatible)
-- Enforces relational invariants, composite foreign keys for product isolation,
-- integer minor-unit money checks, and immutability triggers for commercial history.

CREATE TABLE IF NOT EXISTS "users" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" varchar(320) NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "password" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "verifications" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "staff_profiles" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "display_name" text,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'suspended')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "roles" (
  "id" uuid PRIMARY KEY NOT NULL,
  "key" varchar(80) NOT NULL UNIQUE,
  "name" varchar(120) NOT NULL,
  "description" text,
  "is_system" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "permissions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "key" varchar(120) NOT NULL UNIQUE,
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "user_roles" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE RESTRICT,
  "assigned_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_user_roles_user_role" UNIQUE ("user_id", "role_id")
);

CREATE TABLE IF NOT EXISTS "role_permissions" (
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "permission_id" uuid NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("role_id", "permission_id")
);

CREATE TABLE IF NOT EXISTS "customers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_number" varchar(40) NOT NULL UNIQUE,
  "customer_type" text NOT NULL DEFAULT 'person' CHECK ("customer_type" IN ('person', 'business')),
  "name" varchar(200) NOT NULL,
  "email" varchar(320),
  "normalized_email" varchar(320),
  "phone" varchar(40),
  "normalized_phone" varchar(20),
  "company_name" varchar(200),
  "country_code" char(2) DEFAULT 'BD',
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'inactive', 'blocked')),
  "registration_source" text NOT NULL DEFAULT 'admin',
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_customers_normalized_email" ON "customers" ("normalized_email") WHERE "normalized_email" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_customers_normalized_phone" ON "customers" ("normalized_phone") WHERE "normalized_phone" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_customers_status_created_at" ON "customers" ("status", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "customer_addresses" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "address_type" text NOT NULL DEFAULT 'billing' CHECK ("address_type" IN ('billing', 'shipping', 'other')),
  "contact_name" varchar(200),
  "phone" varchar(40),
  "address_line_1" text,
  "address_line_2" text,
  "city" varchar(120),
  "state_or_region" varchar(120),
  "postal_code" varchar(40),
  "country_code" char(2) NOT NULL DEFAULT 'BD',
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_customer_addresses_customer_type" ON "customer_addresses" ("customer_id", "address_type");

CREATE TABLE IF NOT EXISTS "uploaded_assets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "object_key" text NOT NULL UNIQUE,
  "bucket_name" varchar(120) NOT NULL,
  "original_filename" varchar(255) NOT NULL,
  "content_type" varchar(150) NOT NULL,
  "byte_size" bigint NOT NULL CHECK ("byte_size" >= 0),
  "checksum_sha256" varchar(64) NOT NULL,
  "visibility" text NOT NULL DEFAULT 'private' CHECK ("visibility" IN ('private', 'public')),
  "uploaded_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "owner_customer_id" uuid REFERENCES "customers"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_uploaded_assets_owner_created" ON "uploaded_assets" ("owner_customer_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_uploaded_assets_visibility_created" ON "uploaded_assets" ("visibility", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "currencies" (
  "code" varchar(3) PRIMARY KEY NOT NULL,
  "name" varchar(80) NOT NULL,
  "symbol" varchar(16) NOT NULL,
  "exponent" integer NOT NULL DEFAULT 2 CHECK ("exponent" >= 0 AND "exponent" <= 4),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "products" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code" varchar(60) NOT NULL UNIQUE,
  "slug" varchar(120) NOT NULL UNIQUE,
  "name" varchar(200) NOT NULL,
  "description" text,
  "product_type" text NOT NULL CHECK ("product_type" IN ('wordpress_plugin', 'wordpress_theme', 'licensed_software', 'saas_application', 'dedicated_deployment', 'digital_service', 'other')),
  "fulfillment_type" text NOT NULL DEFAULT 'software_license' CHECK ("fulfillment_type" IN ('software_license', 'saas_provision', 'digital_service', 'custom')),
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'active', 'archived')),
  "website_url" text,
  "documentation_url" text,
  "logo_asset_id" uuid REFERENCES "uploaded_assets"("id") ON DELETE SET NULL,
  "provider_org_id" uuid,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_products_status_created_at" ON "products" ("status", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "product_distribution_channels" (
  "id" uuid PRIMARY KEY NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "channel_key" text NOT NULL CHECK ("channel_key" IN ('wordpress', 'hosted_saas', 'dedicated_deployment', 'api', 'direct_download', 'service_delivery')),
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'inactive')),
  "configuration" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_product_distribution_channel" UNIQUE ("product_id", "channel_key")
);

CREATE TABLE IF NOT EXISTS "product_integration_profiles" (
  "id" uuid PRIMARY KEY NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "distribution_channel_id" uuid NOT NULL REFERENCES "product_distribution_channels"("id") ON DELETE RESTRICT,
  "profile_key" varchar(80) NOT NULL,
  "protocol_version" varchar(30) NOT NULL DEFAULT 'v1',
  "activation_policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "offline_policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'inactive')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_product_integration_profile" UNIQUE ("product_id", "profile_key")
);

CREATE TABLE IF NOT EXISTS "product_releases" (
  "id" uuid PRIMARY KEY NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "version" varchar(80) NOT NULL,
  "channel" text NOT NULL DEFAULT 'stable',
  "released_at" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_product_release_version" UNIQUE ("product_id", "version", "channel")
);

CREATE TABLE IF NOT EXISTS "product_features" (
  "id" uuid PRIMARY KEY NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "feature_key" varchar(120) NOT NULL,
  "name" varchar(160) NOT NULL,
  "description" text,
  "value_type" text NOT NULL CHECK ("value_type" IN ('boolean', 'limit', 'quota', 'metered')),
  "unit" varchar(50),
  "default_value" jsonb,
  "validation_schema" jsonb,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'archived')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_product_features_key" UNIQUE ("product_id", "feature_key"),
  CONSTRAINT "uq_product_features_product_id_id" UNIQUE ("product_id", "id")
);

CREATE INDEX IF NOT EXISTS "idx_product_features_product_status" ON "product_features" ("product_id", "status", "name");

CREATE TABLE IF NOT EXISTS "product_packages" (
  "id" uuid PRIMARY KEY NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "package_key" varchar(100) NOT NULL,
  "name" varchar(160) NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'active', 'archived')),
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz,
  CONSTRAINT "uq_product_packages_key" UNIQUE ("product_id", "package_key"),
  CONSTRAINT "uq_product_packages_product_id_id" UNIQUE ("product_id", "id")
);

CREATE TABLE IF NOT EXISTS "package_versions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "package_id" uuid NOT NULL REFERENCES "product_packages"("id") ON DELETE RESTRICT,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "version_number" integer NOT NULL CHECK ("version_number" >= 1),
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'published', 'retired')),
  "change_summary" text,
  "published_at" timestamptz,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_package_versions_pkg_ver" UNIQUE ("package_id", "version_number"),
  CONSTRAINT "uq_package_versions_product_id_id" UNIQUE ("product_id", "id"),
  CONSTRAINT "fk_package_versions_same_product" FOREIGN KEY ("product_id", "package_id") REFERENCES "product_packages"("product_id", "id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "package_version_features" (
  "id" uuid PRIMARY KEY NOT NULL,
  "package_version_id" uuid NOT NULL REFERENCES "package_versions"("id") ON DELETE RESTRICT,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "product_feature_id" uuid NOT NULL REFERENCES "product_features"("id") ON DELETE RESTRICT,
  "feature_key_snapshot" varchar(120) NOT NULL,
  "value_type_snapshot" text NOT NULL,
  "entitlement_value" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_package_version_features" UNIQUE ("package_version_id", "product_feature_id"),
  CONSTRAINT "fk_pvf_version_same_product" FOREIGN KEY ("product_id", "package_version_id") REFERENCES "package_versions"("product_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "fk_pvf_feature_same_product" FOREIGN KEY ("product_id", "product_feature_id") REFERENCES "product_features"("product_id", "id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "package_prices" (
  "id" uuid PRIMARY KEY NOT NULL,
  "package_version_id" uuid NOT NULL REFERENCES "package_versions"("id") ON DELETE RESTRICT,
  "price_key" varchar(100) NOT NULL,
  "price_kind" text NOT NULL CHECK ("price_kind" IN ('free', 'one_time', 'recurring', 'lifetime')),
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" >= 0),
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "interval_unit" text CHECK ("interval_unit" IS NULL OR "interval_unit" IN ('day', 'week', 'month', 'year')),
  "interval_count" integer CHECK ("interval_count" IS NULL OR "interval_count" >= 1),
  "trial_days" integer NOT NULL DEFAULT 0 CHECK ("trial_days" >= 0),
  "setup_fee_minor" bigint NOT NULL DEFAULT 0 CHECK ("setup_fee_minor" >= 0),
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'inactive', 'retired')),
  "valid_from" timestamptz,
  "valid_until" timestamptz,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_package_prices_ver_key" UNIQUE ("package_version_id", "price_key")
);

CREATE INDEX IF NOT EXISTS "idx_package_prices_ver_status" ON "package_prices" ("package_version_id", "status");

CREATE TABLE IF NOT EXISTS "integrated_sites" (
  "id" uuid PRIMARY KEY NOT NULL,
  "site_key" varchar(100) NOT NULL UNIQUE,
  "name" varchar(160) NOT NULL,
  "environment" text NOT NULL DEFAULT 'production' CHECK ("environment" IN ('production', 'staging', 'development')),
  "status" text NOT NULL DEFAULT 'pending_verification' CHECK ("status" IN ('pending_verification', 'active', 'suspended', 'revoked')),
  "api_version" varchar(30) NOT NULL DEFAULT 'v1',
  "allowed_capabilities" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "verified_at" timestamptz,
  "revoked_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "site_domains" (
  "id" uuid PRIMARY KEY NOT NULL,
  "integrated_site_id" uuid NOT NULL REFERENCES "integrated_sites"("id") ON DELETE CASCADE,
  "domain" varchar(253) NOT NULL UNIQUE,
  "verification_method" text NOT NULL DEFAULT 'dns_txt' CHECK ("verification_method" IN ('dns_txt', 'http_file', 'manual_review')),
  "verification_challenge" varchar(120) NOT NULL,
  "verification_status" text NOT NULL DEFAULT 'pending' CHECK ("verification_status" IN ('pending', 'verified', 'failed')),
  "verified_at" timestamptz,
  "is_primary" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "site_products" (
  "integrated_site_id" uuid NOT NULL REFERENCES "integrated_sites"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("integrated_site_id", "product_id")
);

CREATE TABLE IF NOT EXISTS "site_credentials" (
  "id" uuid PRIMARY KEY NOT NULL,
  "integrated_site_id" uuid NOT NULL REFERENCES "integrated_sites"("id") ON DELETE CASCADE,
  "key_id" varchar(100) NOT NULL UNIQUE,
  "credential_type" text NOT NULL CHECK ("credential_type" IN ('public_key', 'bearer_secret', 'hmac_shared_secret', 'public_signing_key')),
  "secret_hash" text,
  "secret_ciphertext" text,
  "public_key_material" text,
  "encryption_key_version" varchar(50),
  "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'rotated', 'revoked', 'expired')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "last_used_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "request_nonces" (
  "id" uuid PRIMARY KEY NOT NULL,
  "credential_id" uuid NOT NULL REFERENCES "site_credentials"("id") ON DELETE CASCADE,
  "nonce" varchar(160) NOT NULL,
  "request_timestamp" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_request_nonces_cred_nonce" UNIQUE ("credential_id", "nonce")
);

CREATE INDEX IF NOT EXISTS "idx_request_nonces_expires_at" ON "request_nonces" ("expires_at");

CREATE TABLE IF NOT EXISTS "orders" (
  "id" uuid PRIMARY KEY NOT NULL,
  "order_number" varchar(50) NOT NULL UNIQUE,
  "public_reference" varchar(80) NOT NULL UNIQUE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "source" text NOT NULL DEFAULT 'admin' CHECK ("source" IN ('admin', 'website', 'api', 'import')),
  "integrated_site_id" uuid REFERENCES "integrated_sites"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'awaiting_payment' CHECK ("status" IN ('draft', 'awaiting_payment', 'processing', 'completed', 'cancelled', 'failed')),
  "payment_status" text NOT NULL DEFAULT 'unpaid' CHECK ("payment_status" IN ('unpaid', 'pending_verification', 'paid', 'partially_refunded', 'refunded')),
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "subtotal_minor" bigint NOT NULL CHECK ("subtotal_minor" >= 0),
  "discount_minor" bigint NOT NULL DEFAULT 0 CHECK ("discount_minor" >= 0),
  "tax_minor" bigint NOT NULL DEFAULT 0 CHECK ("tax_minor" >= 0),
  "total_minor" bigint NOT NULL CHECK ("total_minor" >= 0),
  "customer_note" text,
  "internal_note" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "cancelled_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_orders_customer_created" ON "orders" ("customer_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_orders_status_created" ON "orders" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_orders_payment_status_created" ON "orders" ("payment_status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_orders_site_created" ON "orders" ("integrated_site_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "order_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "package_id" uuid REFERENCES "product_packages"("id") ON DELETE RESTRICT,
  "package_version_id" uuid REFERENCES "package_versions"("id") ON DELETE RESTRICT,
  "package_price_id" uuid REFERENCES "package_prices"("id") ON DELETE RESTRICT,
  "item_kind" text NOT NULL DEFAULT 'package' CHECK ("item_kind" IN ('package', 'custom', 'one_time_product', 'other')),
  "fulfillment_type_snapshot" text NOT NULL DEFAULT 'software_license',
  "product_name_snapshot" varchar(200) NOT NULL,
  "package_name_snapshot" varchar(200),
  "package_version_snapshot" integer,
  "price_kind_snapshot" text NOT NULL DEFAULT 'recurring',
  "interval_unit_snapshot" text,
  "interval_count_snapshot" integer,
  "activation_limit_snapshot" integer NOT NULL DEFAULT 1,
  "quantity" integer NOT NULL DEFAULT 1 CHECK ("quantity" >= 1),
  "unit_amount_minor" bigint NOT NULL CHECK ("unit_amount_minor" >= 0),
  "line_subtotal_minor" bigint NOT NULL CHECK ("line_subtotal_minor" >= 0),
  "line_discount_minor" bigint NOT NULL DEFAULT 0 CHECK ("line_discount_minor" >= 0),
  "line_tax_minor" bigint NOT NULL DEFAULT 0 CHECK ("line_tax_minor" >= 0),
  "line_total_minor" bigint NOT NULL CHECK ("line_total_minor" >= 0),
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_order_items_order_id" ON "order_items" ("order_id");
CREATE INDEX IF NOT EXISTS "idx_order_items_product_created" ON "order_items" ("product_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "order_item_entitlement_snapshots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "order_item_id" uuid NOT NULL UNIQUE REFERENCES "order_items"("id") ON DELETE RESTRICT,
  "source_type" text NOT NULL CHECK ("source_type" IN ('package_version', 'custom_offer', 'complimentary', 'manual_adjustment')),
  "source_package_version_id" uuid REFERENCES "package_versions"("id") ON DELETE RESTRICT,
  "schema_version" integer NOT NULL DEFAULT 1,
  "snapshot_hash" varchar(64) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "order_item_entitlement_snapshot_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "snapshot_id" uuid NOT NULL REFERENCES "order_item_entitlement_snapshots"("id") ON DELETE RESTRICT,
  "feature_key_snapshot" varchar(120) NOT NULL,
  "value_type_snapshot" text NOT NULL,
  "entitlement_value" jsonb NOT NULL,
  "unit_snapshot" varchar(50),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_order_item_snapshot_feature" UNIQUE ("snapshot_id", "feature_key_snapshot")
);

CREATE TABLE IF NOT EXISTS "order_adjustments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "order_item_id" uuid REFERENCES "order_items"("id") ON DELETE RESTRICT,
  "adjustment_type" text NOT NULL CHECK ("adjustment_type" IN ('discount', 'tax', 'fee', 'credit', 'other')),
  "label_snapshot" varchar(160) NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "calculation_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "subscription_number" varchar(60) NOT NULL UNIQUE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "source_order_item_id" uuid REFERENCES "order_items"("id") ON DELETE RESTRICT,
  "source_package_version_id" uuid REFERENCES "package_versions"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('trialing', 'pending', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  "billing_kind" text NOT NULL CHECK ("billing_kind" IN ('one_time', 'recurring', 'lifetime', 'custom')),
  "interval_unit" text,
  "interval_count" integer,
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "current_period_start" timestamptz,
  "current_period_end" timestamptz,
  "next_renewal_at" timestamptz,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "cancelled_at" timestamptz,
  "ended_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_subscriptions_customer_created" ON "subscriptions" ("customer_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_subscriptions_product_status" ON "subscriptions" ("product_id", "status");
CREATE INDEX IF NOT EXISTS "idx_subscriptions_status_next_renewal" ON "subscriptions" ("status", "next_renewal_at");

CREATE TABLE IF NOT EXISTS "subscription_periods" (
  "id" uuid PRIMARY KEY NOT NULL,
  "subscription_id" uuid NOT NULL REFERENCES "subscriptions"("id") ON DELETE RESTRICT,
  "period_number" integer NOT NULL CHECK ("period_number" >= 1),
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'active', 'completed', 'void', 'failed')),
  "renewal_order_id" uuid REFERENCES "orders"("id") ON DELETE RESTRICT,
  "invoice_id" uuid,
  "payment_transaction_id" uuid,
  "activated_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_subscription_periods_number" UNIQUE ("subscription_id", "period_number"),
  CONSTRAINT "uq_subscription_periods_window" UNIQUE ("subscription_id", "period_start", "period_end")
);

CREATE TABLE IF NOT EXISTS "subscription_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "subscription_id" uuid NOT NULL REFERENCES "subscriptions"("id") ON DELETE RESTRICT,
  "event_type" varchar(80) NOT NULL,
  "from_status" text,
  "to_status" text,
  "actor_type" text NOT NULL CHECK ("actor_type" IN ('system', 'staff', 'customer', 'provider')),
  "actor_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "related_order_id" uuid REFERENCES "orders"("id") ON DELETE RESTRICT,
  "related_invoice_id" uuid,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "invoices" (
  "id" uuid PRIMARY KEY NOT NULL,
  "invoice_number" varchar(60) NOT NULL UNIQUE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE RESTRICT,
  "subscription_id" uuid REFERENCES "subscriptions"("id") ON DELETE RESTRICT,
  "invoice_type" text NOT NULL DEFAULT 'initial' CHECK ("invoice_type" IN ('initial', 'renewal', 'adjustment', 'credit_note')),
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('draft', 'open', 'paid', 'void', 'uncollectible', 'partially_paid')),
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "subtotal_minor" bigint NOT NULL CHECK ("subtotal_minor" >= 0),
  "discount_minor" bigint NOT NULL DEFAULT 0 CHECK ("discount_minor" >= 0),
  "tax_minor" bigint NOT NULL DEFAULT 0 CHECK ("tax_minor" >= 0),
  "total_minor" bigint NOT NULL CHECK ("total_minor" >= 0),
  "amount_paid_minor" bigint NOT NULL DEFAULT 0 CHECK ("amount_paid_minor" >= 0),
  "amount_due_minor" bigint NOT NULL CHECK ("amount_due_minor" >= 0),
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "due_at" timestamptz,
  "paid_at" timestamptz,
  "billing_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_invoices_customer_issued" ON "invoices" ("customer_id", "issued_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_invoices_status_due" ON "invoices" ("status", "due_at");
CREATE INDEX IF NOT EXISTS "idx_invoices_subscription_issued" ON "invoices" ("subscription_id", "issued_at" DESC);

CREATE TABLE IF NOT EXISTS "invoice_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "invoice_id" uuid NOT NULL REFERENCES "invoices"("id") ON DELETE RESTRICT,
  "order_item_id" uuid REFERENCES "order_items"("id") ON DELETE RESTRICT,
  "description_snapshot" text NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1 CHECK ("quantity" >= 1),
  "unit_amount_minor" bigint NOT NULL CHECK ("unit_amount_minor" >= 0),
  "line_amount_minor" bigint NOT NULL CHECK ("line_amount_minor" >= 0),
  "tax_amount_minor" bigint NOT NULL DEFAULT 0 CHECK ("tax_amount_minor" >= 0),
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "payment_providers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "provider_key" varchar(80) NOT NULL UNIQUE,
  "display_name" varchar(120) NOT NULL,
  "provider_type" text NOT NULL CHECK ("provider_type" IN ('manual_mfs', 'manual_bank', 'automated')),
  "adapter_key" varchar(100) NOT NULL,
  "status" text NOT NULL DEFAULT 'enabled' CHECK ("status" IN ('enabled', 'disabled')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "payment_methods" (
  "id" uuid PRIMARY KEY NOT NULL,
  "provider_id" uuid NOT NULL REFERENCES "payment_providers"("id") ON DELETE RESTRICT,
  "method_key" varchar(100) NOT NULL,
  "display_name" varchar(160) NOT NULL,
  "method_kind" text NOT NULL CHECK ("method_kind" IN ('mfs_account', 'bank_account', 'automated_checkout')),
  "account_type" text,
  "account_label" varchar(160),
  "instructions" text,
  "configuration_schema_version" integer NOT NULL DEFAULT 1,
  "configuration" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "logo_asset_id" uuid REFERENCES "uploaded_assets"("id") ON DELETE SET NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "valid_from" timestamptz,
  "valid_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_payment_methods_provider_key" UNIQUE ("provider_id", "method_key")
);

CREATE INDEX IF NOT EXISTS "idx_payment_methods_provider_enabled_sort" ON "payment_methods" ("provider_id", "is_enabled", "sort_order");

CREATE TABLE IF NOT EXISTS "payment_method_transfer_rails" (
  "id" uuid PRIMARY KEY NOT NULL,
  "payment_method_id" uuid NOT NULL REFERENCES "payment_methods"("id") ON DELETE CASCADE,
  "rail_key" text NOT NULL CHECK ("rail_key" IN ('npsb', 'beftn', 'rtgs')),
  "display_label" varchar(100) NOT NULL,
  "instructions" text,
  "is_enabled" boolean NOT NULL DEFAULT true,
  CONSTRAINT "uq_payment_method_transfer_rails" UNIQUE ("payment_method_id", "rail_key")
);

CREATE TABLE IF NOT EXISTS "payment_submissions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "payment_method_id" uuid NOT NULL REFERENCES "payment_methods"("id") ON DELETE RESTRICT,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "sender_name" varchar(160),
  "sender_phone" varchar(40),
  "sender_bank_name" varchar(160),
  "sender_account_reference" varchar(160),
  "transfer_rail_key" varchar(40),
  "transaction_reference" varchar(160),
  "normalized_transaction_reference" varchar(160),
  "payment_date" date,
  "proof_asset_id" uuid REFERENCES "uploaded_assets"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'submitted' CHECK ("status" IN ('submitted', 'under_review', 'approved', 'rejected', 'cancelled')),
  "customer_note" text,
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "reviewed_at" timestamptz,
  "reviewed_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_payment_submissions_order_submitted" ON "payment_submissions" ("order_id", "submitted_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_payment_submissions_status_submitted" ON "payment_submissions" ("status", "submitted_at");
CREATE INDEX IF NOT EXISTS "idx_payment_submissions_method_norm_ref" ON "payment_submissions" ("payment_method_id", "normalized_transaction_reference") WHERE "normalized_transaction_reference" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_payment_submissions_customer_submitted" ON "payment_submissions" ("customer_id", "submitted_at" DESC);

CREATE TABLE IF NOT EXISTS "payment_transactions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "payment_method_id" uuid REFERENCES "payment_methods"("id") ON DELETE RESTRICT,
  "payment_submission_id" uuid UNIQUE REFERENCES "payment_submissions"("id") ON DELETE RESTRICT,
  "provider_id" uuid NOT NULL REFERENCES "payment_providers"("id") ON DELETE RESTRICT,
  "provider_transaction_id" varchar(180),
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'succeeded' CHECK ("status" IN ('succeeded', 'pending', 'failed', 'partially_refunded', 'refunded')),
  "paid_at" timestamptz,
  "verified_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "verification_source" text NOT NULL DEFAULT 'manual_staff' CHECK ("verification_source" IN ('manual_staff', 'provider_webhook', 'provider_query', 'import')),
  "provider_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_payment_transactions_order_created" ON "payment_transactions" ("order_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_payment_transactions_provider_txn" ON "payment_transactions" ("provider_id", "provider_transaction_id") WHERE "provider_transaction_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_payment_transactions_status_paid" ON "payment_transactions" ("status", "paid_at" DESC);

CREATE TABLE IF NOT EXISTS "payment_verification_logs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "payment_submission_id" uuid NOT NULL REFERENCES "payment_submissions"("id") ON DELETE RESTRICT,
  "actor_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "decision" text NOT NULL CHECK ("decision" IN ('approved', 'rejected', 'requested_information', 'reopened')),
  "reason_code" varchar(80),
  "customer_message" text,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "payment_refunds" (
  "id" uuid PRIMARY KEY NOT NULL,
  "payment_transaction_id" uuid NOT NULL REFERENCES "payment_transactions"("id") ON DELETE RESTRICT,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "currency_code" varchar(3) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'requested' CHECK ("status" IN ('requested', 'pending', 'succeeded', 'failed', 'cancelled')),
  "reason" text NOT NULL,
  "provider_refund_id" varchar(180),
  "requested_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "processed_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "signing_key_metadata" (
  "id" uuid PRIMARY KEY NOT NULL,
  "key_id" varchar(80) NOT NULL UNIQUE,
  "algorithm" varchar(24) NOT NULL DEFAULT 'EdDSA',
  "public_key_jwk" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'retiring', 'retired', 'revoked')),
  "activated_at" timestamptz NOT NULL DEFAULT now(),
  "retired_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "licenses" (
  "id" uuid PRIMARY KEY NOT NULL,
  "license_number" varchar(60) NOT NULL UNIQUE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "integration_profile_id" uuid NOT NULL REFERENCES "product_integration_profiles"("id") ON DELETE RESTRICT,
  "source_order_item_id" uuid REFERENCES "order_items"("id") ON DELETE RESTRICT,
  "subscription_id" uuid REFERENCES "subscriptions"("id") ON DELETE RESTRICT,
  "license_key_hash" text NOT NULL UNIQUE,
  "license_key_hint" varchar(24) NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'active', 'expired', 'suspended', 'revoked')),
  "activation_limit" integer NOT NULL DEFAULT 1 CHECK ("activation_limit" >= 1),
  "valid_from" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "grace_until" timestamptz,
  "current_entitlement_snapshot_id" uuid,
  "issued_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_licenses_customer_created" ON "licenses" ("customer_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_licenses_product_status_expires" ON "licenses" ("product_id", "status", "expires_at");
CREATE INDEX IF NOT EXISTS "idx_licenses_subscription_id" ON "licenses" ("subscription_id") WHERE "subscription_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "license_entitlement_snapshots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "license_id" uuid NOT NULL REFERENCES "licenses"("id") ON DELETE RESTRICT,
  "version_number" integer NOT NULL CHECK ("version_number" >= 1),
  "source_type" text NOT NULL CHECK ("source_type" IN ('order_item', 'subscription_period', 'manual_grant', 'admin_adjustment')),
  "source_order_item_id" uuid REFERENCES "order_items"("id") ON DELETE RESTRICT,
  "source_subscription_period_id" uuid REFERENCES "subscription_periods"("id") ON DELETE RESTRICT,
  "effective_at" timestamptz NOT NULL DEFAULT now(),
  "reason" text,
  "snapshot_hash" varchar(64) NOT NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_license_entitlement_snapshot_ver" UNIQUE ("license_id", "version_number")
);

CREATE TABLE IF NOT EXISTS "license_entitlement_snapshot_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "snapshot_id" uuid NOT NULL REFERENCES "license_entitlement_snapshots"("id") ON DELETE RESTRICT,
  "feature_key_snapshot" varchar(120) NOT NULL,
  "value_type_snapshot" text NOT NULL,
  "entitlement_value" jsonb NOT NULL,
  "unit_snapshot" varchar(50),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_license_snapshot_item_feature" UNIQUE ("snapshot_id", "feature_key_snapshot")
);

CREATE TABLE IF NOT EXISTS "license_activations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "license_id" uuid NOT NULL REFERENCES "licenses"("id") ON DELETE RESTRICT,
  "installation_id_hash" varchar(128) NOT NULL,
  "domain_normalized" varchar(253),
  "environment" text NOT NULL DEFAULT 'production' CHECK ("environment" IN ('production', 'staging', 'development', 'other')),
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'deactivated', 'blocked')),
  "activated_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz,
  "deactivated_at" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_license_activations_installation" UNIQUE ("license_id", "installation_id_hash")
);

CREATE INDEX IF NOT EXISTS "idx_license_activations_license_status" ON "license_activations" ("license_id", "status");

CREATE TABLE IF NOT EXISTS "license_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "license_id" uuid NOT NULL REFERENCES "licenses"("id") ON DELETE RESTRICT,
  "event_type" varchar(80) NOT NULL,
  "actor_type" text NOT NULL CHECK ("actor_type" IN ('system', 'staff', 'client')),
  "actor_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "activation_id" uuid REFERENCES "license_activations"("id") ON DELETE SET NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "license_validation_logs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "license_id" uuid REFERENCES "licenses"("id") ON DELETE SET NULL,
  "integration_profile_id" uuid REFERENCES "product_integration_profiles"("id") ON DELETE SET NULL,
  "activation_id" uuid REFERENCES "license_activations"("id") ON DELETE SET NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('valid', 'rejected')),
  "error_code" varchar(80),
  "request_id" varchar(100) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "tracking_configurations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "integrated_site_id" uuid NOT NULL REFERENCES "integrated_sites"("id") ON DELETE CASCADE,
  "provider" text NOT NULL DEFAULT 'meta',
  "pixel_id" varchar(80) NOT NULL,
  "access_token_ciphertext" text NOT NULL,
  "encryption_key_version" varchar(50) NOT NULL DEFAULT 'v1',
  "test_event_code" varchar(80),
  "enabled_events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "consent_policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'enabled' CHECK ("status" IN ('enabled', 'disabled')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "rotated_at" timestamptz,
  CONSTRAINT "uq_tracking_configurations_site_provider" UNIQUE ("integrated_site_id", "provider")
);

CREATE TABLE IF NOT EXISTS "tracking_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "integrated_site_id" uuid NOT NULL REFERENCES "integrated_sites"("id") ON DELETE RESTRICT,
  "event_name" varchar(80) NOT NULL,
  "event_id" varchar(160) NOT NULL,
  "event_time" timestamptz NOT NULL,
  "event_source_url" text,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE RESTRICT,
  "consent_state" text NOT NULL,
  "consent_policy_version" varchar(40) NOT NULL,
  "sanitized_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'received' CHECK ("status" IN ('received', 'queued', 'processed', 'rejected')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_tracking_events_dedup" UNIQUE ("integrated_site_id", "event_name", "event_id")
);

CREATE INDEX IF NOT EXISTS "idx_tracking_events_order_id" ON "tracking_events" ("order_id") WHERE "order_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "tracking_deliveries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tracking_event_id" uuid NOT NULL REFERENCES "tracking_events"("id") ON DELETE CASCADE,
  "destination" text NOT NULL DEFAULT 'meta_capi',
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'delivered', 'retrying', 'failed', 'skipped')),
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz,
  "last_http_status" integer,
  "last_error_code" varchar(100),
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "order_attributions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "order_id" uuid NOT NULL UNIQUE REFERENCES "orders"("id") ON DELETE CASCADE,
  "utm_source" varchar(120),
  "utm_medium" varchar(120),
  "utm_campaign" varchar(120),
  "utm_content" varchar(120),
  "utm_term" varchar(120),
  "fbp" varchar(200),
  "fbc" varchar(200),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "event_key" varchar(120) NOT NULL UNIQUE,
  "aggregate_type" varchar(80) NOT NULL,
  "aggregate_id" uuid NOT NULL,
  "event_type" varchar(120) NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'processing', 'delivered', 'dead_letter')),
  "attempt_count" integer NOT NULL DEFAULT 0,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "locked_until" timestamptz,
  "locked_by" varchar(120),
  "last_error_code" varchar(100),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_outbox_events_status_available" ON "outbox_events" ("status", "available_at");
CREATE INDEX IF NOT EXISTS "idx_outbox_events_aggregate" ON "outbox_events" ("aggregate_type", "aggregate_id", "created_at");

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id" uuid PRIMARY KEY NOT NULL,
  "integrated_site_id" uuid REFERENCES "integrated_sites"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "description" varchar(160) NOT NULL,
  "subscribed_events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'disabled', 'revoked')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "webhook_endpoint_secrets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "webhook_endpoint_id" uuid NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  "key_id" varchar(100) NOT NULL UNIQUE,
  "secret_ciphertext" text NOT NULL,
  "key_version" varchar(50) NOT NULL DEFAULT 'v1',
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'retiring', 'revoked')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "revoked_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "webhook_endpoint_id" uuid NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "outbox_events"("id") ON DELETE CASCADE,
  "delivery_id" varchar(80) NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'delivered', 'retrying', 'failed')),
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz,
  "last_http_status" integer,
  "last_error_code" varchar(100),
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_webhook_deliveries_endpoint_delivery" UNIQUE ("webhook_endpoint_id", "delivery_id")
);

CREATE TABLE IF NOT EXISTS "idempotency_records" (
  "id" uuid PRIMARY KEY NOT NULL,
  "scope_key" varchar(160) NOT NULL,
  "idempotency_key" varchar(160) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "response_status" integer,
  "response_reference" varchar(160),
  "status" text NOT NULL DEFAULT 'processing' CHECK ("status" IN ('processing', 'completed', 'failed')),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_idempotency_records_scope_key" UNIQUE ("scope_key", "idempotency_key")
);

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "notification_type" varchar(100) NOT NULL,
  "channel" text NOT NULL DEFAULT 'email' CHECK ("channel" IN ('email', 'in_app')),
  "template_key" varchar(100) NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'sent', 'failed', 'cancelled')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "actor_type" text NOT NULL CHECK ("actor_type" IN ('staff', 'system', 'integration')),
  "actor_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "integrated_site_id" uuid REFERENCES "integrated_sites"("id") ON DELETE SET NULL,
  "action" varchar(120) NOT NULL,
  "resource_type" varchar(100) NOT NULL,
  "resource_id" varchar(100) NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('success', 'denied', 'failed')),
  "request_id" varchar(100),
  "ip_hash" varchar(128),
  "changes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_audit_logs_resource" ON "audit_logs" ("resource_type", "resource_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_audit_logs_actor" ON "audit_logs" ("actor_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_audit_logs_action" ON "audit_logs" ("action", "created_at" DESC);

-- Immutability Guard Triggers for Append-Only Snapshots and Audit Records
CREATE OR REPLACE FUNCTION prevent_immutable_record_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Historical commercial snapshots, verification logs, and audit logs are immutable and cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_order_item_snapshots ON "order_item_entitlement_snapshots";
CREATE TRIGGER trg_immutable_order_item_snapshots
BEFORE UPDATE OR DELETE ON "order_item_entitlement_snapshots"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

DROP TRIGGER IF EXISTS trg_immutable_order_item_snapshot_items ON "order_item_entitlement_snapshot_items";
CREATE TRIGGER trg_immutable_order_item_snapshot_items
BEFORE UPDATE OR DELETE ON "order_item_entitlement_snapshot_items"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

DROP TRIGGER IF EXISTS trg_immutable_license_snapshots ON "license_entitlement_snapshots";
CREATE TRIGGER trg_immutable_license_snapshots
BEFORE UPDATE OR DELETE ON "license_entitlement_snapshots"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

DROP TRIGGER IF EXISTS trg_immutable_license_snapshot_items ON "license_entitlement_snapshot_items";
CREATE TRIGGER trg_immutable_license_snapshot_items
BEFORE UPDATE OR DELETE ON "license_entitlement_snapshot_items"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

DROP TRIGGER IF EXISTS trg_immutable_payment_verification_logs ON "payment_verification_logs";
CREATE TRIGGER trg_immutable_payment_verification_logs
BEFORE UPDATE OR DELETE ON "payment_verification_logs"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

DROP TRIGGER IF EXISTS trg_immutable_audit_logs ON "audit_logs";
CREATE TRIGGER trg_immutable_audit_logs
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();
