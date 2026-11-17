-- StackMate Migration 0009: Customer + Order + Payments + License activation
-- + Renewal automation + Support Tickets + Leads (owner-approved batch,
-- 2026-11-17; ADR-0009).
--
-- Why this migration exists: the admin had NO way to create customers or
-- orders (endpoints existed, UI did not), partial payments were hard-blocked
-- (API spec §27 decision, now flipped by the owner), licenses only activated
-- on full payment, nothing swept renewals/expiry, and there was no ticket or
-- lead tracking at all. This migration adds the storage for all of it.
--
--   customers.whatsapp ................. WhatsApp number (may equal phone)
--   customers.credit_balance_minor ..... overpayment credit, minor units
--   customer_contacts .................. secondary emails/phones (dedupe)
--                                        UNIQUE (kind, normalized_value):
--                                        one normalized contact belongs to
--                                        at most one customer. Primary
--                                        contacts stay on `customers` (no
--                                        unique index there yet — staging
--                                        already holds duplicate primaries
--                                        from the old checkout path; app-layer
--                                        dedupe enforces it, see ADR-0009).
--   customer_addresses ................. ALREADY in schema + SQL 0000; only
--                                        wired up by this batch (no DDL here).
--   customer_reports ................... staff reports on a customer
--                                        (note / concern + detail, required)
--   order_installments ................. payment plan per order
--   orders.activation_* ................ license activation policy per order
--   orders.grace_days .................. renewal grace (days), per order
--   orders.payment_method_id ........... selected payment method
--   orders.lead_id ..................... lead this order converted from
--   subscriptions.grace_days ........... copied from the order at fulfillment
--   reminder_settings .................. SINGLETON row (id "default"):
--                                        due/overdue reminder offsets
--   sent_reminders ..................... idempotency for sent reminders
--   support_tickets + ticket_comments ... issue management
--   leads .............................. lead capture + conversion links
--   permissions tickets.view/manage .... + role grants (super_admin/admin get
--                                        both via the seed; support_staff both,
--                                        read_only view). Leads use the
--                                        existing customers/orders grants.
--   sequence_counters ticket/lead ...... minted by the store on first use
--                                        (upsert in persistStateDiff), no seed
--                                        rows needed.
--
-- All changes are additive (new tables / new nullable-or-defaulted columns /
-- inserts with ON CONFLICT DO NOTHING) and idempotent, so re-running is safe.
-- Migration 0000–0008 are NOT edited.

-- --- Customers: WhatsApp + credit balance ------------------------------------
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "whatsapp" varchar(40);
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "credit_balance_minor" bigint NOT NULL DEFAULT 0;

-- --- Secondary contacts (dedupe) ---------------------------------------------
CREATE TABLE IF NOT EXISTS "customer_contacts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "value" varchar(320) NOT NULL,
  "normalized_value" varchar(320) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_contacts_kind_normalized"
  ON "customer_contacts" ("kind", "normalized_value");
CREATE INDEX IF NOT EXISTS "idx_customer_contacts_customer"
  ON "customer_contacts" ("customer_id", "created_at");

-- --- Staff reports on customers ----------------------------------------------
CREATE TABLE IF NOT EXISTS "customer_reports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE,
  "author_user_id" text NOT NULL,
  "type" text NOT NULL DEFAULT 'note',
  "detail" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_customer_reports_customer_created"
  ON "customer_reports" ("customer_id", "created_at" DESC);

-- --- Payment plan installments -----------------------------------------------
CREATE TABLE IF NOT EXISTS "order_installments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders" ("id") ON DELETE CASCADE,
  "installment_number" integer NOT NULL,
  "amount_minor" bigint NOT NULL,
  "due_date" date NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "paid_amount_minor" bigint NOT NULL DEFAULT 0,
  "paid_at" timestamp with time zone,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_order_installments_number"
  ON "order_installments" ("order_id", "installment_number");
CREATE INDEX IF NOT EXISTS "idx_order_installments_order_due"
  ON "order_installments" ("order_id", "due_date");

-- --- Orders: activation policy + grace + payment method + lead link ----------
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "activation_mode" text NOT NULL DEFAULT 'on_full_payment';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "activation_percent" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "activation_date" date;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "suspend_on_missed_schedule" boolean NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "grace_days" integer NOT NULL DEFAULT 3;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_method_id" uuid REFERENCES "payment_methods" ("id") ON DELETE SET NULL;
-- lead_id references leads (created below); added after the leads table.
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "grace_days" integer NOT NULL DEFAULT 3;

