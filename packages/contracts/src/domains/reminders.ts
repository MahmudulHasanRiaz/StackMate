import { v } from "../common/validator.ts";

// Payment reminder rules (ADR-0009). Stored in the `reminder_settings`
// singleton; edited in Settings → Email; read by the renewal/expiry sweep.
// Offsets are whole days: due offsets count BACK from the due date
// (default [7, 1] — remind 7 days and 1 day before); overdue offsets count
// FORWARD from the missed due date (default [1, 3]).
export const ReminderSettingsSchema = v.object({
  due_offsets_days: v.array(v.number().int().min(0).max(90), { min: 0, max: 10 }),
  overdue_offsets_days: v.array(v.number().int().min(0).max(90), { min: 0, max: 10 }),
  overdue_enabled: v.boolean(),
});

export const DEFAULT_REMINDER_SETTINGS = {
  due_offsets_days: [7, 1],
  overdue_offsets_days: [1, 3],
  overdue_enabled: true,
} as const;
