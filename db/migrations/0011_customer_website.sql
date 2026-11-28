-- 0011 — customers.website (ADR-0009 decision 11, fix batch 2026-11-17).
--
-- The Add Customer UI collected `website` and sent it, but there was no
-- column and no schema field: valibot stripped the unknown key, so the
-- value was silently discarded on every submission. The owner approved
-- website as a customer field, so it becomes a real stored field here.
-- Nullable, max 200 chars, matching the contract schema.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "website" varchar(200);