-- --- Reminder settings (singleton) + sent-reminder idempotency ---------------
CREATE TABLE IF NOT EXISTS "reminder_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "due_offsets_days" jsonb NOT NULL DEFAULT '[7, 1]'::jsonb,
  "overdue_offsets_days" jsonb NOT NULL DEFAULT '[1, 3]'::jsonb,
  "overdue_enabled" boolean NOT NULL DEFAULT true,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "sent_reminders" (
  "id" uuid PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "reference_id" uuid NOT NULL,
  "offset_days" integer NOT NULL,
  "sent_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sent_reminders_kind_ref_offset"
  ON "sent_reminders" ("kind", "reference_id", "offset_days");

-- --- Support tickets ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "ticket_number" varchar(40) NOT NULL UNIQUE,
  "customer_id" uuid REFERENCES "customers" ("id") ON DELETE SET NULL,
  "order_id" uuid REFERENCES "orders" ("id") ON DELETE SET NULL,
  "subscription_id" uuid REFERENCES "subscriptions" ("id") ON DELETE SET NULL,
  "license_id" uuid REFERENCES "licenses" ("id") ON DELETE SET NULL,
  "product_id" uuid REFERENCES "products" ("id") ON DELETE SET NULL,
  "title" varchar(200) NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'open',
  "priority" text NOT NULL DEFAULT 'medium',
  "category" text NOT NULL DEFAULT 'other',
  "reporter_user_id" text NOT NULL,
  "source_note" text,
  "assignee_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "closed_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "idx_support_tickets_customer_created"
  ON "support_tickets" ("customer_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_support_tickets_status_created"
  ON "support_tickets" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_support_tickets_assignee"
  ON "support_tickets" ("assignee_user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "ticket_comments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "ticket_id" uuid NOT NULL REFERENCES "support_tickets" ("id") ON DELETE CASCADE,
  "author_user_id" text NOT NULL,
  "body" text NOT NULL,
  "is_internal" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_ticket_comments_ticket_created"
  ON "ticket_comments" ("ticket_id", "created_at");

-- --- Leads --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "leads" (
  "id" uuid PRIMARY KEY NOT NULL,
  "lead_number" varchar(40) NOT NULL UNIQUE,
  "name" varchar(200) NOT NULL,
  "email" varchar(320),
  "normalized_email" varchar(320),
  "phone" varchar(40),
  "normalized_phone" varchar(20),
  "whatsapp" varchar(40),
  "source_site_id" uuid REFERENCES "integrated_sites" ("id") ON DELETE SET NULL,
  "utm_source" varchar(120),
  "utm_medium" varchar(120),
  "utm_campaign" varchar(120),
  "interest" text,
  "product_id" uuid REFERENCES "products" ("id") ON DELETE SET NULL,
  "message" text,
  "notes" text,
  "status" text NOT NULL DEFAULT 'new',
  "assignee_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "converted_at" timestamp with time zone,
  "converted_customer_id" uuid REFERENCES "customers" ("id") ON DELETE SET NULL,
  -- converted_order_id intentionally has NO FK: orders.lead_id already
  -- references leads, and a second FK back would make the two tables
  -- circular (see db/schema/leads.ts). Enforced at the service level.
  "converted_order_id" uuid
);
CREATE INDEX IF NOT EXISTS "idx_leads_normalized_email"
  ON "leads" ("normalized_email") WHERE "normalized_email" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_leads_normalized_phone"
  ON "leads" ("normalized_phone") WHERE "normalized_phone" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_leads_status_created"
  ON "leads" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_leads_source_site_created"
  ON "leads" ("source_site_id", "created_at" DESC);

-- orders.lead_id (deferred until the leads table exists)
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "lead_id" uuid REFERENCES "leads" ("id") ON DELETE SET NULL;

-- --- Ticket + lead permissions + role grants ----------------------------------
-- New permission rows (deterministic UUIDs continue the 0003 sequence).
INSERT INTO "permissions" ("id", "key", "description", "created_at")
VALUES
  ('00000000-0000-4000-8000-000000000126', 'tickets.view', 'View support tickets and their history', now()),
  ('00000000-0000-4000-8000-000000000127', 'tickets.manage', 'Create, assign, and resolve support tickets', now()),
  ('00000000-0000-4000-8000-000000000128', 'leads.view', 'View leads and their history', now()),
  ('00000000-0000-4000-8000-000000000129', 'leads.manage', 'Create, assign, convert, and manage leads', now())
ON CONFLICT ("id") DO NOTHING;

-- Grants: super_admin + admin already hold every permission by construction
-- in the seed, but existing databases were seeded by migration 0003, so the
-- new permissions must be granted explicitly here. support_staff gets all
-- four (tickets + leads are support work); read_only gets view only.
-- finance/license/product/marketing roles intentionally get none.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('tickets.view', 'tickets.manage', 'leads.view', 'leads.manage')
WHERE r."key" IN ('super_admin', 'admin', 'support_staff')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('tickets.view', 'leads.view')
WHERE r."key" = 'read_only'
ON CONFLICT DO NOTHING;

-- Payment submissions may name the installment they pay towards
-- (oldest-first allocation when null). order_installments is created
-- above, so this ALTER must stay after its CREATE TABLE.
ALTER TABLE "payment_submissions"
  ADD COLUMN IF NOT EXISTS "installment_id" uuid
  REFERENCES "order_installments" ("id") ON DELETE SET NULL;
