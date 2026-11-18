/**
 * Storage settings (PLAN §31 / ADR-0011) — the singleton row behind
 * Settings → Storage.
 *
 * Lives at platform level (not in a feature module) because the driver
 * resolver (./driver.ts) needs it without creating a module cycle:
 * driver.ts → settings.ts, media/service.ts → settings.ts + driver.ts.
 *
 * Storage: a singleton `storage_settings` row (id "default"), migration
 * 0012. `driver` is `r2` (default — the only driver on Workers) or
 * `local` (Docker/VPS filesystem root). `local_path` is the root
 * directory for the Local driver; empty means the default
 * (`./data/media`, or `STORAGE_LOCAL_PATH` when set).
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storageSettings } from "../../../../../db/schema/media.ts";
import * as schema from "../../../../../db/schema/index.ts";
import { AppError } from "../../shared/errors.ts";

export type StorageSettingsDb = NodePgDatabase<typeof schema>;

export const STORAGE_SETTINGS_ID = "default";

export type StorageDriverName = "r2" | "local";

export interface StorageSettingsView {
  driver: StorageDriverName;
  local_path: string | null;
  updated_at: string;
}

export const DEFAULT_STORAGE_SETTINGS: StorageSettingsView = {
  driver: "r2",
  local_path: null,
  updated_at: new Date(0).toISOString(),
};

function viewOf(row: typeof storageSettings.$inferSelect): StorageSettingsView {
  return {
    driver: row.driver === "local" ? "local" : "r2",
    local_path: row.localPath,
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function loadStorageSettings(
  db: StorageSettingsDb,
): Promise<StorageSettingsView | null> {
  const rows = await db
    .select()
    .from(storageSettings)
    .where(eq(storageSettings.id, STORAGE_SETTINGS_ID))
    .limit(1);
  const row = rows[0];
  return row ? viewOf(row) : null;
}

export interface SaveStorageSettingsInput {
  driver?: StorageDriverName;
  /** Null clears the stored path (falls back to env/default). */
  local_path?: string | null;
}

export function validateStorageSettingsInput(input: SaveStorageSettingsInput): void {
  if (input.driver !== undefined && input.driver !== "r2" && input.driver !== "local") {
    throw new AppError("VALIDATION_ERROR", "driver must be 'r2' or 'local'.", 422);
  }
  if (input.local_path !== undefined && input.local_path !== null) {
    const p = input.local_path.trim();
    if (p.length === 0 || p.length > 500) {
      throw new AppError(
        "VALIDATION_ERROR",
        "local_path must be 1–500 characters (or empty to use the default).",
        422,
      );
    }
    if (p.includes("..")) {
      throw new AppError("VALIDATION_ERROR", "local_path must not contain '..'.", 422);
    }
  }
}

/** Upsert the singleton row. Only the fields present in `input` change. */
export async function saveStorageSettings(
  db: StorageSettingsDb,
  input: SaveStorageSettingsInput,
): Promise<StorageSettingsView> {
  validateStorageSettingsInput(input);
  const existing = await loadStorageSettings(db);
  const next = {
    driver: input.driver ?? existing?.driver ?? "r2",
    localPath:
      input.local_path === undefined
        ? existing?.local_path ?? null
        : input.local_path === null
          ? null
          : input.local_path.trim(),
    updatedAt: new Date(),
  };
  if (existing) {
    await db
      .update(storageSettings)
      .set(next)
      .where(eq(storageSettings.id, STORAGE_SETTINGS_ID));
  } else {
    await db.insert(storageSettings).values({ id: STORAGE_SETTINGS_ID, ...next });
  }
  const saved = await loadStorageSettings(db);
  if (!saved) {
    throw new AppError("INTERNAL_ERROR", "Storage settings could not be saved.", 500);
  }
  return saved;
}
