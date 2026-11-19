-- 0010 — orders.payment_status gains 'partially_paid' (ADR-0009 §3).
--
-- The service has set payment_status = 'partially_paid' since the
-- payment-plan work (migration 0009 added the value to the contracts
-- enum and the approval flow), but the 0000 DDL check constraint on
-- orders still lists only
-- ('unpaid', 'pending_verification', 'paid', 'partially_refunded',
-- 'refunded') — so the first partial approval failed in Postgres with
-- "orders_payment_status_check" violated. Caught by
-- apps/api/test/payment-plans.test.ts (partial claim + approve).
-- Invoices already include 'partially_paid' in their 0000 check; the
-- 0009 tables (order_installments, support_tickets, leads) carry plain
-- text status columns with no check; subscriptions + licenses checks
-- already include past_due / expired / suspended.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_payment_status_check";
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_status_check"
  CHECK ("payment_status" IN ('unpaid', 'pending_verification', 'partially_paid', 'paid', 'partially_refunded', 'refunded'));
