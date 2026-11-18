/**
 * General (app-wide) settings service (Auth + Email batch, 2026-11-16).
 *
 * Settings → General holds the app-wide configuration: App Name, App
 * Title, Favicon, App Description, Support Email. Every value renders
 * somewhere visible — no dead stored values. The config is read by the
 * public GET /api/v1/general-config endpoint (same pattern as the auth
 * config endpoint) and applied by the SPA at boot: document.title,
 * sidebar/topbar brand, favicon link, login-page tagline + support
 * contact.
 *
 * Storage: a singleton `general_settings` row (id "default"), migration
 * 0008. The favicon bytes live in R2 under a server-side key
 * (`branding/favicon-<sha256>.<ext>`) — only the object key, content
 * type, and size are stored here; the public GET /api/v1/favicon
 * endpoint streams the object back. No data URLs.
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { generalSettings } from "../../../../../db/schema/general-settings.ts";
import * as schema from "../../../../../db/schema/index.ts";
import { AppError } from "../../shared/errors.ts";
import { sha256Hex } from "../../platform/crypto/index.ts";
import { storeValidatedPrivateObject } from "../../platform/storage/driver.ts";
import type { StorageDriver } from "../../platform/storage/driver.ts";

export type GeneralSettingsDb = NodePgDatabase<typeof schema>;

export const GENERAL_SETTINGS_ID = "default";

export const DEFAULT_GENERAL_SETTINGS = {
  app_name: "StackMate",
  app_title: "StackMate Admin",
  app_description: "",
  support_email: "",
  favicon_url: null as string | null,
} as const;

export interface GeneralSettingsView {
  app_name: string;
  app_title: string;
  app_description: string;
  support_email: string;
  /** Public URL for the favicon, or null when no favicon is uploaded. */
  favicon_url: string | null;
  favicon_content_type: string | null;
  favicon_byte_size: number | null;
}

export const MAX_FAVICON_BYTES = 256 * 1024; // 256 KB

export const ALLOWED_FAVICON_MIME_TYPES = new Set([
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function viewOf(row: typeof generalSettings.$inferSelect): GeneralSettingsView {
  return {
    app_name: row.appName,
    app_title: row.appTitle,
    app_description: row.appDescription,
    support_email: row.supportEmail,
    favicon_url: row.faviconObjectKey ? "/api/v1/favicon" : null,
    favicon_content_type: row.faviconContentType,
    favicon_byte_size: row.faviconByteSize,
  };
}

/** Public view: no favicon metadata, just the URL the browser needs. */
export function publicViewOf(row: typeof generalSettings.$inferSelect | null): {
  app_name: string;
  app_title: string;
  app_description: string;
  support_email: string;
  favicon_url: string | null;
} {
  if (!row) return { ...DEFAULT_GENERAL_SETTINGS };
  const v = viewOf(row);
  return {
    app_name: v.app_name,
    app_title: v.app_title,
    app_description: v.app_description,
    support_email: v.support_email,
    favicon_url: v.favicon_url,
  };
}

export async function loadGeneralSettings(
  db: GeneralSettingsDb
): Promise<typeof generalSettings.$inferSelect | null> {
  const rows = await db
    .select()
    .from(generalSettings)
    .where(eq(generalSettings.id, GENERAL_SETTINGS_ID))
    .limit(1);
  return rows[0] ?? null;
}

export interface SaveGeneralSettingsInput {
  app_name?: string;
  app_title?: string;
  app_description?: string;
  support_email?: string;
  /** When true, the stored favicon is removed (object key cleared). */
  clear_favicon?: boolean;
}

function validateGeneralSettingsInput(input: SaveGeneralSettingsInput): void {
  if (input.app_name !== undefined) {
    const name = input.app_name.trim();
    if (name.length < 1 || name.length > 120) {
      throw new AppError(
        "VALIDATION_ERROR",
        "App name must be 1–120 characters.",
        422
      );
    }
  }
  if (input.app_title !== undefined) {
    const title = input.app_title.trim();
    if (title.length < 1 || title.length > 120) {
      throw new AppError(
        "VALIDATION_ERROR",
        "App title must be 1–120 characters.",
        422
      );
    }
  }
  if (input.app_description !== undefined) {
    if (input.app_description.length > 500) {
      throw new AppError(
        "VALIDATION_ERROR",
        "App description must be at most 500 characters.",
        422
      );
    }
  }
  if (input.support_email !== undefined) {
    const email = input.support_email.trim();
    if (email !== "" && !EMAIL_RE.test(email)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Support email must be a valid email address (or empty).",
        422
      );
    }
  }
}

/**
 * Upsert the singleton row. Only the fields present in `input` change;
 * absent fields keep their stored value. Returns the saved view.
 */
export async function saveGeneralSettings(
  db: GeneralSettingsDb,
  input: SaveGeneralSettingsInput
): Promise<GeneralSettingsView> {
  validateGeneralSettingsInput(input);
  const existing = await loadGeneralSettings(db);
  const next = {
    appName:
      input.app_name !== undefined
        ? input.app_name.trim()
        : existing?.appName ?? "StackMate",
    appTitle:
      input.app_title !== undefined
        ? input.app_title.trim()
        : existing?.appTitle ?? "StackMate Admin",
    appDescription:
      input.app_description !== undefined
        ? input.app_description
        : existing?.appDescription ?? "",
    supportEmail:
      input.support_email !== undefined
        ? input.support_email.trim()
        : existing?.supportEmail ?? "",
    faviconObjectKey:
      input.clear_favicon === true
        ? null
        : existing?.faviconObjectKey ?? null,
    faviconContentType:
      input.clear_favicon === true
        ? null
        : existing?.faviconContentType ?? null,
    faviconByteSize:
      input.clear_favicon === true ? null : existing?.faviconByteSize ?? null,
    updatedAt: new Date(),
  };
  if (existing) {
    await db
      .update(generalSettings)
      .set(next)
      .where(eq(generalSettings.id, GENERAL_SETTINGS_ID));
  } else {
    await db.insert(generalSettings).values({ id: GENERAL_SETTINGS_ID, ...next });
  }
  const saved = await loadGeneralSettings(db);
  if (!saved) throw new AppError("INTERNAL_ERROR", "General settings could not be saved.", 500);
  return viewOf(saved);
}

/**
 * Validate favicon bytes against the declared MIME type. PNG and ICO are
 * checked by magic bytes; SVG is XML text — it must start as SVG markup
 * and must not contain a script element (an SVG served as an image does
 * not execute scripts, but a stored `<script>` in a same-origin-served
 * file is not something we will ever store).
 */
export function verifyFaviconBytes(bytes: Uint8Array, declaredMimeType: string): void {
  const mime = declaredMimeType.trim().toLowerCase();
  if (!ALLOWED_FAVICON_MIME_TYPES.has(mime)) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      `Unsupported favicon type '${declaredMimeType}'. Allowed: PNG, ICO, SVG.`,
      415
    );
  }
  if (bytes.byteLength === 0) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Uploaded favicon is empty.", 415);
  }
  if (mime === "image/png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!sig.every((b, idx) => bytes[idx] === b)) {
      throw new AppError("UNSUPPORTED_MEDIA_TYPE", "File signature does not match PNG format.", 415);
    }
    return;
  }
  if (mime === "image/x-icon" || mime === "image/vnd.microsoft.icon") {
    // ICO: 00 00 01 00 (icon) or 00 00 02 00 (cursor).
    const isIcon =
      bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00;
    const isCursor =
      bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x02 && bytes[3] === 0x00;
    if (!isIcon && !isCursor) {
      throw new AppError("UNSUPPORTED_MEDIA_TYPE", "File signature does not match ICO format.", 415);
    }
    return;
  }
  // image/svg+xml
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 2048))
    .trimStart();
  const isSvg =
    text.startsWith("<svg") || text.startsWith("<?xml");
  if (!isSvg || !text.includes("<svg")) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "File does not look like SVG markup.", 415);
  }
  if (/<script[\s>]/i.test(text) || /<\/script>/i.test(text)) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "SVG favicons must not contain scripts.", 415);
  }
}

