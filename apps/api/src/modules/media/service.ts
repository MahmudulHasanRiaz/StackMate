/**
 * Media library service (PLAN §31 / ADR-0011).
 *
 * Library files are private objects in the SELECTED storage driver
 * (R2 by default, Local on Docker/VPS). Each row stores its OWN
 * driver, so reads always use the row's driver and a driver switch
 * never orphans library files. The API never returns raw storage
 * keys or public URLs — downloads go through the authenticated
 * content endpoint (`GET /api/v1/admin/media/:id/content`).
 *
 * Uploads are multipart FormData on the route (not base64 JSON —
 * files can be 100 MB). Validation is `verifyMediaBytes`
 * (allowlist + magic bytes + SVG sanitize); the STORED bytes are the
 * verified bytes (sanitized for SVG).
 *
 * Delete order: row first, then the object (best-effort). A failed
 * object delete after the row is gone leaves an orphaned invisible
 * object; a failed row delete after the object is gone would leave a
 * user-visible row pointing at nothing. The audit log records the
 * delete either way.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { mediaAssets } from "../../../../../db/schema/media.ts";
import * as schema from "../../../../../db/schema/index.ts";
import { AppError } from "../../shared/errors.ts";
import { sha256Hex } from "../../platform/crypto/index.ts";
import {
  resolveStorageDriver,
  type DriverDeps,
  type StorageDriverName,
} from "../../platform/storage/driver.ts";
import {
  MAX_MEDIA_BYTES,
  MAX_THUMBNAIL_BYTES,
  MEDIA_ALLOWED_MIME,
  mediaKindOfMime,
  mediaObjectKey,
  mediaThumbnailKey,
  normalizeFilename,
  normalizeFolder,
  normalizeTags,
  verifyMediaBytes,
  verifyThumbnailBytes,
  type MediaKind,
} from "../../platform/storage/media-validation.ts";
import type {
  MediaAssetView,
  MediaListResponse,
} from "../../../../../packages/contracts/src/index.ts";

export type MediaDb = NodePgDatabase<typeof schema>;

export const MEDIA_LIST_DEFAULT_LIMIT = 50;
export const MEDIA_LIST_MAX_LIMIT = 100;

const KIND_MIMES: Record<MediaKind, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"],
  video: ["video/mp4", "video/webm"],
  audio: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg"],
  document: ["application/pdf"],
  archive: ["application/zip", "application/x-zip-compressed"],
  other: ["text/plain", "text/csv"],
};

export function mediaViewOf(row: typeof mediaAssets.$inferSelect): MediaAssetView {
  return {
    id: row.id,
    original_filename: row.originalFilename,
    mime_type: row.mimeType,
    kind: mediaKindOfMime(row.mimeType) ?? "other",
    byte_size: Number(row.byteSize),
    checksum_sha256: row.checksumSha256,
    width: row.width,
    height: row.height,
    folder: row.folder,
    tags: [...row.tags],
    driver: row.driver === "local" ? "local" : "r2",
    uploaded_by_user_id: row.uploadedByUserId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    content_url: `/api/v1/admin/media/${row.id}/content`,
    // Thumbnails are opt-in per row: null means "no thumbnail yet"
    // (pre-0013 upload, or the browser could not generate one) and
    // the UI falls back to content_url — never a broken image.
    thumb_url:
      row.thumbObjectKey !== null
        ? `/api/v1/admin/media/${row.id}/content?variant=thumb`
        : null,
    thumb_small_url:
      row.thumbSmallObjectKey !== null
        ? `/api/v1/admin/media/${row.id}/content?variant=small`
        : null,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export interface MediaListParams {
  // `| undefined`: exactOptionalPropertyTypes — app.ts passes
  // `parsed.q` etc. through, which are `T | undefined`.
  q?: string | undefined;
  kind?: MediaKind | undefined;
  folder?: string | undefined;
  /** Exact MIME types to include (allowlisted only — anything else is a 422). */
  mimes?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export function clampMediaListParams(params: MediaListParams): {
  q: string;
  kind: MediaKind | undefined;
  folder: string | undefined;
  mimes: string[] | undefined;
  limit: number;
  offset: number;
} {
  const q = (params.q ?? "").trim();
  let kind: MediaKind | undefined;
  if (params.kind !== undefined) {
    if (!(params.kind in KIND_MIMES)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `kind must be one of: ${Object.keys(KIND_MIMES).join(", ")}.`,
        422,
      );
    }
    kind = params.kind;
  }
  let mimes: string[] | undefined;
  if (params.mimes !== undefined) {
    mimes = params.mimes.map((m) => m.trim().toLowerCase()).filter(Boolean);
    const bad = mimes.find((m) => !(m in MEDIA_ALLOWED_MIME));
    if (bad !== undefined) {
      throw new AppError("VALIDATION_ERROR", `mime '${bad}' is not a supported media type.`, 422);
    }
    if (mimes.length === 0) mimes = undefined;
  }
  const folder =
    params.folder === undefined ? undefined : normalizeFolder(params.folder);
  const limit = Math.min(
    MEDIA_LIST_MAX_LIMIT,
    Math.max(1, Math.floor(params.limit ?? MEDIA_LIST_DEFAULT_LIMIT) || MEDIA_LIST_DEFAULT_LIMIT),
  );
  const offset = Math.max(0, Math.floor(params.offset ?? 0) || 0);
  return { q, kind, folder, mimes, limit, offset };
}

