/**
 * Payment reminder rules (ADR-0009, Settings → Email).
 *
 * Days-before-due offsets (default [7, 1]) and overdue offsets (default
 * [1, 3], toggleable) apply to installments (against due_date) and to
 * subscriptions (against current_period_end, i.e. renewal reminders).
 * Stored as a singleton `reminder_settings` row (id "default", migration
 * 0009) — the general_settings singleton pattern: direct-Drizzle reads and
 * writes, load-only state (no SyncSpec), exactly like two_factor_policy.
 * Each reminder is sent once per (kind, reference_id, offset_days) —
 * tracked in `sent_reminders` (unique index enforces it).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ReminderSettingsSchema, DEFAULT_REMINDER_SETTINGS } from "../../../../../packages/contracts/src/index.ts";
import { reminderSettings } from "../../../../../db/schema/reminders.ts";
import * as schema from "../../../../../db/schema/index.ts";
import type {
  DatabaseState,
  ReminderSettingsRecord,
  SentReminderKind,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";

export type RemindersDb = NodePgDatabase<typeof schema>;

export const REMINDER_SETTINGS_ID = "default";

export interface ReminderSettingsView {
  due_offsets_days: number[];
  overdue_offsets_days: number[];
  overdue_enabled: boolean;
  updated_at: string | null;
}

export function reminderSettingsViewOf(
  row: typeof reminderSettings.$inferSelect | ReminderSettingsRecord | null
): ReminderSettingsView {
  if (!row) {
    return {
      due_offsets_days: [...DEFAULT_REMINDER_SETTINGS.due_offsets_days],
      overdue_offsets_days: [...DEFAULT_REMINDER_SETTINGS.overdue_offsets_days],
      overdue_enabled: DEFAULT_REMINDER_SETTINGS.overdue_enabled,
      updated_at: null,
    };
  }
  // Drizzle row (camelCase) vs state record (snake_case) — accept both.
  const r = row as unknown as Record<string, unknown>;
  const due = (r.due_offsets_days ?? r.dueOffsetsDays) as number[] | null;
  const overdue = (r.overdue_offsets_days ?? r.overdueOffsetsDays) as number[] | null;
  const enabled = (r.overdue_enabled ?? r.overdueEnabled) as boolean | null;
  return {
    due_offsets_days: due ?? [...DEFAULT_REMINDER_SETTINGS.due_offsets_days],
    overdue_offsets_days: overdue ?? [...DEFAULT_REMINDER_SETTINGS.overdue_offsets_days],
    overdue_enabled: enabled ?? DEFAULT_REMINDER_SETTINGS.overdue_enabled,
    updated_at: (r.updated_at ?? r.updatedAt) as string | null,
  };
}

export async function loadReminderSettingsRow(
  db: RemindersDb
): Promise<typeof reminderSettings.$inferSelect | null> {
  const rows = await db
    .select()
    .from(reminderSettings)
    .where(eq(reminderSettings.id, REMINDER_SETTINGS_ID))
    .limit(1);
  return rows[0] ?? null;
}

export async function saveReminderSettings(
  db: RemindersDb,
  rawInput: unknown
): Promise<ReminderSettingsView> {
  const input = ReminderSettingsSchema.parse(rawInput);
  const now = new Date().toISOString();
  const existing = await loadReminderSettingsRow(db);
  if (existing) {
    await db
      .update(reminderSettings)
      .set({
        dueOffsetsDays: [...input.due_offsets_days],
        overdueOffsetsDays: [...input.overdue_offsets_days],
        overdueEnabled: input.overdue_enabled,
        updatedAt: new Date(now),
      })
      .where(eq(reminderSettings.id, REMINDER_SETTINGS_ID));
  } else {
    await db.insert(reminderSettings).values({
      id: REMINDER_SETTINGS_ID,
      dueOffsetsDays: [...input.due_offsets_days],
      overdueOffsetsDays: [...input.overdue_offsets_days],
      overdueEnabled: input.overdue_enabled,
      updatedAt: new Date(now),
    });
  }
  const saved = await loadReminderSettingsRow(db);
  if (!saved) throw new AppError("INTERNAL_ERROR", "Reminder settings could not be saved.", 500);
  return reminderSettingsViewOf(saved);
}

// -- In-state helpers (the sweep works on DatabaseState) -----------------------

export function getReminderSettings(state: DatabaseState): ReminderSettingsView {
  const row = state.reminder_settings.find((r) => r.id === REMINDER_SETTINGS_ID) ?? null;
  return reminderSettingsViewOf(row);
}

export function hasSentReminder(
  state: DatabaseState,
  kind: SentReminderKind,
  referenceId: string,
  offsetDays: number
): boolean {
  return state.sent_reminders.some(
    (r) => r.kind === kind && r.reference_id === referenceId && r.offset_days === offsetDays
  );
}

export function markReminderSentInTx(
  state: DatabaseState,
  kind: SentReminderKind,
  referenceId: string,
  offsetDays: number,
  nowIso: string
): void {
  if (hasSentReminder(state, kind, referenceId, offsetDays)) return;
  state.sent_reminders.push({
    id: randomUUID(),
    kind,
    reference_id: referenceId,
    offset_days: offsetDays,
    sent_at: nowIso,
  });
}