function faviconExtension(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/svg+xml") return "svg";
  return "ico";
}

/**
 * Store an uploaded favicon in R2 (reusing the validated-private-object
 * pattern) and point the singleton row at it. The object key is
 * server-side derived from the content hash — never user-supplied.
 * Returns the public view fields for the favicon.
 */
export async function storeFavicon(
  db: GeneralSettingsDb,
  driver: StorageDriver,
  input: {
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    bucketName: string;
  }
): Promise<{ favicon_url: string; content_type: string; byte_size: number }> {
  if (input.bytes.byteLength > MAX_FAVICON_BYTES) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `Favicon exceeds the maximum allowed size of ${MAX_FAVICON_BYTES} bytes.`,
      413
    );
  }
  verifyFaviconBytes(input.bytes, input.contentType);
  const mime = input.contentType.trim().toLowerCase();
  const key = `branding/favicon-${sha256Hex(input.bytes)}.${faviconExtension(mime)}`;
  const stored = await storeValidatedPrivateObject({
    driver,
    bucketName: input.bucketName,
    objectKey: key,
    originalFilename: input.filename,
    contentType: mime,
    bytes: input.bytes,
    maxBytes: MAX_FAVICON_BYTES,
  });
  const existing = await loadGeneralSettings(db);
  const next = {
    appName: existing?.appName ?? "StackMate",
    appTitle: existing?.appTitle ?? "StackMate Admin",
    appDescription: existing?.appDescription ?? "",
    supportEmail: existing?.supportEmail ?? "",
    faviconObjectKey: stored.objectKey,
    faviconContentType: stored.contentType,
    faviconByteSize: stored.byteSize,
    updatedAt: new Date(),
  };
  if (existing) {
    await db
      .update(generalSettings)
      .set(next)
      .where(eq(generalSettings.id, GENERAL_SETTINGS_ID));
  } else {
    await db.insert(generalSettings).values({ id: GENERAL_SETTINGS_ID, ...next });
  }
  return {
    favicon_url: "/api/v1/favicon",
    content_type: stored.contentType,
    byte_size: stored.byteSize,
  };
}