/**
 * Server-side list over the FULL media_assets dataset (owner hard
 * rule, PLAN §29): `q` matches filename (substring, case-insensitive)
 * OR any tag; `kind` and `folder` filter server-side too. `limit`
 * caps AFTER filtering — a match at row 500 is found.
 */
export async function listMediaAssets(
  db: MediaDb,
  params: MediaListParams,
): Promise<MediaListResponse> {
  const { q, kind, folder, mimes, limit, offset } = clampMediaListParams(params);
  const conditions: SQL[] = [];
  if (q !== "") {
    const like = `%${escapeLikePattern(q)}%`;
    const match = or(
      ilike(mediaAssets.originalFilename, like),
      sql`EXISTS (SELECT 1 FROM unnest(${mediaAssets.tags}) AS t WHERE t ILIKE ${like})`,
    );
    if (match) conditions.push(match);
  }
  if (kind !== undefined) {
    conditions.push(inArray(mediaAssets.mimeType, [...KIND_MIMES[kind]]));
  }
  if (mimes !== undefined) {
    conditions.push(inArray(mediaAssets.mimeType, mimes));
  }
  if (folder !== undefined) {
    conditions.push(eq(mediaAssets.folder, folder));
  }
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(mediaAssets)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(where)
    .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id))
    .limit(limit)
    .offset(offset);
  return { items: rows.map(mediaViewOf), total, limit, offset };
}

export async function getMediaAsset(
  db: MediaDb,
  id: string,
): Promise<typeof mediaAssets.$inferSelect | null> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireMediaAsset(
  db: MediaDb,
  id: string,
): Promise<typeof mediaAssets.$inferSelect> {
  const row = await getMediaAsset(db, id);
  if (!row) throw new AppError("NOT_FOUND", "Media asset not found.", 404);
  return row;
}

export interface MediaUploadInput {
  bytes: Uint8Array;
  declaredMimeType: string;
  filename: string;
  folder?: string | undefined;
  tags?: string[] | undefined;
  /**
   * Browser-generated thumbnails (PLAN §34 / ADR-0012): 320px (`thumb`)
   * + 64px (`small`) WebP variants, generated in the SPA at upload.
   * Each is validated as WebP before storing; a bad thumbnail is
   * DROPPED (the original upload never fails because of it) — the
   * row simply has no thumbnail and the UI falls back to the original.
   */
  thumbnails?: {
    thumb?: { bytes: Uint8Array; declaredMimeType: string } | undefined;
    small?: { bytes: Uint8Array; declaredMimeType: string } | undefined;
  } | undefined;
}

