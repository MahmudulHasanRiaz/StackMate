import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, unique, index } from "drizzle-orm/pg-core";

// Migration 0009: payment reminder rules (ADR-0009).
//
// SINGLETON row (id "default"), same pattern as general_settings
// (migration 0008): the admin edits the offsets in Settings → Email and
// the renewal/expiry sweep reads them from the store state (loaded
// read-only, like two_factor_policy — written only through the reminder
// settings service's direct Drizzle calls, never via withTransaction).
//
//   due_offsets_days ..... days BEFORE a due date to remind, e.g. [7, 1]
//   overdue_offsets_days . days AFTER a missed due date, e.g. [1, 3]
//   overdue_enabled ...... master toggle for the overdue reminders
export const reminderSettings = pgTable("reminder_settings", {
  id: text("id").primaryKey(),
  dueOffsetsDays: jsonb("due_offsets_days").notNull().default([7, 1]),
  overdueOffsetsDays: jsonb("overdue_offsets_days").notNull().default([1, 3]),
  overdueEnabled: boolean("overdue_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per reminder actually sent — idempotency for the sweep: a
// (kind, reference, offset) triple is sent at most once.
export const sentReminders = pgTable(
  "sent_reminders",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(), // installment_due | installment_overdue | subscription_renewal | subscription_overdue
    referenceId: uuid("reference_id").notNull(),
    offsetDays: integer("offset_days").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_sent_reminders_kind_ref_offset").on(
      table.kind,
      table.referenceId,
      table.offsetDays
    ),
    index("idx_sent_reminders_reference").on(table.referenceId, table.sentAt.desc()),
  ]
);
