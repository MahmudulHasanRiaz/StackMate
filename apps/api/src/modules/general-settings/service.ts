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
import { sanitizeSvgText } from "../../platform/storage/media-validation.ts";
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

/**
 * B-14: module-level 30s cache for the singleton row, mirroring the
 * auth-config pattern exactly (same TTL, same optional-cacheKey
 * shape). The row is read on ~every request (app name, title,
 * favicon) and changes only via the admin panel, so a 30s stale
 * window is safe — and any save invalidates immediately.
 * Cache key: the caller passes one (e.g. the Hyperdrive connection
 * string, as auth-config does) when the DB handle is per-request;
 * without a key every load hits the DB, exactly as before.
 */
const GENERAL_SETTINGS_CACHE_TTL_MS = 30_000;
const generalSettingsCache = new Map<
  string,
  { row: typeof generalSettings.$inferSelect | null; at: number }
>();

export function invalidateGeneralSettingsCache(cacheKey?: string): void {
  if (cacheKey === undefined) {
    generalSettingsCache.clear();
    return;
  }
  generalSettingsCache.delete(cacheKey);
}

export async function loadGeneralSettings(
  db: GeneralSettingsDb,
  cacheKey?: string
): Promise<typeof generalSettings.$inferSelect | null> {
  if (cacheKey !== undefined) {
    const hit = generalSettingsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < GENERAL_SETTINGS_CACHE_TTL_MS) return hit.row;
  }
  const rows = await db
    .select()
    .from(generalSettings)
    .where(eq(generalSettings.id, GENERAL_SETTINGS_ID))
    .limit(1);
  const row = rows[0] ?? null;
  if (cacheKey !== undefined) {
    generalSettingsCache.set(cacheKey, { row, at: Date.now() });
  }
  return row;
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
  input: SaveGeneralSettingsInput,
  cacheKey?: string
): Promise<GeneralSettingsView> {
  validateGeneralSettingsInput(input);
  const existing = await loadGeneralSettings(db, cacheKey);
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
  // B-14: the saved row must be visible on the very next load — never
  // serve the pre-save cached row. The re-read below is uncached.
  invalidateGeneralSettingsCache(cacheKey);
  const saved = await loadGeneralSettings(db);
  if (!saved) throw new AppError("INTERNAL_ERROR", "General settings could not be saved.", 500);
  return viewOf(saved);
}

/**
 * Validate favicon bytes against the declared MIME type. PNG and ICO are
 * checked by magic bytes; SVG is XML text — it must parse as a
 * well-formed SVG document (parser-based `sanitizeSvgText`, full
 * document, not a prefix scan) and must not contain active content.
 *
 * The sanitizer DROPS disallowed elements/attributes silently, so a
 * document that needed dropping is rejected outright instead of stored
 * as-is: the stored bytes are the original upload, and a `<script>`
 * past byte 2048 (or an `onload` handler, or a `javascript:` link)
 * must never reach R2. (Audit L-9: the old code decoded only the first
 * 2048 bytes and checked only `<script>`.)
 *
 * A-16: returns the bytes to STORE — for SVG the SANITIZED bytes from
 * `sanitizeSvgText` (as media uploads do), never the original upload.
 * The active-content regex gate runs on the ORIGINAL text (so an
 * upload carrying a handler is rejected, not silently cleaned) and
 * matches a handler after ANY separator (`<svg/onload=…>` and
 * `<animate/onbegin=…>` evaded the old whitespace-only gate).
 */
export function verifyFaviconBytes(bytes: Uint8Array, declaredMimeType: string): Uint8Array {
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
    return bytes;
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
    return bytes;
  }
  // image/svg+xml — decode the FULL bytes and run the parser-based
  // sanitizer: it throws (415) unless the document is well-formed XML
  // with an <svg> root. The sanitizer drops disallowed content
  // silently, so active content is rejected explicitly below — and the
  // STORED bytes are the sanitized text (A-16), never the original
  // upload.
  //
  // A leading XML declaration (`<?xml version="1.0" …?>`) is stripped
  // first: the shared parser rejects EVERY declaration today
  // (media-validation.ts checks `text.slice(pos, end).includes("<")`,
  // which always includes the `<?xml` opener itself — the parent's
  // remainder to fix there). The declaration carries no active content
  // (version/encoding only); the rest of the document still goes
  // through the full parser. A `<?xml-stylesheet …?>` processing
  // instruction is NOT stripped (the regex requires whitespace or `?>`
  // right after `<?xml`) and is still rejected by the parser.
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/^\uFEFF?<\?xml(?:\s[^>]*)?\?>\s*/, "");
  // A-16: reject active content on the ORIGINAL text, with a separator
  // class that also catches `<svg/onload=…>` / `<animate/onbegin=…>`
  // (the old `\s` gate let a `/` separator through).
  if (
    /<script[\s>]/i.test(text) ||
    /<\/script>/i.test(text) ||
    /<foreignObject[\s>]/i.test(text) ||
    /(?:[\s\/'"`]|^)on[a-z]+\s*=/i.test(text) ||
    /javascript\s*:/i.test(text)
  ) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      "SVG favicons must not contain scripts, event handlers, or script URLs.",
      415
    );
  }
  // A-16: store the SANITIZED bytes, never the original upload.
  return new TextEncoder().encode(sanitizeSvgText(text));
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
  },
  cacheKey?: string
): Promise<{ favicon_url: string; content_type: string; byte_size: number }> {
  if (input.bytes.byteLength > MAX_FAVICON_BYTES) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `Favicon exceeds the maximum allowed size of ${MAX_FAVICON_BYTES} bytes.`,
      413
    );
  }
  // A-16: store the bytes verifyFaviconBytes returns — sanitized for
  // SVG, the upload itself otherwise. The content-hash key below must
  // hash the STORED bytes, so a re-upload of the same SVG hits the
  // same key.
  const bytesToStore = verifyFaviconBytes(input.bytes, input.contentType);
  const mime = input.contentType.trim().toLowerCase();
  const key = `branding/favicon-${sha256Hex(bytesToStore)}.${faviconExtension(mime)}`;
  const stored = await storeValidatedPrivateObject({
    driver,
    bucketName: input.bucketName,
    objectKey: key,
    originalFilename: input.filename,
    contentType: mime,
    bytes: bytesToStore,
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
  // B-14: a new favicon changes the row — invalidate the cache.
  invalidateGeneralSettingsCache(cacheKey);
  return {
    favicon_url: "/api/v1/favicon",
    content_type: stored.contentType,
    byte_size: stored.byteSize,
  };
}