/** Raster image MIMEs the browser generates thumbnails for (never SVG — vector, served as-is). */
const THUMBNAILABLE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * Validate + store one thumbnail variant. Returns the stored key +
 * size, or null when there is nothing to store (no input, wrong
 * original kind, or validation failed — the caller never fails the
 * upload over a thumbnail).
 *
 * L-11: a bad thumbnail is DROPPED, but the drop is now LOGGED (the
 * old code swallowed it silently, so nobody could tell a broken
 * browser thumbnail generator from a healthy upload). The log line
 * carries the variant, the reason, and the size — never file bytes.
 */
async function storeThumbnail(
  driver: { put(key: string, bytes: Uint8Array, contentType: string): Promise<unknown>; name: string },
  objectKey: string,
  variant: "thumb" | "small",
  input: { bytes: Uint8Array; declaredMimeType: string } | undefined,
  originalMime: string,
): Promise<{ objectKey: string; byteSize: number } | null> {
  if (!input || !THUMBNAILABLE_MIMES.has(originalMime)) return null;
  let verified;
  try {
    verified = verifyThumbnailBytes(input.bytes);
  } catch (err) {
    console.warn(
      `[media] thumbnail dropped (variant=${variant}, original=${objectKey}, ` +
        `reason=${(err as Error).message}, bytes=${input.bytes.byteLength}, cap=${MAX_THUMBNAIL_BYTES})`
    );
    return null;
  }
  const key = mediaThumbnailKey(objectKey, variant);
  try {
    await driver.put(key, verified.bytes, "image/webp");
  } catch (err) {
    console.warn(
      `[media] thumbnail dropped (variant=${variant}, original=${objectKey}, ` +
        `reason=storage put failed: ${(err as Error).message})`
    );
    return null;
  }
  return { objectKey: key, byteSize: verified.bytes.byteLength };
}

