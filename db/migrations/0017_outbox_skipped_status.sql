-- 0017 — C-2 follow-up (Q3, 2026-11-22): widen the outbox_events
-- status CHECK to include 'skipped'.
--
-- Q3: a non-CAPI outbox event with NO subscribed active endpoint
-- was recorded "delivered" even though nothing received it — the
-- endpoint loop simply ran zero times and the terminal block marked
-- it delivered anyway (confirmed live on staging 2026-11-22:
-- payment.submitted + payment.approved both read "Delivered" with
-- zero endpoints registered). The dispatcher now records such
-- events as terminal "skipped" (audit action
-- webhooks.outbox_event.skipped_no_subscribers, counted apart from
-- delivered / retrying / dead-lettered). The CHECK must accept the
-- new value or the Drizzle store cannot persist those rows.
--
-- DEPLOY SAFETY: widening an IN list is a superset change — every
-- value the old CHECK accepted is still accepted, so no existing row
-- can violate the new CHECK and the drop + re-add below cannot fail
-- on data. The drop is done by name-prefix lookup (pg_constraint)
-- so it works whether the constraint came from migration 0000
-- (Postgres auto-name `<table>_<column>_check`) or from drizzle-kit
-- generate (explicit name). Follows the migration 0015 pattern.
--
-- All changes are additive and idempotent (name-prefix drop +
-- re-add), so re-running is safe. Migrations 0000–0016 are NOT
-- edited.

-- --- Q3: widen outbox_events_status_check ---
-- Old: ('pending', 'processing', 'delivered', 'dead_letter', 'simulated')
-- New: + 'skipped'
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN SELECT "conname" FROM "pg_constraint"
    WHERE "conrelid" = '"outbox_events"'::regclass AND "contype" = 'c'
      AND "conname" LIKE 'outbox_events_status_check%'
  LOOP
    EXECUTE format('ALTER TABLE "outbox_events" DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_status_check"
  CHECK ("status" IN ('pending', 'processing', 'delivered', 'dead_letter', 'simulated', 'skipped'));