export async function uploadMediaAsset(
  db: MediaDb,
  driverDeps: DriverDeps,
  input: MediaUploadInput,
  uploadedByUserId: string | null,
): Promise<MediaAssetView> {
  const verified = verifyMediaBytes(input.bytes, input.declaredMimeType);
  const filename = normalizeFilename(input.filename);
  const folder = normalizeFolder(input.folder);
  const tags = normalizeTags(input.tags);
  const mime = input.declaredMimeType.trim().toLowerCase();
  const driver = await resolveStorageDriver(driverDeps);
  const key = mediaObjectKey(filename);
  const checksum = sha256Hex(verified.bytes);
  await driver.put(key, verified.bytes, mime);
  const thumb = await storeThumbnail(driver, key, "thumb", input.thumbnails?.thumb, mime);
  const thumbSmall = await storeThumbnail(driver, key, "small", input.thumbnails?.small, mime);
  const now = new Date();
  let rows: (typeof mediaAssets.$inferSelect)[];
  try {
    rows = await db
      .insert(mediaAssets)
      .values({
        objectKey: key,
        driver: driver.name,
        originalFilename: filename,
        mimeType: mime,
        byteSize: verified.bytes.byteLength,
        checksumSha256: checksum,
        width: verified.width,
        height: verified.height,
        thumbObjectKey: thumb?.objectKey ?? null,
        thumbSmallObjectKey: thumbSmall?.objectKey ?? null,
        thumbByteSize: thumb?.byteSize ?? null,
        thumbSmallByteSize: thumbSmall?.byteSize ?? null,
        folder,
        tags,
        uploadedByUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  } catch (err) {
    // The objects are stored but the row is not — remove the orphans rather than leak them.
    await driver.delete(key).catch(() => undefined);
    if (thumb) await driver.delete(thumb.objectKey).catch(() => undefined);
    if (thumbSmall) await driver.delete(thumbSmall.objectKey).catch(() => undefined);
    throw err;
  }
  const row = rows[0];
  if (!row) {
    await driver.delete(key).catch(() => undefined);
    if (thumb) await driver.delete(thumb.objectKey).catch(() => undefined);
    if (thumbSmall) await driver.delete(thumbSmall.objectKey).catch(() => undefined);
    throw new AppError("INTERNAL_ERROR", "Media upload failed to persist.", 500);
  }
  return mediaViewOf(row);
}

/**
 * Regenerate thumbnails for an existing image (PLAN §34 — the
 * backfill path for pre-0013 files: the admin opens the file in the
 * library and generates in the browser). Unlike the upload path, a
 * bad thumbnail IS the error here: the whole point of the call is
 * the thumbnail. Keys are derived from the original key, so a
 * regenerate overwrites the same objects — no stale keys, no extra
 * columns to update beyond key + size.
 */
export async function regenerateMediaThumbnail(
  db: MediaDb,
  driverDeps: DriverDeps,
  id: string,
  thumbnails: {
    thumb?: { bytes: Uint8Array; declaredMimeType: string } | undefined;
    small?: { bytes: Uint8Array; declaredMimeType: string } | undefined;
  },
): Promise<MediaAssetView> {
  const row = await requireMediaAsset(db, id);
  if (!THUMBNAILABLE_MIMES.has(row.mimeType)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Thumbnails are only generated for raster images (PNG, JPEG, WebP, GIF).",
      422,
    );
  }
  if (!thumbnails.thumb && !thumbnails.small) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Provide at least one thumbnail file (thumbnail and/or thumbnail_small).",
      422,
    );
  }
  const driver = await resolveStorageDriver(driverDeps, driverNameOf(row));
  // F-13: thumbnail keys are DERIVED from the original key, so a
  // regenerate overwrites the same objects. Snapshot the CURRENT
  // thumbnail bytes BEFORE overwriting: if the row update below fails,
  // the old bytes are restored, so the row's thumbByteSize still
  // matches the stored object. (The old code put first and updated
  // second with no recovery — a failed update left a stale size
  // pointing at different-sized bytes, i.e. corrupt Content-Length /
  // Range responses.) If the restore itself fails, the new keys are
  // deleted instead, leaving a clean 404 the UI falls back from.
  const previous: { thumb?: Uint8Array | undefined; small?: Uint8Array | undefined } = {};
  if (thumbnails.thumb && row.thumbObjectKey) {
    const old = await driver.get(row.thumbObjectKey).catch(() => null);
    if (old) previous.thumb = old.bytes;
  }
  if (thumbnails.small && row.thumbSmallObjectKey) {
    const old = await driver.get(row.thumbSmallObjectKey).catch(() => null);
    if (old) previous.small = old.bytes;
  }
  const restorePrevious = async (): Promise<void> => {
    if (thumbnails.thumb) {
      const key = mediaThumbnailKey(row.objectKey, "thumb");
      if (previous.thumb) {
        await driver.put(key, previous.thumb, "image/webp").catch(() =>
          driver.delete(key).catch(() => undefined)
        );
      } else {
        await driver.delete(key).catch(() => undefined);
      }
    }
    if (thumbnails.small) {
      const key = mediaThumbnailKey(row.objectKey, "small");
      if (previous.small) {
        await driver.put(key, previous.small, "image/webp").catch(() =>
          driver.delete(key).catch(() => undefined)
        );
      } else {
        await driver.delete(key).catch(() => undefined);
      }
    }
  };
  const stored: {
    thumbObjectKey?: string | null;
    thumbSmallObjectKey?: string | null;
    thumbByteSize?: number | null;
    thumbSmallByteSize?: number | null;
  } = {};
  if (thumbnails.thumb) {
    // L-11: on regenerate the thumbnail IS the request, so an oversize
    // or invalid thumbnail is a 413/415 — not a silent drop.
    const verified = verifyThumbnailBytes(thumbnails.thumb.bytes);
    const key = mediaThumbnailKey(row.objectKey, "thumb");
    await driver.put(key, verified.bytes, "image/webp");
    stored.thumbObjectKey = key;
    stored.thumbByteSize = verified.bytes.byteLength;
  }
  if (thumbnails.small) {
    const verified = verifyThumbnailBytes(thumbnails.small.bytes);
    const key = mediaThumbnailKey(row.objectKey, "small");
    await driver.put(key, verified.bytes, "image/webp");
    stored.thumbSmallObjectKey = key;
    stored.thumbSmallByteSize = verified.bytes.byteLength;
  }
  let updated;
  try {
    updated = await db
      .update(mediaAssets)
      .set({ ...stored, updatedAt: new Date() })
      .where(eq(mediaAssets.id, row.id))
      .returning();
  } catch (err) {
    await restorePrevious();
    throw err;
  }
  const saved = updated[0];
  if (!saved) {
    await restorePrevious();
    throw new AppError("INTERNAL_ERROR", "Media thumbnail update failed to persist.", 500);
  }
  return mediaViewOf(saved);
}

export async function renameMediaAsset(
  db: MediaDb,
  id: string,
  filename: string,
): Promise<MediaAssetView> {
  const row = await requireMediaAsset(db, id);
  const next = normalizeFilename(filename);
  const updated = await db
    .update(mediaAssets)
    .set({ originalFilename: next, updatedAt: new Date() })
    .where(eq(mediaAssets.id, row.id))
    .returning();
  const saved = updated[0];
  if (!saved) throw new AppError("INTERNAL_ERROR", "Media rename failed to persist.", 500);
  return mediaViewOf(saved);
}

export async function moveMediaAsset(
  db: MediaDb,
  id: string,
  folder: string,
): Promise<MediaAssetView> {
  const row = await requireMediaAsset(db, id);
  const next = normalizeFolder(folder);
  const updated = await db
    .update(mediaAssets)
    .set({ folder: next, updatedAt: new Date() })
    .where(eq(mediaAssets.id, row.id))
    .returning();
  const saved = updated[0];
  if (!saved) throw new AppError("INTERNAL_ERROR", "Media move failed to persist.", 500);
  return mediaViewOf(saved);
}

export async function setMediaAssetTags(
  db: MediaDb,
  id: string,
  tags: unknown,
): Promise<MediaAssetView> {
  const row = await requireMediaAsset(db, id);
  const next = normalizeTags(tags);
  const updated = await db
    .update(mediaAssets)
    .set({ tags: next, updatedAt: new Date() })
    .where(eq(mediaAssets.id, row.id))
    .returning();
  const saved = updated[0];
  if (!saved) throw new AppError("INTERNAL_ERROR", "Media tag update failed to persist.", 500);
  return mediaViewOf(saved);
}

/** Row first, then the object (best-effort — see module header). */
/** The `driver` column is plain text in Drizzle's row type — narrow it
 * to the driver-name union before resolving (reads always use the row's
 * own driver, so an unexpected value falls back to R2, never crashes). */
function driverNameOf(row: { driver: string }): StorageDriverName {
  return row.driver === "local" ? "local" : "r2";
}

export async function deleteMediaAsset(
  db: MediaDb,
  driverDeps: DriverDeps,
  id: string,
): Promise<void> {
  const row = await requireMediaAsset(db, id);
  await db.delete(mediaAssets).where(eq(mediaAssets.id, row.id));
  const driver = await resolveStorageDriver(driverDeps, driverNameOf(row));
  await driver.delete(row.objectKey).catch(() => undefined);
  if (row.thumbObjectKey) await driver.delete(row.thumbObjectKey).catch(() => undefined);
  if (row.thumbSmallObjectKey) await driver.delete(row.thumbSmallObjectKey).catch(() => undefined);
}

export type MediaContentVariant = "original" | "thumb" | "small";

export interface MediaContentStream {
  row: typeof mediaAssets.$inferSelect;
  /** MIME of the bytes actually streamed (image/webp for thumbnails). */
  mimeType: string;
  /** Quoted ETag, e.g. `"<sha256>"` or `"<sha256>-thumb-320"`. */
  etag: string;
  /** Total size of the object being served (from the row, not R2). */
  size: number;
  body: ReadableStream<Uint8Array>;
  /** The satisfied range, or null for a full 200 response. */
  range: { start: number; end: number } | null;
}

/**
 * Parse a single HTTP `Range` header against a known object size.
 * Returns null when there is no usable range (absent, malformed, or
 * multi-range — the caller serves the full object, per RFC 7233 the
 * server MAY ignore a range it cannot satisfy as a single range).
 * Suffix (`bytes=-500`) and open-ended (`bytes=500-`) forms are
 * supported; `end` is clamped to `size - 1`. An out-of-range start
 * (start >= size) is reported as `unsatisfiable` so the route can
 * answer 416 with `Content-Range: bytes *\/<size>`.
 */
export function parseHttpRange(
  header: string | null | undefined,
  size: number,
): { range: { start: number; end: number } | null; unsatisfiable: boolean } {
  if (!header) return { range: null, unsatisfiable: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { range: null, unsatisfiable: false };
  const startRaw = m[1] ?? "";
  const endRaw = m[2] ?? "";
  let start: number;
  let end: number;
  if (startRaw === "" && endRaw === "") return { range: null, unsatisfiable: false };
  if (startRaw === "") {
    // Suffix: the last N bytes.
    const n = Number(endRaw);
    if (!Number.isFinite(n) || n <= 0) return { range: null, unsatisfiable: false };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startRaw);
    if (!Number.isFinite(start) || start < 0) return { range: null, unsatisfiable: false };
    // RFC 7233: a first-byte-pos at or beyond the representation
    // length is unsatisfiable (416) — checked BEFORE the end
    // validation below, because an open-ended `bytes=<size>-` clamps
    // its end to size−1, which is < start and must NOT mask the 416.
    if (start >= size) return { range: null, unsatisfiable: true };
    end = endRaw === "" ? size - 1 : Math.min(size - 1, Number(endRaw));
    if (!Number.isFinite(end) || end < start) return { range: null, unsatisfiable: false };
  }
  return { range: { start, end }, unsatisfiable: false };
}

export interface MediaContentOptions {
  variant?: MediaContentVariant | undefined;
  /** Raw `Range` request header (parsed here — the service knows the size). */
  rangeHeader?: string | null | undefined;
}

/**
 * Resolve an asset to a STREAMED read (PLAN §34): the Worker never
 * buffers the object — `driver.getStream` passes a Range straight to
 * R2, so a video `preload="metadata"` request downloads only the
 * requested bytes. Sizes come from the row, so no `head()` call is
 * needed. The route turns the returned `range` into 206 +
 * `Content-Range`; a 416 is thrown as `RANGE_NOT_SATISFIABLE` with
 * the size in `details` so the route can set
 * `Content-Range: bytes *\/<size>`.
 */
export async function getMediaAssetContent(
  db: MediaDb,
  driverDeps: DriverDeps,
  id: string,
  opts: MediaContentOptions = {},
): Promise<MediaContentStream> {
  const row = await requireMediaAsset(db, id);
  const variant = opts.variant ?? "original";
  let objectKey: string | null;
  let size: number | null;
  let mimeType: string;
  let etag: string;
  if (variant === "thumb") {
    objectKey = row.thumbObjectKey;
    size = row.thumbByteSize;
    mimeType = "image/webp";
    etag = `"${row.checksumSha256}-thumb-320"`;
  } else if (variant === "small") {
    objectKey = row.thumbSmallObjectKey;
    size = row.thumbSmallByteSize;
    mimeType = "image/webp";
    etag = `"${row.checksumSha256}-thumb-64"`;
  } else {
    objectKey = row.objectKey;
    size = Number(row.byteSize);
    mimeType = row.mimeType;
    etag = `"${row.checksumSha256}"`;
  }
  if (objectKey === null || size === null) {
    throw new AppError("NOT_FOUND", "Thumbnail not available for this asset.", 404);
  }
  const { range, unsatisfiable } = parseHttpRange(opts.rangeHeader ?? null, size);
  if (unsatisfiable) {
    throw new AppError("RANGE_NOT_SATISFIABLE", "Requested range is not satisfiable.", 416, {
      size,
    });
  }
  const driver = await resolveStorageDriver(driverDeps, driverNameOf(row));
  const stream = await driver.getStream(objectKey, range ?? undefined);
  if (!stream) {
    throw new AppError("NOT_FOUND", "Media file not found in storage.", 404);
  }
  return { row, mimeType, etag, size, body: stream.body, range };
}

/** Distinct folders present in the library, sorted ("" = root is listed first when present). */
export async function listMediaFolders(db: MediaDb): Promise<string[]> {
  const rows = await db
    .selectDistinct({ folder: mediaAssets.folder })
    .from(mediaAssets)
    .orderBy(asc(mediaAssets.folder));
  return rows.map((r) => r.folder);
}
